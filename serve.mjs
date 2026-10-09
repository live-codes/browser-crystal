// Static file server for the demo page.
//
//   node serve.mjs        # http://localhost:8127/
//
// It serves two trees: the page (public/) and the language package the page uses
// (packages/, which includes the payload it loads). It compiles nothing — the page
// compiles Crystal in the tab. The server is here because
//
//   * ES modules and Web Workers do not load over file://, and
//   * .wasm has to be sent as `application/wasm`, or WebAssembly.compileStreaming
//     rejects the response. That is the only header that actually matters.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';

const repo = import.meta.dirname;

// Longest prefix wins, so /packages/… is not swallowed by the site's /.
const routes = [
	{ prefix: '/packages/', root: resolve(repo, 'packages') },
	{ prefix: '/', root: resolve(repo, 'public') }
];

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
	'.gz': 'application/gzip'
};

const send = (res, status, type, body) => {
	res.writeHead(status, { 'content-type': type, 'cache-control': 'no-cache' });
	res.end(body);
};

const server = createServer(async (req, res) => {
	try {
		const requested = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
		const route = routes
			.filter(({ prefix }) => requested === prefix || requested.startsWith(prefix))
			.sort((a, b) => b.prefix.length - a.prefix.length)[0];

		// A top-level markdown file is served as well, so the page can link to the
		// findings sitting next to it.
		const topLevelMarkdown = /^\/[^/]+\.md$/.test(requested);
		const base = topLevelMarkdown ? repo : route.root;
		const rest = requested === '/' ? 'index.html' : requested.slice(route.prefix.length);
		const target = resolve(join(base, normalize(rest)));

		// However the path was spelled, nothing outside the served directory is ours.
		if (!target.startsWith(base + sep)) {
			send(res, 403, 'text/plain; charset=utf-8', 'Forbidden');
			return;
		}

		if (!(await stat(target).catch(() => null))?.isFile()) {
			send(res, 404, 'text/plain; charset=utf-8', `Not found: ${requested}`);
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
	console.log(`Crystal in the browser on http://localhost:${port}/`);
	console.log('  the page compiles, links and runs Crystal itself; this server only ships files');
});
