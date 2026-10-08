// test/demo.mjs — drive public/crystal-demo.js in Node.
//
//   node test/demo.mjs
//
// The demo's core has no browser-only API, so the whole compile → link → run
// chain can be checked here, against the same assets the page fetches. What the
// browser adds is only asset loading and the UI; keeping this fast is what makes
// the page's implementation cheap to trust.
import { readFile, readdir } from 'node:fs/promises';
import { compileAndRun } from '../public/crystal-demo.js';

const DIR = new URL('../public/crystal-demo/', import.meta.url);
const read = (path) => readFile(new URL(path, DIR));

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
const [compiler, lld, stdlibJSON] = await Promise.all([
	read('compiler.wasm'), read('lld.wasm'), read('stdlib.json')
]);
const stdlib = JSON.parse(stdlibJSON.toString('utf8'));
const libs = {};
for (const path of await walk('lib/')) libs[path] = await read(path);
console.log(`  stdlib ${Object.keys(stdlib).length} files, ${Object.keys(libs).length} libraries`);

const assets = { compiler, lld, stdlib, libs };

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
console.log('phases:', Object.fromEntries(Object.entries(result.phases).map(([k, v]) => [k, `${v.toFixed(0)} ms`])));
const expected = 'caught: boom\ndone\n';
if (result.stdout === expected && result.exitCode === 0) {
	console.log('OK');
} else {
	console.error(`FAILED: stdout was ${JSON.stringify(result.stdout)}`);
	process.exit(1);
}
