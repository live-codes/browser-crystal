// crystal-demo.js — compile and run Crystal entirely in the page.
//
// Three WebAssembly modules run here and nothing else does any work:
//
//   1. compiler.wasm  the Crystal compiler (built by build/crystal-wasm/),
//                     given the stdlib as a filesystem and the user's source,
//                     emitting a wasm *object*;
//   2. lld.wasm       clang-wasm's lld, run as `wasm-ld`, linking that object
//                     against the sysroot libraries into a runnable module;
//   3. that module    the user's program, run for its output.
//
// The WASI host is the vendored `browser_wasi_shim` (public/vendor/), which
// supplies the in-memory filesystem the compiler needs. This module has no
// imports beyond that, so it runs unchanged in a browser worker and in Node —
// `test/demo.mjs` drives it in Node, which is how it is checked without a
// browser.
import {
	ConsoleStdout,
	Directory,
	File,
	OpenFile,
	PreopenDirectory,
	WASI,
	wasi as wasiDefs
} from './vendor/browser_wasi_shim/index.js';

const ENCODER = new TextEncoder();

// browser_wasi_shim grows a file by allocating exactly what the write needs and
// copying the old bytes in, on *every* write that lands past the end:
//
//   if (this.file_pos + len > this.file.size) {
//     const old = this.file.data;
//     this.file.data = new Uint8Array(Number(this.file_pos + len));
//     this.file.data.set(old);
//   }
//
// LLVM writes a wasm object in ~110k small positioned writes, so that is
// quadratic -- measured, 7.4 s of a 10.7 s compile was this one copy, 82% of the
// whole compile. Growing geometrically instead makes it linear: the same object
// now takes 1.4 s.
//
// The price is that a file's buffer is larger than its contents while it is being
// written, and the shim takes `data.byteLength` to *be* the file size. So the
// written length is tracked separately and files are trimmed back to it before
// anything reads them (see trimWrittenFiles) -- a reader that reads to EOF would
// otherwise see the spare capacity as trailing zeros.
//
// The vendored shim is left pristine; this is the one behaviour worth patching,
// so it is patched here where the reason is visible.
const writtenLength = new WeakMap();

// A file's *contents*, as opposed to the buffer they are held in.
const logicalLength = (file) => writtenLength.get(file.data) ?? file.data.byteLength;

function patchFileGrowth() {
	const write = OpenFile.prototype.fd_write;
	const pwrite = OpenFile.prototype.fd_pwrite;
	const seek = OpenFile.prototype.fd_seek;

	const grow = (file, needed) => {
		// Against the buffer's capacity -- not `file.size`, which is the contents.
		if (needed <= file.data.byteLength) return;
		const size = Math.max(needed, file.data.byteLength * 2, 1 << 16);
		const grown = new Uint8Array(size);
		grown.set(file.data);
		// The contents' length has to travel with the buffer, or the next write
		// would take this buffer's capacity to be the file's length and ratchet the
		// tracked length up to it.
		const carried = logicalLength(file);
		file.data = grown;
		writtenLength.set(grown, carried);
	};

	const record = (file, end) => {
		writtenLength.set(file.data, Math.max(logicalLength(file), end));
	};

	OpenFile.prototype.fd_write = function (data) {
		if (this.file.readonly) return write.call(this, data);
		const end = Number(this.file_pos + BigInt(data.byteLength));
		grow(this.file, end);
		this.file.data.set(data, Number(this.file_pos));
		this.file_pos += BigInt(data.byteLength);
		record(this.file, end);
		return { ret: 0, nwritten: data.byteLength };
	};

	OpenFile.prototype.fd_pwrite = function (data, offset) {
		if (this.file.readonly) return pwrite.call(this, data, offset);
		const end = Number(offset + BigInt(data.byteLength));
		grow(this.file, end);
		this.file.data.set(data, Number(offset));
		record(this.file, end);
		return { ret: 0, nwritten: data.byteLength };
	};

	// The shim seeks to `data.byteLength` for WHENCE_END, which is now the buffer
	// and not the file: seeking to the end would leave a gap of zeros.
	OpenFile.prototype.fd_seek = function (offset, whence) {
		if (whence !== wasiDefs.WHENCE_END) return seek.call(this, offset, whence);
		const target = BigInt(logicalLength(this.file)) + offset;
		if (target < 0n) return { ret: wasiDefs.ERRNO_INVAL, offset: 0n };
		this.file_pos = target;
		return { ret: 0, offset: this.file_pos };
	};

	// ...and `File#size` (what `stat` reports) has to be the contents too.
	Object.defineProperty(File.prototype, 'size', {
		get() {
			return BigInt(logicalLength(this));
		}
	});
}

function trimWrittenFiles(dir) {
	for (const entry of dir.contents.values()) {
		if (entry instanceof Directory) trimWrittenFiles(entry);
		else if (entry instanceof File) {
			const length = writtenLength.get(entry.data);
			if (length !== undefined && length < entry.data.byteLength) entry.data = entry.data.slice(0, length);
		}
	}
}

patchFileGrowth();

// The compiler's own flags, mirroring build/crystal-wasm/cross-compile.sh: the
// `without_*` flags drop compiler-only tooling and `use_pcre2` avoids a
// `pkg-config` shell-out (WASI has no processes). wasm exception handling is
// enabled by the compiler itself for a wasm target.
//
// argv[0] is the program name: Crystal's ARGV is *everything after it*, so the
// leading "crystal" is what makes "build" the command rather than the first
// flag. (clang-wasm's host inserts a program name for you; browser_wasi_shim,
// which this uses, does not.)
export const COMPILER_ARGS = [
	'crystal', 'build', '--cross-compile', '--target=wasm32-unknown-wasi',
	'-Di_know_what_im_doing', '-Dwithout_playground', '-Dwithout_docs',
	'-Dwithout_interpreter', '-Duse_pcre2',
	'-o', 'out.o.wasm', 'main.cr'
];

// The same link line clang's driver uses under `-fwasm-exceptions`, with the
// libraries mounted at `lib/` and `lib/eh/`. `lib/eh` comes first so `-lc++abi`
// and `-lunwind` resolve to the wasm-EH variants.
//
// `-lc++` is deliberately absent: the compiler's own cross-compile echo is
// `wasm-ld out.o.wasm -o out.o -lc`, and a Crystal program has no C++ in it --
// what it does need from the C++ runtime is the wasm EH personality and
// `_Unwind_*`, which are libc++abi and libunwind. Dropping it is 2.7 MB of the
// payload. If a program ever does need it, the linker says so by name.
//
// lld dispatches on argv[0], and this is a *generic* lld: without the leading
// "wasm-ld" it refuses to do anything.
export const LINKER_ARGS = [
	'wasm-ld', '-m', 'wasm32',
	'-Llib/eh', '-Llib',
	'out.o.wasm',
	'-lpcre2-8', '-lc++abi', '-lunwind',
	'-lwasi-emulated-signal', '-lwasi-emulated-mman',
	'-lwasi-emulated-getpid', '-lwasi-emulated-process-clocks',
	'-lc', 'lib/libclang_rt.builtins.a',
	'-o', 'out.wasm'
];

const asFile = (data) =>
	new File(typeof data === 'string' ? ENCODER.encode(data) : data);

// browser_wasi_shim's Directory is a Map of name -> File|Directory. Build the
// tree from flat paths; the returned Directory is what the preopen wraps, and
// its `contents` Map is shared, so files the guest writes show up in it too.
function buildTree(entries) {
	const root = new Directory(new Map());
	for (const [path, data] of entries) {
		const parts = path.split('/').filter(Boolean);
		const name = parts.pop();
		let dir = root;
		for (const part of parts) {
			let child = dir.contents.get(part);
			if (!(child instanceof Directory)) {
				child = new Directory(new Map());
				dir.contents.set(part, child);
			}
			dir = child;
		}
		dir.contents.set(name, asFile(data));
	}
	return root;
}

// A stdout/stderr that both streams text out as it arrives and keeps it.
function textSink(onText) {
	const decoder = new TextDecoder();
	let text = '';
	const fd = new ConsoleStdout((chunk) => {
		const decoded = decoder.decode(chunk, { stream: true });
		if (decoded) {
			text += decoded;
			onText?.(decoded);
		}
	});
	return {
		fd,
		flush() {
			const rest = decoder.decode();
			if (rest) {
				text += rest;
				onText?.(rest);
			}
		},
		get text() {
			return text;
		}
	};
}

async function runCommand(moduleOrBytes, { args, env = [], entries = [], onStdout, onStderr, root: given, stage }) {
	const root = given ?? buildTree(entries);
	// The stage is handed back with each chunk so the caller can show the
	// compiler's and linker's chatter differently from the program's output.
	const stdout = textSink((text) => onStdout?.(text, stage));
	const stderr = textSink((text) => onStderr?.(text, stage));

	// stdin is an empty file: the compiler and the linker never read it, and a
	// program that calls gets reads EOF, which is the honest answer here.
	const fds = [
		new OpenFile(new File(new Uint8Array())),
		stdout.fd,
		stderr.fd,
		new PreopenDirectory('/', root.contents)
	];

	// `debug: false` is not the default: the shim enables its logging when the
	// option is undefined, which would put "wasi:" lines in the output.
	const wasi = new WASI(args, env, fds, { debug: false });
	const module =
		moduleOrBytes instanceof WebAssembly.Module
			? moduleOrBytes
			: await WebAssembly.compile(moduleOrBytes);
	const instance = await WebAssembly.instantiate(module, {
		wasi_snapshot_preview1: wasi.wasiImport
	});

	const exitCode = wasi.start(instance);
	stdout.flush();
	stderr.flush();

	// A file written above is still over-allocated; make its length exact before
	// anything can read it (including the next stage, which runs in another call).
	trimWrittenFiles(root);

	return { exitCode, stdout: stdout.text, stderr: stderr.text, root };
}

/**
 * Compile *source* with the wasm compiler, link the object it emits, and run it.
 *
 * @param {object} options
 * @param {string} options.source  the Crystal program
 * @param {object} options.assets  `{ compiler, lld, stdlib, libs }` — the compiler
 *   and lld as bytes or compiled `WebAssembly.Module`, `stdlib` as `{ path: text }`
 *   and `libs` as `{ path: Uint8Array }` (paths already include `lib/…`).
 * @param {(stage: string) => void} [options.onStage] `compiling` | `linking` | `running`
 * @param {(text: string) => void} [options.onStdout]
 * @param {(text: string) => void} [options.onStderr]
 * @returns {Promise<{ wasm: Uint8Array, stdout: string, stderr: string, phases: object }>}
 *   Throws with `{ stage }` set if a stage fails.
 */
export async function compileAndRun({ source, assets, onStage, onStdout, onStderr }) {
	const { compiler, lld, stdlib, libs } = assets;
	const phases = {};

	const at = (stage) => {
		onStage?.(stage);
		return performance.now();
	};

	// 1. compile -----------------------------------------------------------
	let started = at('compiling');
	const compilerEntries = [['main.cr', source]];
	for (const [path, text] of Object.entries(stdlib)) {
		compilerEntries.push([`src/${path}`, text]);
	}
	const compiled = await runCommand(compiler, {
		args: COMPILER_ARGS,
		env: ['CRYSTAL_PATH=/src'],
		entries: compilerEntries,
		onStdout,
		onStderr,
		stage: 'compiling'
	});
	phases.compiling = performance.now() - started;

	const object = compiled.root.contents.get('out.o.wasm')?.data;
	if (!object) {
		const error = new Error('the compiler did not produce out.o.wasm');
		error.stage = 'compiling';
		error.diagnostics = compiled.stderr || compiled.stdout;
		throw error;
	}

	// 2. link --------------------------------------------------------------
	started = at('linking');
	const linkerEntries = [['out.o.wasm', object]];
	for (const [path, bytes] of Object.entries(libs)) {
		linkerEntries.push([path, bytes]);
	}
	const linked = await runCommand(lld, {
		args: LINKER_ARGS,
		entries: linkerEntries,
		onStdout,
		onStderr,
		stage: 'linking'
	});
	phases.linking = performance.now() - started;

	const wasm = linked.root.contents.get('out.wasm')?.data;
	if (!wasm) {
		const error = new Error('the linker did not produce out.wasm');
		error.stage = 'linking';
		error.diagnostics = linked.stderr || linked.stdout;
		throw error;
	}

	// 3. run ---------------------------------------------------------------
	started = at('running');
	const program = await runCommand(await WebAssembly.compile(wasm), {
		args: ['program'],
		entries: [],
		onStdout,
		onStderr,
		stage: 'running'
	});
	phases.running = performance.now() - started;

	return { wasm, stdout: program.stdout, stderr: program.stderr, exitCode: program.exitCode, phases };
}
