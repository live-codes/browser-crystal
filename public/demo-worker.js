// demo-worker.js — the page's off-thread half.
//
// The compiler is a synchronous `_start` that can run for seconds and cannot be
// interrupted from the inside, so it runs here: a runaway compile blocks this
// worker, and the page can throw it away with `terminate()`.
//
// Assets are fetched and compiled once, then reused for every run — compiling an
// 80 MB wasm module is the slowest thing that happens, and it should not happen
// twice.
import { compileAndRun } from './crystal-demo.js';

const LIBRARIES = [
	'lib/libc.a',
	'lib/libpcre2-8.a',
	'lib/libclang_rt.builtins.a',
	'lib/eh/libc++.a',
	'lib/eh/libc++abi.a',
	'lib/eh/libunwind.a',
	'lib/libwasi-emulated-signal.a',
	'lib/libwasi-emulated-mman.a',
	'lib/libwasi-emulated-getpid.a',
	'lib/libwasi-emulated-process-clocks.a'
];

const url = (path) => new URL(`./crystal-demo/${path}`, self.location.href).href;

async function fetchBytes(path) {
	const response = await fetch(url(path));
	if (!response.ok) {
		throw new Error(
			`could not fetch crystal-demo/${path} (${response.status}). ` +
				'Run build/crystal-wasm/demo-assets.sh to build the demo assets.'
		);
	}
	return new Uint8Array(await response.arrayBuffer());
}

let assets = null;

async function loadAssets(phase) {
	if (assets) return assets;

	phase('loading the compiler');
	// compileStreaming needs `application/wasm`, which serve.mjs sends, and does
	// not hold the whole module in JS memory first.
	const compiler = await WebAssembly.compileStreaming(fetch(url('compiler.wasm')));

	phase('loading the linker');
	const lld = await WebAssembly.compileStreaming(fetch(url('lld.wasm')));

	phase('loading the standard library');
	const stdlibResponse = await fetch(url('stdlib.json'));
	if (!stdlibResponse.ok) {
		throw new Error(
			`could not fetch crystal-demo/stdlib.json (${stdlibResponse.status}). ` +
				'Run build/crystal-wasm/demo-assets.sh to build the demo assets.'
		);
	}
	const stdlib = await stdlibResponse.json();

	phase('loading the sysroot');
	const libs = {};
	for (const path of LIBRARIES) libs[path] = await fetchBytes(path);

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
