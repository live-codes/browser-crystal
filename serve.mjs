// Static file server for the proof of concept.
//
//   node serve.mjs        # http://localhost:8127
//
// It does not compile anything: the .wasm files were built by `npm run build`,
// and running this server is not part of the pipeline — it is here because
//
//   * ES modules and Web Workers do not load over file://, and
//   * .wasm has to be sent as `application/wasm`, or WebAssembly.compileStreaming
//     rejects the response. That is the only header that actually matters.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';

const repo = import.meta.dirname;
const pages = resolve(repo, 'public');

const MIME = {
	'.html': 'text/html; charset=utf-8',
	'.js': 'text/javascript; charset=utf-8',
	'.mjs': 'text/javascript; charset=utf-8',
	'.json': 'application/json; charset=utf-8',
	'.wasm': 'application/wasm',
	'.css': 'text/css; charset=utf-8',
	'.cr': 'text/plain; charset=utf-8',
	'.md': 'text/markdown; charset=utf-8',
	'.png': 'image/png',
};

const send = (res, status, type, body) => {
	res.writeHead(status, { 'content-type': type, 'cache-control': 'no-cache' });
	res.end(body);
};

const server = createServer(async (req, res) => {
	try {
		const requested = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
		const relative = requested === '/' ? 'index.html' : requested.replace(/^\//, '');

		// public/ is the site. A top-level markdown file is served as well, so
		// the page can link to the findings sitting next to it.
		const base = /^[^/]+\.md$/.test(relative) ? repo : pages;
		const target = resolve(join(base, normalize(relative)));

		// However the path was spelled, nothing outside the served directory is ours.
		if (!target.startsWith(base + sep)) {
			send(res, 403, 'text/plain; charset=utf-8', 'Forbidden');
			return;
		}

		if (!(await stat(target).catch(() => null))?.isFile()) {
			send(res, 404, 'text/plain; charset=utf-8', `Not found: /${relative}`);
			return;
		}

		send(res, 200, MIME[extname(target).toLowerCase()] ?? 'application/octet-stream', await readFile(target));
	} catch (error) {
		// An async handler that rejects takes the process down, turning one bad
		// request into a connection reset on every later one.
		if (res.headersSent) res.destroy();
		else send(res, 500, 'text/plain; charset=utf-8', `request failed: ${error}\n`);
	}
});

const port = Number(process.env.PORT || 8127);
server.listen(port, () => {
	console.log(`Crystal proof of concept on http://localhost:${port}/`);
	console.log('  the page and its Crystal modules, as built — nothing is compiled here');
});
