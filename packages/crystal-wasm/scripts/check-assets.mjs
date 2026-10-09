#!/usr/bin/env node
// `prepack`: refuse to publish a package whose assets are missing or have changed
// under the receipts.
//
// The assets are build outputs and are not committed, so this is what stands
// between `npm publish` and a tarball that cannot compile anything. It checks
// existence, length and digest — the same check the loader makes on every read,
// made once instead of at every user's first run.
import { readFile } from 'node:fs/promises';

import { ASSET_RECEIPTS } from '../src/asset-receipts.js';
import { verifyReceipt } from '../src/assets.js';

const root = new URL('../assets/crystal/', import.meta.url);
const names = Object.keys(ASSET_RECEIPTS);

const problems = [];
let total = 0;
for (const name of names) {
	try {
		const bytes = new Uint8Array(await readFile(new URL(name, root)));
		await verifyReceipt(name, bytes);
		total += bytes.byteLength;
	} catch (error) {
		problems.push(`${name}: ${error.message}`);
	}
}

if (problems.length) {
	console.error(`The assets in ${root.pathname} are not the ones the receipts pin:`);
	for (const problem of problems) console.error(`  ${problem}`);
	console.error('\nBuild them first: bash packages/crystal-wasm/build-assets.sh (Linux or WSL).');
	process.exit(1);
}

console.log(`assets OK: ${names.length} files, ${(total / 1e6).toFixed(1)} MB gzipped`);
