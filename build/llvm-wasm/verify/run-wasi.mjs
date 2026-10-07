// run-wasi.mjs — run a WASI preview 1 command module under Node's WASI.
//
//   node run-wasi.mjs <module.wasm> [args...]
//
// Mirrors what test/run-samples.mjs does for the sample modules, kept separate
// because this one is only about smoke-testing the wasm libLLVM build.
import { readFile } from 'node:fs/promises';
import { WASI } from 'node:wasi';

const [, , modulePath, ...args] = process.argv;

const wasi = new WASI({
	version: 'preview1',
	args: [modulePath, ...args],
	env: {},
	returnOnExit: true,
});

const module = await WebAssembly.compile(await readFile(modulePath));
const instance = await WebAssembly.instantiate(module, wasi.getImportObject());

const code = wasi.start(instance);
process.exit(code ?? 0);
