// try-compile.mjs — run the wasm Crystal compiler under clang-wasm's runtime.
//
//   node try-compile.mjs
//
// Env:
//   CLANG_WASM   path to clang-wasm's toolchain.node.js   (default: sibling checkout)
//   CRYSTAL_WASM path to crystal.wasm                     (default: /root/bc-crystal/crystal.wasm)
//   CRYSTAL_SRC  path to the Crystal stdlib sources       (default: /root/bc-crystal/src)
//
// This is an integration harness, not the page yet: it answers "does the
// compiler we built actually read a filesystem and emit an object?" using
// clang-wasm's toolchain to provide the WASI filesystem.
import { readFile, readdir, stat } from 'node:fs/promises';
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
	// the command itself.
	args: ['build', '--cross-compile', '--target=wasm32-unknown-wasi', '-o', 'out.o.wasm', 'main.cr'],
	env: { CRYSTAL_PATH: '/src' },
	files,
});

console.log('exitCode:', command.exitCode);
if (command.stdout) console.log('--- stdout ---\n' + command.stdout);
if (command.stderr) console.log('--- stderr ---\n' + command.stderr);
const object = command.readFile('out.o.wasm');
console.log('out.o.wasm:', object ? `${object.length} bytes` : 'not produced');
