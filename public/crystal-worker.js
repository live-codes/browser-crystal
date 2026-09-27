// Runs one Crystal module, off the page's thread.
//
// A Crystal program is a synchronous `_start` call that cannot be interrupted
// from the inside, so it runs here: a runaway program blocks this worker, not
// the page, and the page can get rid of it with `terminate()`.
//
// The protocol, both ways, is JSON-able objects:
//
//   in:  { type: 'run', wasmUrl, name, stdin }
//   out: { type: 'phase', phase }            loading | running
//        { type: 'stdout' | 'stderr', text } as the program writes it
//        { type: 'exit', exitCode, ms }
//        { type: 'error', message }          the module could not be loaded or run
import { run } from './wasi-preview1.js';

self.addEventListener('message', async ({ data }) => {
	if (data.type !== 'run') return;

	const started = performance.now();
	try {
		self.postMessage({ type: 'phase', phase: 'loading' });
		// compileStreaming needs `application/wasm`, which serve.mjs sends.
		const module = await WebAssembly.compileStreaming(fetch(data.wasmUrl));

		self.postMessage({ type: 'phase', phase: 'running' });
		const { exitCode } = await run(module, {
			stdin: data.stdin ?? '',
			args: [data.name ?? 'program'],
			onStdout: (text) => self.postMessage({ type: 'stdout', text }),
			onStderr: (text) => self.postMessage({ type: 'stderr', text }),
		});

		self.postMessage({ type: 'exit', exitCode, ms: performance.now() - started });
	} catch (error) {
		self.postMessage({ type: 'error', message: String(error?.message ?? error) });
	}
});
