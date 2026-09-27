// Runs every built sample under Node's WASI implementation.
//
//   node test/run-samples.mjs
//
// This is the same module the browser instantiates, driven by a WASI host that
// is not the one in public/runner.js — so it checks the artifacts themselves,
// not the page. It also prints the union of WASI imports across all samples,
// which is the surface the browser host has to implement.
import { closeSync, mkdtempSync, openSync, readFileSync, readSync, readdirSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WASI } from 'node:wasi';

const dir = join(import.meta.dirname, '..', 'public', 'crystal');

// The one sample that reads stdin, and what to feed it.
const STDIN = { '05-stdin': '5\n10\n20\n30\n40\n50\n' };

const files = readdirSync(dir).filter((name) => name.endsWith('.wasm')).sort();
if (files.length === 0) {
	console.error(`no .wasm files in ${dir} — run \`npm run build:samples\` first`);
	process.exit(1);
}

const imports = new Set();
let failures = 0;

for (const name of files) {
	const bytes = readFileSync(join(dir, name));
	const module = new WebAssembly.Module(bytes);
	for (const imported of WebAssembly.Module.imports(module)) {
		imports.add(`${imported.module}.${imported.name}`);
	}

	const scratch = mkdtempSync(join(tmpdir(), 'crystal-'));
	const stdinPath = join(scratch, 'stdin');
	const stdoutPath = join(scratch, 'stdout');
	writeSync(openSync(stdinPath, 'w'), STDIN[name.replace(/\.wasm$/, '')] ?? '');
	const stdin = openSync(stdinPath, 'r');
	const stdout = openSync(stdoutPath, 'w');

	let exitCode;
	const wasi = new WASI({ version: 'preview1', args: [name], env: {}, stdin, stdout });
	try {
		const instance = new WebAssembly.Instance(module, wasi.getImportObject());
		exitCode = wasi.start(instance);
	} catch (error) {
		exitCode = `threw: ${error.message}`;
		failures += 1;
	} finally {
		closeSync(stdin);
		closeSync(stdout);
	}

	const output = readFileSync(stdoutPath, 'utf8').replace(/\n$/, '');
	console.log(`\n=========== ${name} (exit ${exitCode}) ===========`);
	console.log(output || '(no output)');
}

console.log(`\n\nWASI imports across all samples (${imports.size}):`);
for (const name of [...imports].sort()) console.log(`  ${name}`);

const usedImports = new Set([...imports].map((name) => name.split('.').slice(1).join('.')));
console.log(`\nDistinct functions/globals to implement: ${[...usedImports].sort().join(', ')}`);

// Setting the code rather than calling process.exit(): exiting outright while
// libuv still has handles open aborts the process on Windows (an assertion in
// uv_async), which would report a failure that did not happen.
process.exitCode = failures === 0 ? 0 : 1;
