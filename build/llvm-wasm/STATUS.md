# Status — libLLVM for wasm32-wasip1

**Done: libLLVM 20.1.8 builds for wasm32-wasip1 and runs inside a wasm engine.**
Working notes for `build/llvm-wasm/`. Read the README first.

## Result

```
$ STAGE=verify bash build/llvm-wasm/build.sh
=== running under node WASI ===
libLLVM 20.1.8
wasm32 target registered
CODEGEN BUILT (module constructed)      # the probe constructs an IR module
```

`LLVMSupport`, `LLVMCore`, `LLVMIRReader`, `LLVMCodeGen`, `LLVMTarget`,
`LLVMObject`, `LLVMBitReader`/`Writer`, `LLVMAnalysis`, and the whole
**WebAssembly backend** — 99 static archives, 140 MB packaged — plus a 26.8 MB
probe that links them all and exercises the C API. This is the artifact that does
not exist anywhere to download.

## What the pipeline does

```
llvm-project-20.1.8.src.tar.xz          147 MB, range-resumed (the link throttles)
  → stage A: llvm-tblgen built natively
  → stage B: cmake + toolchain-wasi.cmake + patches + wasi-compat
             -DLLVM_TARGETS_TO_BUILD=WebAssembly, static, threads/EH/RTTI off
             → 99 × libLLVM*.a for wasm32-wasip1
  → stage C: pack archives + headers into out/
  → stage D: verify/run-probe.sh links llvm-probe.c and runs it under Node WASI
```

## How WASI was made to work

**1. Source patches** — every edit in `patches/apply-patches.py`, idempotent and
commented:

| File | Why |
| --- | --- |
| `cmake/modules/HandleLLVMOptions.cmake` | LLVM aborts on an unknown platform; WASI joins Unix |
| `include/llvm/ADT/bit.h` | wasi-libc has `<endian.h>`; the list didn't know `__wasi__` |
| `include/llvm/Support/Compiler.h` | clang defines `__wasm__`, LLVM tested `__WASM__` → `LLVM_ABI` was undefined |
| `lib/Support/Unix/Unix.h` | no `<sys/wait.h>` |
| `lib/Support/Unix/Watchdog.inc` | no `alarm()` |
| `lib/Support/Unix/Path.inc` | `statvfs`/`MNT_LOCAL` do not exist |
| `lib/Support/Unix/Program.inc` | `rusage::ru_maxrss` does not exist |
| `lib/Support/LockFileManager.cpp` | no `getsid()` |
| `lib/Support/CMakeLists.txt` | exclude `CrashRecoveryContext.cpp` and `raw_socket_stream.cpp`; `PARTIAL_SOURCES_INTENDED`; compile the compat stubs into LLVMSupport |

**2. A compatibility layer** (`wasi-compat/`) for the POSIX surface wasi-libc does
not declare at all — force-included declarations (`wasi-compat.h`, `pwd.h`) and
stub definitions (`compat.c`): `sigaction`/`sigset_t`/`rlimit`, `<sys/wait.h>`,
`fork`/`exec`/`wait`/`setsid`/`dup2`, `pwd`, `Dl_info`/`dladdr`, `fcntl` locks,
`fchown`/`getuid`/`umask`, `posix_madvise`.

**3. Emulation switches** the SDK requires (`_WASI_EMULATED_SIGNAL/_MMAN/_GETPID/
_PROCESS_CLOCKS`) plus the matching `-lwasi-emulated-*` on every link.

Deliberately **not** used: `__wasilibc_unmodified_upstream`. It looks like it unlocks
all of this from musl, but it makes `<errno.h>` want `<bits/errno.h>`, which
wasi-libc does not ship — it expects a complete musl sysroot.

## What it was for, and where that stands

The Crystal compiler, cross-built against these libraries — the consumer this artifact was produced
for — **now works, and runs in a browser**: see [../crystal-wasm/](../crystal-wasm/). It links
`out/lib/*.a` plus `wasi-compat/compat.c` and the emulated libraries, exactly as
`verify/run-probe.sh` does, and it supplies its own `llvm-config`-style flags (`llvm-config` prints
the host's; a wasm build needs the list above).

Two things worth knowing for any other consumer: a compiler built against these libraries emits for
`wasm32-wasip1` via the WebAssembly backend that is present here, and the parts of LLVM that need
processes, signals or sockets are stubs — which is fine, because a compiler does not fork or install
signal handlers.

**Extracted.** This directory is now its own repository and package —
[`llvm-wasm`](https://github.com/live-codes/llvm-wasm), `@live-codes/llvm-wasm` — and that is where
changes belong. The published tarball carries the payload as a single `out.tar.xz` (22 MB, against
the 38 MB these loose files make), which `llvm-wasm-unpack` restores; the copy here is kept until
that package is published, and `build/crystal-wasm/link.sh` accepts either. See
[../../HANDOFF.md](../../HANDOFF.md) §7.