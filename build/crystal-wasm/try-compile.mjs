// try-compile.mjs — run the wasm Crystal compiler under clang-wasm's runtime.
//
//   node --stack-size=4000 try-compile.mjs
//
// The `--stack-size` is not optional: V8 gives a wasm instance a *native* stack
// of about 1 MiB by default, and the compiler's AST passes (CleanupTransformer
// in particular) recurse deeply enough with large-enough wasm frames to exceed
// it -- non-deterministically, since Crystal hashes are randomly seeded. The
// module's own `-z stack-size` (link.sh) governs the *other* stack, the linear
// one Crystal's allocas use; it does not help here. Failure looks like
// "RangeError: Maximum call stack size exceeded".
//
// Env:
//   CLANG_WASM   path to clang-wasm's toolchain.node.js   (default: sibling checkout)
//   CRYSTAL_WASM path to crystal.wasm                     (default: /root/bc-crystal/crystal.wasm)
//   CRYSTAL_SRC  path to the Crystal stdlib sources       (default: /root/bc-crystal/src)
//   OUT_OBJ      where to write the emitted object        (default: /root/bc-crystal/out.o.wasm)
//
// This is an integration harness, not the page yet: it answers "does the
// compiler we built actually read a filesystem and emit an object?" using
// clang-wasm's toolchain to provide the WASI filesystem.
import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const CW = process.env.CLANG_WASM ?? '/mnt/d/DevWork/live-codes/clang-wasm/packages/clang-wasm/src/toolchain.node.js';
const CRYSTAL_WASM = process.env.CRYSTAL_WASM ?? '/root/bc-crystal/crystal.wasm';
const CRYSTAL_SRC = process.env.CRYSTAL_SRC ?? '/root/bc-crystal/src';

const { createToolchain } = await import(pathToFileURL(CW).href);

// stat() rather than withFileTypes: the 9p mount does not report dirent types.
async function walk(dir, prefix = '') {
	const out = [];
	for (const entry of await readdir(dir)) {
		const full = join(dir, entry);
		const rel = prefix ? `${prefix}/${entry}` : entry;
		const info = await stat(full).catch(() => null);
		if (!info) continue;
		if (info.isDirectory()) out.push(...(await walk(full, rel)));
		else out.push({ path: rel, contents: await readFile(full) });
	}
	return out;
}

console.log('collecting stdlib …');
const stdlib = await walk(CRYSTAL_SRC);
console.log(`  ${stdlib.length} files`);

const files = [
	...stdlib.map((f) => ({ path: `src/${f.path}`, contents: f.contents })),
	{
		path: 'main.cr',
		contents: 'puts "hello from the wasm Crystal compiler"\n',
	},
];

console.log('creating toolchain (loads clang-wasm assets) …');
const toolchain = await createToolchain();

console.log('compiling crystal.wasm …');
const module = await WebAssembly.compile(await readFile(CRYSTAL_WASM));

console.log('running the compiler …');
const command = await toolchain.runCommand(module, {
	// Crystal's ARGV does not include the program name, so the first element is
	// the command itself. The flags mirror cross-compile.sh: `use_pcre2` avoids
	// the `pkg-config` shell-out in `regex/engine.cr` (WASI has no processes),
	// and the `without_*` flags drop the compiler-only tooling. wasm exception
	// handling is enabled by the compiler itself (no `--mattr` needed).
	args: [
		'build', '--cross-compile', '--target=wasm32-unknown-wasi',
		'-Di_know_what_im_doing', '-Dwithout_playground', '-Dwithout_docs',
		'-Dwithout_interpreter', '-Duse_pcre2',
		'-o', 'out.o.wasm', 'main.cr',
	],
	env: { CRYSTAL_PATH: '/src' },
	files,
});

console.log('exitCode:', command.exitCode);
if (command.stdout) console.log('--- stdout ---\n' + command.stdout);
if (command.stderr) console.log('--- stderr ---\n' + command.stderr);
const object = command.readFile('out.o.wasm');
console.log('out.o.wasm:', object ? `${object.length} bytes` : 'not produced');
if (object) {
	const OUT_OBJ = process.env.OUT_OBJ ?? '/root/bc-crystal/out.o.wasm';
	await writeFile(OUT_OBJ, object);
	console.log('wrote', OUT_OBJ);
}
