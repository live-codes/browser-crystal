# libLLVM for wasm32-wasip1

**Goal:** build the one artifact Crystal's compiler needs and that does not exist
anywhere to download — `libLLVM` compiled to WebAssembly — so a Crystal compiler
can eventually run in the browser.

This directory is the pipeline for that. It builds LLVM **as a library** for
`wasm32-wasip1` (WASI preview 1), which is a different thing from the Clang/LLD
*tools* that [`@live-codes/clang-wasm`](https://github.com/live-codes/clang-wasm)
and this repo's sibling `clang-wasm` checkout ship: those are wasm *applications*
you run; this is a wasm *library* you link a program against.

## Why wasm32-wasi, and why LLVM 20

- **WASI, not Emscripten.** Crystal only ever emits `wasm32-unknown-wasi` — it has
  no Emscripten target — so the libLLVM its compiler links must itself be
  wasm32-wasi. Emscripten would be a dead end here. It also keeps the stack
  coherent: the repo already runs WASI preview 1 modules, and `clang-wasm`'s
  `lld.wasm` is WASI too.
- **LLVM 20.1.8.** Crystal 1.17 supports LLVM 8–20
  (`src/llvm/lib_llvm.cr`: `IS_LT_210` is the last comparison). 20.1.8 is the
  newest release it accepts, so the library is pinned to that rather than to
  whatever is current.
- **WebAssembly backend only.** `LLVM_TARGETS_TO_BUILD=WebAssembly` — the compiler
  only ever emits wasm objects, so no other codegen is built.

## How it is built

Three stages, because an LLVM cross-compile cannot run a wasm `llvm-tblgen`:

```
llvm-project-20.1.8.src.tar.xz          147 MB, downloaded with range-resume
  → stage A: llvm-tblgen built natively  (the host tool the cross build needs)
  → stage B: cmake --toolchain-file toolchain-wasi.cmake
             -DLLVM_TABLEGEN=<host tblgen> -DLLVM_TARGETS_TO_BUILD=WebAssembly
             → libLLVM*.a for wasm32-wasip1
  → stage C: pack archives + headers into out/
  → stage D: link verify/llvm-probe.c against them and run it
```

The host cross-compiler is **wasi-sdk 33** (clang 22 targeting wasm32-wasip1,
plus the WASI sysroot with libc and libc++).

## Reproduce

Linux or WSL. Needs `cmake >= 3.20`, `ninja`, a native C/C++ compiler, `curl`,
`tar`, `xz`, and an extracted wasi-sdk (see `llvm-wasm.lock.json`).

```bash
WASI_SDK=/opt/wasi-sdk-33 bash build/llvm-wasm/build.sh
# or one stage at a time:
STAGE=fetch bash build/llvm-wasm/build.sh
STAGE=host  bash build/llvm-wasm/build.sh
STAGE=cross bash build/llvm-wasm/build.sh
STAGE=pack  bash build/llvm-wasm/build.sh
STAGE=verify bash build/llvm-wasm/build.sh
```

Env: `WORK` (build tree, default `/root/bc-llvm`), `CACHE` (downloads,
`/root/.cache/browser-crystal`), `OUT` (packaged result, `out/`), `JOBS`, `WASI_SDK`.

| File | What it is |
| --- | --- |
| `llvm-wasm.lock.json` | Pinned LLVM + wasi-sdk inputs and why |
| `fetch.sh` | Parallel, resumable download (the network throttles a single connection) |
| `toolchain-wasi.cmake` | CMake cross toolchain file for wasm32-wasip1 |
| `build.sh` | The four stages |
| `verify/llvm-probe.c` | Links against the built libLLVM and exercises the C API |
| `verify/run-probe.sh` | Compiles, links and runs the probe under Node's WASI |

## Status

Built on the `racket-build` WSL distro (Ubuntu 24.04, 12 cores). See the status
note in `FINDINGS.md` for the outcome of the first run and what it means for the
Crystal compiler above it.
