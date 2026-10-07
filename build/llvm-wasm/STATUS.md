# Status — libLLVM for wasm32-wasip1

Working notes for the build in `build/llvm-wasm/`. Read the README first; this is
the "where it stands right now" file.

## What runs today

Everything up to and including LLVM's cross configure, plus most of `LLVMSupport`:

- LLVM **20.1.8** source fetches (147 MB, over a link that throttles a single
  connection to ~20 KB/s — hence `fetch.sh`).
- Host `llvm-tblgen` builds natively. ✅
- The wasm32-wasip1 cross **configure succeeds** (`-DLLVM_TARGETS_TO_BUILD=WebAssembly`,
  static, threads/EH/RTTI off). ✅
- `LLVMSupport` — the library everything depends on, and the one that touches the
  most of the OS — compiles **154 of its 158 remaining source files**; two of the
  four that were pure-OS are excluded (see below).

Reproduce the current state:

```bash
STAGE=host  bash build/llvm-wasm/build.sh   # native llvm-tblgen
STAGE=conf  bash build/llvm-wasm/build.sh   # cross configure (applies patches)
ninja -C /root/bc-llvm/build-wasi -k 0 LLVMSupport
```

## What is patched, and why

`patches/apply-patches.py` is the whole set. Each is commented at the point of
application; in short:

| File | Why |
| --- | --- |
| `cmake/modules/HandleLLVMOptions.cmake` | LLVM aborts on an unknown platform; WASI joins the Unix branch |
| `include/llvm/ADT/bit.h` | wasi-libc has `<endian.h>`; the platform list didn't know `__wasi__` |
| `lib/Support/Unix/Unix.h` | no `<sys/wait.h>` on WASI |
| `lib/Support/Unix/Watchdog.inc` | no `alarm()` |
| `lib/Support/LockFileManager.cpp` | no `getsid()` (no processes) |
| `lib/Support/CMakeLists.txt` | exclude `CrashRecoveryContext.cpp` (signals + setjmp) and `raw_socket_stream.cpp` (AF_UNIX) — WASI has neither, and nothing in the libraries we build references them |
| toolchain file | `_WASI_EMULATED_SIGNAL/_MMAN/_GETPID/_PROCESS_CLOCKS`, which the sysroot headers require |

## What remains

Four files, all the process/signal core. The exact errors, as of the last run:

```
usr/lib/Support/Unix/Path.inc:31      fatal: 'pwd.h' file not found        (getpwuid for the home dir)
usr/lib/Support/Unix/Process.inc:129  incomplete 'struct rlimit'; RLIMIT_CORE (129,150)
usr/lib/Support/Unix/Process.inc:238  'dup2'
usr/lib/Support/Unix/Process.inc:247  'sigfillset'; SIG_SETMASK (255,269)
usr/lib/Support/Unix/Program.inc:110  'dup2'; rlimit/RLIMIT_DATA (141,145,147)
usr/lib/Support/Unix/Program.inc:268  fork(); then setsid, dup2, execve, execv,
                                      wait4, sigaction, WNOHANG, alarm, kill, wait
usr/lib/Support/Unix/Signals.inc:256  incomplete 'struct sigaction'; SA_NODEFER/
                                      SA_RESETHAND/SA_ONSTACK (317,321); sigfillset,
                                      SIG_UNBLOCK (382,383); 'Dl_info' (823,838)
```

These are all things WASI preview 1 does not have. Two ways through:

1. **Guard-and-stub in place** — `#if defined(__wasi__)` around each, with
   implementations that report "not supported" (as `Program.cpp` must, since
   `sys::ExecuteAndWait` is referenced by `Support` itself). Most faithful; most edits.
2. **A WASI compatibility layer** — a small `include/` shim supplying `pwd.h`,
   `sys/resource.h`, `struct sigaction`, the `SA_*`/`RLIMIT_*` constants and `Dl_info`,
   plus stub definitions for the missing calls, force-included and linked. Fewer
   edits; needs care to avoid clashing with what wasi-libc's emulated libraries
   already define.

Whichever is chosen, the parts that cannot work on WASI (`fork`/`exec`, signal
handlers, `dladdr` backtraces) should keep the *symbols* present but return
failure — the Crystal compiler does not use them, but `LLVMSupport` and `LLVMPasses`
reference them, so the archives must define them.

After `LLVMSupport`, the rest of LLVM is expected to need far fewer edits: the
WebAssembly target, Core, IR, MC, Object, Bitcode and Analysis are largely
platform-independent. A full `STAGE=build` run is the way to find out.

## The honest headline

This confirms the shape from `FINDINGS.md`: building libLLVM for wasm is not an
integration but a port, because LLVM's Unix support layer assumes an operating
system that WASI preview 1 is not. It is bounded and understood — a handful of
files — but it is upstream-grade work that nobody has published, which is exactly
why the artifact does not exist to download.
