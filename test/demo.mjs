// test/demo.mjs — drive public/crystal-demo.js in Node.
//
//   npm run test:demo
//
// The demo's core has no browser-only API, so the whole compile → link → run
// chain can be checked here, against the same assets the page fetches (gzipped,
// as the page gets them). What the browser adds is only asset loading and the
// UI; keeping this fast is what makes the page's implementation cheap to trust.
//
// `--experimental-wasm-exnref` is passed by the npm script: the optimized
// compiler emits the wasm-EH `exnref` value type, which current Chrome has on by
// default and older Node does not.
import { readFile, readdir } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { compileAndRun } from '../public/crystal-demo.js';

const DIR = new URL('../public/crystal-demo/', import.meta.url);
const read = (path) => readFile(new URL(path, DIR));
const readGzip = async (path) => new Uint8Array(gunzipSync(await read(path)));

async function walk(prefix) {
	const out = [];
	for (const entry of await readdir(new URL(prefix, DIR), { withFileTypes: true })) {
		const path = `${prefix}${entry.name}`;
		if (entry.isDirectory()) out.push(...(await walk(`${path}/`)));
		else out.push(path);
	}
	return out;
}

const PROGRAM = `begin
  raise "boom"
rescue ex : Exception
  puts "caught: #{ex.message}"
end
puts "done"
`;

console.log('loading assets …');
const [compiler, lld, stdlibGzip] = await Promise.all([
	readGzip('compiler.wasm.gz'), readGzip('lld.wasm.gz'), readGzip('stdlib.json.gz')
]);
const stdlib = JSON.parse(new TextDecoder().decode(stdlibGzip));
const libs = {};
for (const path of await walk('lib/')) libs[path.replace(/\.gz$/, '')] = await readGzip(path);
console.log(`  stdlib ${Object.keys(stdlib).length} files, ${Object.keys(libs).length} libraries`);

console.log('compiling the compiler …');
const assets = {
	compiler: await WebAssembly.compile(compiler),
	lld: await WebAssembly.compile(lld),
	stdlib,
	libs
};

let last = '';
const result = await compileAndRun({
	source: PROGRAM,
	assets,
	onStage: (stage) => {
		if (stage !== last) {
			last = stage;
			console.log(`  ${stage} …`);
		}
	},
	onStdout: (text) => process.stdout.write(text),
	onStderr: (text) => process.stderr.write(text)
});

console.log('exitCode:', result.exitCode);
console.log(
	'phases:',
	Object.fromEntries(Object.entries(result.phases).map(([k, v]) => [k, `${v.toFixed(0)} ms`]))
);
const expected = 'caught: boom\ndone\n';
if (result.stdout === expected && result.exitCode === 0) {
	console.log('OK');
} else {
	console.error(`FAILED: stdout was ${JSON.stringify(result.stdout)}`);
	process.exit(1);
}
