// A WASI preview 1 host, implementing only what a Crystal program actually asks
// for. The whole surface, measured across every sample in samples/ — see
// `npm test`, which prints it — is eight functions:
//
//   args_sizes_get  args_get  fd_fdstat_get  fd_fdstat_set_flags
//   fd_read  fd_write  proc_exit  random_get
//
// That is the entire contract between a Crystal wasm module and the page. There
// is no filesystem, no clocks and no sockets, because the samples need none.
//
// The module brings its own linear memory (defined and exported by wasm-ld, not
// imported and not shared), so nothing here needs cross-origin isolation.

const ESUCCESS = 0;
const EBADF = 8;

// wasi-fs filetype: a stdio stream is a character device.
const FILETYPE_CHARACTER_DEVICE = 2;

// Rights are not enforced by anything the samples do, so every stream is handed
// the full set rather than a hand-copied subset that could be subtly wrong.
const RIGHTS_ALL = 0xffffffffffffffffn;

const STDIN = 0;
const STDOUT = 1;
const STDERR = 2;

/** Thrown out of an import to unwind out of `_start` when the guest exits. */
class Exit {
	constructor(code) {
		this.code = code;
	}
}

/**
 * Runs a WASI command module.
 *
 * @param {Uint8Array | WebAssembly.Module} module
 * @param {object} [options]
 * @param {string} [options.stdin] everything the guest can read from fd 0
 * @param {string[]} [options.args]
 * @param {(text: string) => void} [options.onStdout] called as output is produced
 * @param {(text: string) => void} [options.onStderr]
 * @returns {Promise<{ exitCode: number, stdout: string, stderr: string }>}
 */
export async function run(module, options = {}) {
	const { stdin = '', args = ['main'], onStdout, onStderr } = options;

	const compiled = module instanceof WebAssembly.Module ? module : await WebAssembly.compile(module);

	let memory;

	const input = new TextEncoder().encode(stdin);
	let inputOffset = 0;

	// NUL-terminated, and sized by encoded bytes rather than UTF-16 length.
	const argv = args.map((arg) => new TextEncoder().encode(`${arg}\0`));

	const stdoutDecoder = new TextDecoder();
	const stderrDecoder = new TextDecoder();
	const streams = {
		[STDOUT]: { decoder: stdoutDecoder, sink: onStdout, text: '' },
		[STDERR]: { decoder: stderrDecoder, sink: onStderr, text: '' },
	};

	const write = (fd, chunk) => {
		const stream = streams[fd];
		if (!stream) return false;
		const text = stream.decoder.decode(chunk, { stream: true });
		stream.text += text;
		if (text) stream.sink?.(text);
		return true;
	};

	// Each import builds its views fresh: growing the linear memory detaches
	// every existing ArrayBuffer view of it.
	const wasi = {
		args_sizes_get(argcPtr, argvBufSizePtr) {
			const view = new DataView(memory.buffer);
			view.setUint32(argcPtr, argv.length, true);
			view.setUint32(argvBufSizePtr, argv.reduce((total, arg) => total + arg.length, 0), true);
			return ESUCCESS;
		},

		args_get(argvPtr, argvBufPtr) {
			const view = new DataView(memory.buffer);
			const bytes = new Uint8Array(memory.buffer);
			let cursor = argvBufPtr;
			argv.forEach((arg, index) => {
				view.setUint32(argvPtr + index * 4, cursor, true);
				bytes.set(arg, cursor);
				cursor += arg.length;
			});
			return ESUCCESS;
		},

		fd_fdstat_get(fd, statPtr) {
			if (fd !== STDIN && fd !== STDOUT && fd !== STDERR) return EBADF;
			const view = new DataView(memory.buffer);
			view.setUint8(statPtr, FILETYPE_CHARACTER_DEVICE);
			view.setUint16(statPtr + 2, 0, true);
			view.setBigUint64(statPtr + 8, RIGHTS_ALL, true);
			view.setBigUint64(statPtr + 16, RIGHTS_ALL, true);
			return ESUCCESS;
		},

		// stdio is already unbuffered here, so there is nothing to change.
		fd_fdstat_set_flags(fd) {
			return fd === STDIN || fd === STDOUT || fd === STDERR ? ESUCCESS : EBADF;
		},

		fd_read(fd, iovsPtr, iovsLen, nreadPtr) {
			if (fd !== STDIN) return EBADF;
			const view = new DataView(memory.buffer);
			const bytes = new Uint8Array(memory.buffer);
			let read = 0;
			for (let index = 0; index < iovsLen; index += 1) {
				const bufferPtr = view.getUint32(iovsPtr + index * 8, true);
				const length = view.getUint32(iovsPtr + index * 8 + 4, true);
				const take = Math.min(length, input.length - inputOffset);
				if (take <= 0) break;
				bytes.set(input.subarray(inputOffset, inputOffset + take), bufferPtr);
				inputOffset += take;
				read += take;
			}
			view.setUint32(nreadPtr, read, true);
			return ESUCCESS;
		},

		fd_write(fd, iovsPtr, iovsLen, nwrittenPtr) {
			if (fd !== STDOUT && fd !== STDERR) return EBADF;
			const view = new DataView(memory.buffer);
			const bytes = new Uint8Array(memory.buffer);
			let written = 0;
			for (let index = 0; index < iovsLen; index += 1) {
				const bufferPtr = view.getUint32(iovsPtr + index * 8, true);
				const length = view.getUint32(iovsPtr + index * 8 + 4, true);
				write(fd, bytes.subarray(bufferPtr, bufferPtr + length));
				written += length;
			}
			view.setUint32(nwrittenPtr, written, true);
			return ESUCCESS;
		},

		proc_exit(code) {
			throw new Exit(code);
		},

		random_get(bufferPtr, length) {
			crypto.getRandomValues(new Uint8Array(memory.buffer, bufferPtr, length));
			return ESUCCESS;
		},
	};

	// Fail with something readable rather than "function import requires a
	// callable" when a module wants a host call this file does not provide.
	const missing = WebAssembly.Module.imports(compiled)
		.filter((imported) => imported.module === 'wasi_snapshot_preview1')
		.map((imported) => imported.name)
		.filter((name) => !(name in wasi));
	if (missing.length > 0) {
		throw new Error(`this module needs WASI calls the host does not implement: ${missing.join(', ')}`);
	}

	const imports = { wasi_snapshot_preview1: wasi };
	const instance = await WebAssembly.instantiate(compiled, imports);
	memory = instance.exports.memory;

	let exitCode = 0;
	try {
		instance.exports._start();
	} catch (error) {
		if (error instanceof Exit) exitCode = error.code;
		else throw error;
	}

	for (const id of [STDOUT, STDERR]) {
		const stream = streams[id];
		const rest = stream.decoder.decode();
		if (rest) {
			stream.text += rest;
			stream.sink?.(rest);
		}
	}

	return { exitCode, stdout: streams[STDOUT].text, stderr: streams[STDERR].text };
}
