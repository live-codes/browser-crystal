// Node, where the assets that ship in this package can be read off disk, so
// `baseUrl` becomes optional and `createCompiler()` is enough on its own.
import { gunzipSync } from 'node:zlib';

import { createApi } from './api.js';
import { packagedAssets } from './packaged.node.js';

const inflate = async (bytes) => new Uint8Array(gunzipSync(bytes));

const api = createApi({ packaged: packagedAssets, inflate });

export const createCompiler = api.createCompiler;
