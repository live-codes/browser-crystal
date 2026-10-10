#!/usr/bin/env node
// Build the global script a CDN serves for a page that cannot import ES modules:
// dist/crystal-wasm.global.js.
//
//   npm run build:iife
//
// LiveCodes runs a language's compiler in a worker it assembles from a blob, so the compiler
// has to arrive through `importScripts` — a classic script that defines a global, not a
// module. `globalName: 'crystalWasm'` gives exactly that, and the function behind it is the
// same one the ESM entry exports: nothing is copied or reimplemented for the script build.
//
// The compiler's assets are not in this file. The caller passes the `baseUrl` they are served
// from — the whole CDN-hosted package — which is what makes one 30 KB script enough.
import { build } from 'esbuild';
import { mkdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const outfile = `${root}dist/crystal-wasm.global.js`;

const { version } = JSON.parse(await readFile(`${root}package.json`, 'utf8'));

await mkdir(`${root}dist`, { recursive: true });

const result = await build({
	entryPoints: [`${root}src/index.js`],
	outfile,
	bundle: true,
	format: 'iife',
	globalName: 'crystalWasm',
	platform: 'browser',
	target: ['es2022'],
	minify: true,
	sourcemap: true,
	legalComments: 'none',
	banner: {
		js: `/*! @live-codes/crystal-wasm ${version} — the Crystal compiler in the browser, as a global script. MIT. */`
	},
	metafile: true
});

const entries = Object.entries(result.metafile.outputs);
const [script, bytes] = entries.find(([path]) => path.endsWith('.js')) ?? entries[0];
console.log(`${script.split(/[/\\]/).slice(-2).join('/')}: ${(bytes.bytes / 1024).toFixed(1)} KB`);
