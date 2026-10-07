# Status — libLLVM for wasm32-wasip1

Working notes for the build in `build/llvm-wasm/`. Read the README first; this is
the "where it stands right now" file.

## What works

- LLVM **20.1.8** source fetches (147 MB, over a link that throttles a single
  connection to ~20 KB/s — hence `fetch.sh`).
- Host `llvm-tblgen` builds natively. ✅
- The wasm32-wasip1 cross **configure succeeds** (`-DLLVM_TARGETS_TO_BUILD=WebAssembly`,
  static, threads/EH/RTTI off). ✅
- **`LLVMSupport` — and `LLVMDemangle` — build cleanly.** ✅ `libLLVMSupport.a`
  is 164/164 objects, no errors. This is the library everything else depends on,
  and the one that touches the most of the operating system, so it was the
  hard one.

```bash
STAGE=host  bash build/llvm-wasm/build.sh   # native llvm-tblgen
STAGE=conf  bash build/llvm-wasm/build.sh   # cross configure (applies patches)
ninja -C /root/bc-llvm/build-wasi -k 0 LLVMSupport   # → lib/libLLVMSupport.a
STAGE=cross bash build/llvm-wasm/build.sh   # build everything
```

## How Support was made to build

Two mechanisms, both in the repo:

**1. Two source patches** (`patches/apply-patches.py`) and a platform-detection
fix. Beyond the earlier ones (platform classification, `endian.h`, `sys/wait.h`,
`alarm`, `getsid`), the last two were `Path.inc`'s `statvfs`/`MNT_LOCAL` branch
and `Program.inc` reading `rusage::ru_maxrss`, which WASI's sysroot does not have.

**2. A small compatibility layer** (`wasi-compat/`), because wasi-libc declares
none of the process/signal surface LLVM's Unix support layer uses:

- `wasi-compat/include/wasi-compat.h` — force-included into every TU. Declares
  `sigset_t`, `struct sigaction`, `siginfo_t`, the `SA_*`/`SIG_*` constants,
  `struct rlimit` and `RLIMIT_*`, `<sys/wait.h>`'s macros and calls, `fork`/
  `exec*`/`wait*`/`setsid`/`dup2`, `struct passwd` and `getpwuid*`, `Dl_info`/
  `dladdr`, the `fcntl` lock commands, `fchown`, `getuid`, `umask`.
- `wasi-compat/include/pwd.h` — so LLVM's `Path.inc` `#include <pwd.h>` resolves.
- `wasi-compat/compat.c` — the matching definitions. On WASI they are honest
  stubs: `fork` cannot succeed, `sigaction` registers nothing. The Crystal
  compiler never calls them; the point is that `libLLVMSupport.a` and
  `libLLVMPasses.a` reference them, so a link must resolve them.

The one thing deliberately **not** used is `__wasilibc_unmodified_upstream`.
Switching it on does unlock much of this from musl's own headers, but it also
makes `<errno.h>` reach for `<bits/errno.h>`, which wasi-libc does not ship — it
expects a complete musl sysroot. Declaring the gaps explicitly is smaller and
does not fight the SDK.

## What remains

The full `STAGE=cross` build is the current step. Support was the worst of it;
Core, IR, MC, Object, Bitcode, Analysis and the WebAssembly target are largely
platform-independent, so they should need little or nothing. Any new failures
will be in the same categories as Support's (a POSIX call WASI lacks) and the
same two mechanisms should cover them.

After the libraries exist, `STAGE=pack` collects them and `STAGE=verify` links
`verify/llvm-probe.c` against them and runs it, which proves the C API works
inside a wasm engine — and `compat.c`'s object has to go on that link line
(see `verify/run-probe.sh`).

Then the long pole above it: the Crystal compiler itself, cross-built against
these libraries.

## The honest headline

This is a port of LLVM's Unix support layer to a platform with no processes,
signals or sockets — upstream-grade work nobody has published, which is why the
artifact does not exist to download. But it is now demonstrably tractable, not
blocked: the hardest library compiles, and every fix is small, understood and
recorded here.
