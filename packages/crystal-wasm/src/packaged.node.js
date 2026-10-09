// The assets that ship inside this package, on disk.
//
// Only reachable through the `node` condition: a browser cannot read a file inside
// an npm package, so there it has to be `baseUrl` and a copy served somewhere the
// page can fetch (see bin/copy-assets.mjs).
import { readFile } from 'node:fs/promises';

const root = new URL('../assets/crystal/', import.meta.url);

export const packagedAssets = {
	root,
	/** @param {string} name - a name from `ASSET_RECEIPTS`, e.g. `lib/libc.a.gz` */
	async readFile(name) {
		return new Uint8Array(await readFile(new URL(name, root)));
	}
};
