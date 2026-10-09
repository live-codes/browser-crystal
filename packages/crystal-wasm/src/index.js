// The entry every environment gets unless something more specific matches, so it
// has to work without a filesystem: `baseUrl` is required, because a browser
// cannot read a file that lives inside an npm package.
import { createApi } from './api.js';

// The page has `DecompressionStream`, which is why the payload can ship gzipped
// and no server needs content-encoding configured.
const inflate = async (bytes) =>
	new Uint8Array(
		await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer()
	);

const api = createApi({ packaged: null, inflate });

export const createCompiler = api.createCompiler;
