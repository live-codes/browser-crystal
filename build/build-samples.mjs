// Builds every samples/*.cr into public/crystal/*.wasm, inside Docker.
//
//   node build/build-samples.mjs
//
// Docker is the only requirement — Crystal, wasm-ld and the WASI sysroot all
// live in the image described by build/Dockerfile. This is a build-time step,
// not a server: the page that consumes the output never talks to anything.
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const image = 'crystal-wasm-toolchain:1.17';
// Docker Desktop takes Windows paths, but the separator has to be the forward
// slash it expects for a bind mount.
const mount = `${root.replaceAll('\\', '/')}:/project`;

const run = (args, options = {}) => {
	const result = spawnSync('docker', args, { stdio: 'inherit', ...options });
	if (result.error) {
		console.error(`could not run docker: ${result.error.message}`);
		process.exit(1);
	}
	if (result.status !== 0) process.exit(result.status ?? 1);
};

// Always build: the layers are cached, so this is a no-op unless the Dockerfile
// changed — and a stale toolchain image is a confusing failure.
console.log(`building ${image} (Crystal 1.17.0 + wasi-sdk 22 + PCRE2)…`);
run(['build', '-f', 'build/Dockerfile', '-t', image, 'build']);

run([
	'run', '--rm',
	'--user', 'root',
	'-v', mount,
	'-w', '/project',
	...Object.entries(process.env)
		.filter(([key]) => key === 'CRYSTAL_FLAGS')
		.flatMap(([key, value]) => ['-e', `${key}=${value}`]),
	image,
	'sh', 'build/build-samples.sh',
]);

// Read by public/index.html. The sources are copied in because the page cannot
// read samples/ — it is served from public/ — and because the point of the page
// is to show what was compiled, not to compile anything itself.
const TITLES = {
	'01-hello': 'Hello, world',
	'02-collections': 'Arrays, hashes and blocks',
	'03-types': 'Classes, structs and modules',
	'04-errors': 'Errors without exceptions',
	'05-stdin': 'Reading stdin',
	'06-regex': 'Regular expressions',
};

const samples = readdirSync(join(root, 'samples'))
	.filter((file) => file.endsWith('.cr'))
	.sort()
	.map((file) => {
		const id = file.replace(/\.cr$/, '');
		return {
			id,
			title: TITLES[id] ?? id.replace(/^\d+-/, '').replaceAll('-', ' '),
			wasm: `${id}.wasm`,
			source: readFileSync(join(root, 'samples', file), 'utf8'),
		};
	});

writeFileSync(join(root, 'public', 'crystal', 'samples.json'), `${JSON.stringify(samples, null, 2)}\n`);
console.log(`samples.json: ${samples.length} samples`);

