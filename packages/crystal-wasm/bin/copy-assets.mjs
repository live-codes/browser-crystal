#!/usr/bin/env node
// Copies the compiler assets that ship inside this package into a directory you serve.
//
// This is the browser story: a page cannot read a file inside node_modules, so the
// assets have to be published by whatever serves the page. One command drops a
// complete, self-describing copy into your public directory; point `baseUrl` at it
// and nothing else has to be hosted.
import { cp, mkdir, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ASSET_RECEIPTS } from '../src/asset-receipts.js';

const ASSETS = fileURLToPath(new URL('../assets/crystal/', import.meta.url));

const USAGE = `Copy the compiler assets that ship with this package into a directory you serve.

  crystal-wasm-copy-assets [directory]

  directory      where to write them (default: ./crystal)

  --print-path   print the packaged assets directory and exit
  --help         print this
`;

const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
	console.log(USAGE);
	process.exit(0);
}
if (args.includes('--print-path')) {
	console.log(ASSETS);
	process.exit(0);
}

const target = resolve(args.find((arg) => !arg.startsWith('-')) ?? 'crystal');

// The names are relative paths, so the copy keeps the payload's shape (`lib/eh/…`),
// which is the shape `baseUrl` has to serve.
for (const name of Object.keys(ASSET_RECEIPTS)) {
	const destination = resolve(target, name);
	// The names are this package's own, but a path is a path: nothing may be written
	// outside the directory the caller named.
	const inside = relative(target, destination);
	if (inside.startsWith('..') || isAbsolute(inside)) {
		throw new Error(`Refusing to write outside ${target}: ${name}`);
	}
	await mkdir(resolve(destination, '..'), { recursive: true });
	await rm(destination, { force: true });
	await cp(resolve(ASSETS, name), destination, { force: true });
}

// The copy carries the receipts for its own bytes, which are the ones the package
// verifies on every read.
await writeFile(resolve(target, 'asset-receipts.json'), `${JSON.stringify(ASSET_RECEIPTS, null, 2)}\n`);

console.log(`Compiler assets copied to ${target}`);
console.log('Serve that directory and pass its URL as baseUrl, for example:');
console.log("  await createCompiler({ baseUrl: new URL('/crystal/', location.href) });");
