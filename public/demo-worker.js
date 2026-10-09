// demo-worker.js — the page's off-thread half.
//
// The compiler is a synchronous `_start` that can run for seconds and cannot be
// interrupted from the inside, so it runs here: a runaway compile blocks this
// worker, and the page can throw it away with `terminate()`.
//
// Assets are fetched and compiled once, then reused for every run — compiling a
// 35 MB wasm module is the slowest thing that happens, and it should not happen
// twice.
//
// Everything arrives gzipped and is inflated here (`DecompressionStream`), so the
// server needs no content-encoding configuration and any static host will do.
// That is what makes the payload 23 MB instead of 68 MB.
import { compileAndRun } from './crystal-demo.js';

const LIBRARIES = [
	'lib/libc.a',
	'lib/libpcre2-8.a',
	'lib/libclang_rt.builtins.a',
	'lib/eh/libc++abi.a',
	'lib/eh/libunwind.a',
	'lib/libwasi-emulated-signal.a',
	'lib/libwasi-emulated-mman.a',
	'lib/libwasi-emulated-getpid.a',
	'lib/libwasi-emulated-process-clocks.a'
];

const url = (path) => new URL(`./crystal-demo/${path}`, self.location.href).href;

async function fetchGzip(path) {
	const response = await fetch(url(path));
	if (!response.ok) {
		throw new Error(
			`could not fetch crystal-demo/${path} (${response.status}). ` +
				'Run build/crystal-wasm/demo-assets.sh to build the demo assets.'
		);
	}
	if (typeof DecompressionStream !== 'function') {
		throw new Error('this browser has no DecompressionStream, which the demo needs to inflate its assets');
	}
	const inflated = response.body.pipeThrough(new DecompressionStream('gzip'));
	return new Uint8Array(await new Response(inflated).arrayBuffer());
}

let assets = null;

async function loadAssets(phase) {
	if (assets) return assets;

	phase('loading the compiler (12 MB)');
	const compiler = await WebAssembly.compile(await fetchGzip('compiler.wasm.gz'));

	phase('loading the linker (8 MB)');
	const lld = await WebAssembly.compile(await fetchGzip('lld.wasm.gz'));

	phase('loading the standard library');
	const stdlib = JSON.parse(new TextDecoder().decode(await fetchGzip('stdlib.json.gz')));

	phase('loading the sysroot');
	const libs = {};
	for (const path of LIBRARIES) libs[path] = await fetchGzip(`${path}.gz`);

	assets = { compiler, lld, stdlib, libs };
	return assets;
}

self.addEventListener('message', async ({ data }) => {
	if (data.type !== 'run') return;

	const phase = (text) => self.postMessage({ type: 'phase', phase: text });
	const started = performance.now();

	try {
		const loaded = await loadAssets(phase);
		const result = await compileAndRun({
			source: data.source,
			assets: loaded,
			onStage: (stage) => phase(stage),
			onStdout: (text, stage) => self.postMessage({ type: 'stdout', text, stage }),
			onStderr: (text, stage) => self.postMessage({ type: 'stderr', text, stage })
		});

		self.postMessage({
			type: 'exit',
			exitCode: result.exitCode,
			phases: result.phases,
			ms: performance.now() - started
		});
	} catch (error) {
		self.postMessage({
			type: 'error',
			message: String(error?.message ?? error),
			stage: error?.stage,
			diagnostics: error?.diagnostics
		});
	}
});
