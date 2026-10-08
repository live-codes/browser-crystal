// try-link.mjs — link the object the wasm compiler emitted, with clang-wasm's
// lld.wasm, inside the WASI host — then run the result in that same host.
//
//   node try-link.mjs
//
// Env:
//   CLANG_WASM   clang-wasm's toolchain.node.js       (default: sibling checkout)
//   OBJ          the wasm object to link              (default: /root/bc-crystal/out.o.wasm)
//   WASI_SDK     the wasi-sdk whose EH sysroot is used (default: /opt/wasi-sdk-33)
//   PCRE_LIB     the wasm libpcre2-8.a                 (default: /root/bc-pcre2/build)
//   OUT_WASM     where to write the linked module      (default: /root/bc-crystal/out.host.wasm)
//
// try-compile.mjs proves the *compiler* runs in the WASI host; this proves the
// *linker* does too — the two halves the page needs, and the reason no host tool
// is involved. It also settles a version question: clang-wasm's lld is LLVM 22
// while our compiler emits LLVM 20 objects, and it links them.
//
// Unlike try-compile.mjs this needs no `--stack-size`: linking is not deeply
// recursive.
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const CW = process.env.CLANG_WASM ?? '/mnt/d/DevWork/live-codes/clang-wasm/packages/clang-wasm/src/toolchain.node.js';
const OBJ = process.env.OBJ ?? '/root/bc-crystal/out.o.wasm';
const WASI_SDK = process.env.WASI_SDK ?? '/opt/wasi-sdk-33';
const PCRE_LIB = process.env.PCRE_LIB ?? '/root/bc-pcre2/build';
const OUT_WASM = process.env.OUT_WASM ?? '/root/bc-crystal/out.host.wasm';

const SYSROOT = `${WASI_SDK}/share/wasi-sysroot`;
const CLANG_RT = `${WASI_SDK}/lib/clang/22/lib/wasm32-unknown-wasip1`;

// The libraries clang's driver passes to wasm-ld under `-fwasm-exceptions`,
// mounted at the same relative paths so `-L` can mirror them. The `eh/` variants
// carry the wasm EH runtime — libunwind.a's `_Unwind_RaiseException` is a real
// `wasm throw` and libc++abi supplies `__gxx_wasm_personality_v0` — which is
// exactly what the compiler's objects need now that EH is on. clang-wasm's own
// bundled sysroot deliberately excludes `eh/`, so these ship with the page.
const LIBS = [
	['sysroot/lib/wasm32-wasip1/libc.a', `${SYSROOT}/lib/wasm32-wasip1/libc.a`],
	['sysroot/lib/wasm32-wasip1/eh/libc++.a', `${SYSROOT}/lib/wasm32-wasip1/eh/libc++.a`],
	['sysroot/lib/wasm32-wasip1/eh/libc++abi.a', `${SYSROOT}/lib/wasm32-wasip1/eh/libc++abi.a`],
	['sysroot/lib/wasm32-wasip1/eh/libunwind.a', `${SYSROOT}/lib/wasm32-wasip1/eh/libunwind.a`],
	['sysroot/lib/wasm32-wasip1/libwasi-emulated-signal.a', `${SYSROOT}/lib/wasm32-wasip1/libwasi-emulated-signal.a`],
	['sysroot/lib/wasm32-wasip1/libwasi-emulated-mman.a', `${SYSROOT}/lib/wasm32-wasip1/libwasi-emulated-mman.a`],
	['sysroot/lib/wasm32-wasip1/libwasi-emulated-getpid.a', `${SYSROOT}/lib/wasm32-wasip1/libwasi-emulated-getpid.a`],
	['sysroot/lib/wasm32-wasip1/libwasi-emulated-process-clocks.a', `${SYSROOT}/lib/wasm32-wasip1/libwasi-emulated-process-clocks.a`],
	['pcre/libpcre2-8.a', `${PCRE_LIB}/libpcre2-8.a`],
	['libclang_rt/libclang_rt.builtins.a', `${CLANG_RT}/libclang_rt.builtins.a`]
];

const { createToolchain } = await import(pathToFileURL(CW).href);
const toolchain = await createToolchain();

console.log('loading lld.wasm …');
const lld = await toolchain.runtime.getModule(toolchain.runtime.assetUrls.lld);

console.log('reading object and libraries …');
const files = [{ path: 'out.o.wasm', contents: await readFile(OBJ) }];
for (const [path, source] of LIBS) {
	files.push({ path, contents: await readFile(source) });
}

console.log('linking with lld.wasm …');
// lld.wasm is a generic lld driver and dispatches on argv[0], so it must be told
// it is wasm-ld (the manifest records the same name).
const link = await toolchain.runCommand(lld, {
	programName: 'wasm-ld',
	args: [
		'-m', 'wasm32',
		'-Lsysroot/lib/wasm32-wasip1/eh',
		'-Lsysroot/lib/wasm32-wasip1',
		'-Lpcre',
		'-Llibclang_rt',
		'out.o.wasm',
		'-lpcre2-8', '-lc++', '-lc++abi', '-lunwind',
		'-lwasi-emulated-signal', '-lwasi-emulated-mman',
		'-lwasi-emulated-getpid', '-lwasi-emulated-process-clocks',
		'-lc',
		'libclang_rt/libclang_rt.builtins.a',
		'-o', 'out.wasm'
	],
	files
});
console.log('link exitCode:', link.exitCode);
if (link.stdout) console.log('--- lld stdout ---\n' + link.stdout);
if (link.stderr) console.log('--- lld stderr ---\n' + link.stderr);

const wasm = link.readFile('out.wasm');
console.log('out.wasm:', wasm ? `${wasm.length} bytes` : 'not produced');
if (!wasm) process.exit(1);
await writeFile(OUT_WASM, wasm);

console.log('running the linked program in the same host …');
const module = await WebAssembly.compile(wasm);
const run = await toolchain.runCommand(module, {});
console.log('run exitCode:', run.exitCode);
console.log('--- program stdout ---\n' + run.stdout);
if (run.stderr) console.log('--- program stderr ---\n' + run.stderr);
