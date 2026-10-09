// demo-worker.js — the page's off-thread half.
//
// The compiler is a synchronous `_start` that can run for seconds and cannot be
// interrupted from the inside, so it runs here: a runaway compile blocks this
// worker, and the page can throw it away with `terminate()`.
//
// Everything about compiling Crystal lives in the package — `@live-codes/crystal-wasm`,
// imported from ../packages/crystal-wasm for the same reason the page imports
// anything else from this repo. What is left here is the page's side of it: a
// message protocol, and the policy for what the output pane shows.
import { createCompiler } from '../packages/crystal-wasm/src/index.js';

// The package's payload, which serve.mjs serves straight out of the package. A
// consumer outside this repo runs `crystal-wasm-copy-assets` and points baseUrl at
// the copy instead — see the package's README.
const baseUrl = new URL('../packages/crystal-wasm/assets/crystal/', self.location.href);

// The compiler and the linker both say things that are not about the program:
// Crystal echoes the link command it *would* have run (`wasm-ld out.o.wasm -o
// out.o -lc`, which is not the link we do), and lld warns about a signature
// mismatch between Crystal's `_Unwind_SetIP` binding and libunwind's wasm port
// (known, benign, and documented).
//
// What does belong is a compiler warning *about this program*, which arrives on the
// compiler's stderr. So build output is buffered rather than streamed, and on
// success only those chunks are shown; a failed build sends its diagnostics the
// usual way, through the error.
const buildOutput = [];

const compiler = createCompiler({
	baseUrl: baseUrl.href,
	onStatus: (text) => self.postMessage({ type: 'phase', phase: text }),
	onLog: (text, { stage, stream }) => buildOutput.push({ text, stage, stream }),
	onOutput: (text, stream) =>
		self.postMessage({ type: stream === 'out' ? 'stdout' : 'stderr', text, stage: 'running' })
});

self.addEventListener('message', async ({ data }) => {
	if (data.type !== 'run') return;

	const started = performance.now();

	try {
		const instance = await compiler;
		buildOutput.length = 0;

		const result = await instance.run(data.source, data.stdin ?? '');

		for (const chunk of buildOutput) {
			if (chunk.stage === 'compiling' && chunk.stream === 'err') {
				self.postMessage({ type: 'stderr', text: chunk.text, stage: chunk.stage });
			}
		}

		self.postMessage({
			type: 'exit',
			exitCode: result.exitCode,
			compileMs: result.compileMs,
			runMs: result.runMs,
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
