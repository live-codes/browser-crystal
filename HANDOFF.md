# Handoff — Crystal running in the browser

Everything a new session needs to pick this up cold. Read this first, then
[`FINDINGS.md`](FINDINGS.md) §9–§10 for the narrative and
[`build/crystal-wasm/README.md`](build/crystal-wasm/README.md) for the detailed blocker log.

**The goal.** Add Crystal to LiveCodes: edit Crystal in a page, compile it in the tab, run it —
no server. Crystal has no client-side compiler, so this repo set out to make one.

**One-line status.** libLLVM for wasm is built and verified; the Crystal compiler builds, links
and *runs* as wasm and reads the standard library; the last blocker is exception handling, and
it is now one function in Crystal's codegen plus the linker/UI work above it.

---

## 1. Start here

The whole thing runs in the **`racket-build` WSL distro** (Ubuntu 24.04, root). From Windows:

```powershell
wsl -d racket-build -- bash <script>
```

**Write scripts to files and run them.** PowerShell mangles `$`, `()`, backticks and heredocs
on the way to WSL — every `bash -c "..."` with a shell variable will fail. Put the script on a
Windows path and run `wsl -d racket-build -- bash /mnt/c/.../script.sh`.

**Background output is often lost.** For a long run, redirect *inside* WSL
(`bash x.sh > /root/log 2>&1`) and read that file; the tool's own task log is frequently empty.

**The network is hostile to big downloads from GitHub** (~20 KB/s, and connections reset
mid-transfer). `git ls-remote`/`git clone` are fine; for release assets use
`build/llvm-wasm/fetch.sh` (parallel ranged download with per-chunk resume). One 194 MB tarball
took ~20 minutes with it.

Do not rely on Docker — the daemon is not running. Do not modify
`D:\DevWork\live-codes\clang-wasm`; reading/using its assets is fine.

---

## 2. Status, layer by layer

| Layer | State |
| --- | --- |
| **libLLVM 20.1.8 for `wasm32-wasip1`** | **Done.** 99 static archives. A probe links them all, runs under Node's WASI, calls the LLVM C API, registers the wasm target and constructs an IR module. |
| **Crystal compiler as wasm** | **Done.** `crystal.wasm` (96 MB) builds, links and runs. `--version` prints `Crystal 1.17.0 / LLVM: 20.1.8 / Default target: wasm32-unknown-wasip1`. |
| **Compiling a program** | Reads the stdlib, parses, reaches semantic analysis and macro interpretation — then hits exceptions. |
| **Exceptions on wasm** | `raise` is a real wasm `throw`. The catch is the remaining bug: **one function, `codegen_re_raise`**. See §6. |
| **The page** | Untouched. Still the original PoC: a read-only pane running precompiled samples. Needs the work in §7. |

---

## 3. Environment (what is installed, and where)

WSL distro `racket-build` (Ubuntu 24.04, root, 12 cores, ~7.6 GB RAM):

| Thing | Path |
| --- | --- |
| Repo (from WSL) | `/mnt/d/DevWork/live-codes/browser-crystal` |
| Crystal 1.17.0 distribution | `/opt/crystal-1.17.0` (`bin/crystal`, and the full source in `share/crystal/src`) |
| wasi-sdk 33 (clang 22 → `wasm32-wasip1`) | `/opt/wasi-sdk-33` |
| LLVM 20 source (pristine) | `/root/bc-llvm/src/llvm-project` |
| LLVM 20 build trees | `/root/bc-llvm/build-host`, `/root/bc-llvm/build-wasi` |
| wasm PCRE2 | `/root/bc-pcre2/build/libpcre2-8.a` |
| Crystal build tree | `/root/bc-crystal` (`src` = patched source, `bin/crystal-native`, `crystal.o.wasm`, `crystal.wasm`) |
| Downloads cache | `/root/.cache/browser-crystal` |
| Node | `/root/emsdk/node/24.19.0_64bit/bin/node` |

Installed for the bootstrap build: `libpcre3-dev`, `libgc-dev`, `llvm-20-dev`
(`/usr/lib/llvm-20/bin/llvm-config` — Crystal 1.17 supports LLVM 8–20, and the machine's
default `llvm-config` on PATH is 21, which it does not).

---

## 4. Repo layout

```
build/llvm-wasm/          libLLVM-for-wasm pipeline
  build.sh                  fetch → host tblgen → cross → pack → verify
  fetch.sh                  parallel, resumable download (the network needs it)
  toolchain-wasi.cmake      the wasm32-wasip1 cross toolchain
  patches/apply-patches.py  every LLVM source edit, idempotent and commented
  wasi-compat/              declarations + stub definitions for what WASI lacks
  verify/                   the C-API probe (link + run under Node WASI)
  out/                      99 archives + headers — COMMITTED (~140 MB, deliberately)
  STATUS.md, README.md, llvm-wasm.lock.json

build/crystal-wasm/       the Crystal compiler pipeline
  cross-compile.sh          patches a source copy, cross-compiles compiler/crystal.cr
  bootstrap.sh              builds a NATIVE compiler from the patched source
  apply-patches.py          every Crystal source edit, idempotent and commented
  link.sh                   links the wasm object against libLLVM + PCRE2 + compat
  build-pcre2.sh            cross-builds PCRE2 for wasm
  try-compile.mjs           runs crystal.wasm under clang-wasm's toolchain (real FS)
  README.md                 the detailed blocker log — read this alongside §6

public/                   the PoC page (unchanged: read-only pane + precompiled samples)
FINDINGS.md               §9 = libLLVM, §10 = the compiler
```

---

## 5. How to run each stage

**libLLVM** (already built; rebuilding is on the order of an hour):

```bash
WASI_SDK=/opt/wasi-sdk-33 bash build/llvm-wasm/build.sh          # all stages
STAGE=verify WASI_SDK=/opt/wasi-sdk-33 bash build/llvm-wasm/build.sh
```

**The Crystal compiler, end to end** — the whole sequence, from a clean patched source copy:

```bash
OUT=/root/bc-crystal
rm -rf $OUT/src && cp -r /opt/crystal-1.17.0/share/crystal/src $OUT/src
python3 build/crystal-wasm/apply-patches.py $OUT/src      # apply all patches
OUT=$OUT bash build/crystal-wasm/bootstrap.sh             # ~10 min: native crystal-native
CRYSTAL=$OUT/bin/crystal-native CRYSTAL_SRC=/opt/crystal-1.17.0/share/crystal/src \
  bash build/crystal-wasm/cross-compile.sh                # ~10 min: crystal.o.wasm
bash build/crystal-wasm/link.sh                           # ~3 min: crystal.wasm
/root/emsdk/node/24.19.0_64bit/bin/node build/crystal-wasm/try-compile.mjs   # ~5 min
```

**The fast repro.** Never iterate on the 25-minute cycle above. Use a three-line program that
compiles and links in seconds:

```bash
# /root/bc-crystal/exc.cr
begin
  raise "boom"
rescue ex : Exception
  puts "caught: #{ex.message}"
end
puts "done"
```

```bash
cd /root/bc-crystal && export CRYSTAL_PATH=/root/bc-crystal/src
/root/bc-crystal/bin/crystal-native build exc.cr \
  --mattr=+exception-handling --cross-compile --target wasm32-unknown-wasi -o exc.o.wasm
/opt/wasi-sdk-33/bin/clang --target=wasm32-wasip1 \
  --sysroot=/opt/wasi-sdk-33/share/wasi-sysroot -O1 -nostartfiles -fwasm-exceptions \
  -o exc.wasm exc.o.wasm -lc++ -lc++abi -lunwind \
  -lwasi-emulated-signal -lwasi-emulated-mman -lwasi-emulated-getpid -lwasi-emulated-process-clocks
/root/emsdk/node/24.19.0_64bit/bin/node build/llvm-wasm/verify/run-wasi.mjs exc.wasm
```

`llvm-objdump` from wasi-sdk disassembles wasm and is the tool that cracked the last step:
`/opt/wasi-sdk-33/bin/llvm-objdump -d exc.wasm`.

---

## 6. THE NEXT TASK — make the wasm catch work

**Symptom.** `begin/rescue/raise` on wasm throws and the exception escapes the module:
`Exception [WebAssembly.Exception] {}`.

**What is already right** (do not undo it):

- The compiler is built with `--mattr=+exception-handling` and linked with
  `-fwasm-exceptions` (the `eh` sysroot) plus `-lunwind`. The WebAssembly target machine
  *forces* `ExceptionModel = Wasm` itself, so nothing needs the LLVM `TargetOptions` the C API
  cannot set.
- The four `wasm32` stubs in `src/raise.cr` are removed, so `raise` performs a real wasm
  `throw` (`_Unwind_RaiseException` → `__builtin_wasm_throw`).
- Disassembling the repro proved the landing pad was **dropped**: the module had `throw 0` and
  **no `try`/`catch` at all**. The cause: **LLVM's wasm EH uses the funclet representation**
  (`catchswitch`/`catchpad`, lowered to `catch __cpp_exception` —
  `WebAssemblyISelDAGToDAG.cpp`), which is Crystal's **msvc** path, not its landing-pad path.
  So `apply-patches.py` now routes a wasm target down the msvc branch, by extending
  `msvc = @program.has_flag?("msvc")` with a runtime target check (it is a runtime flag, so
  wasm can join it).

**Where it stops now:**

```
Nil assertion failed (NilAssertionError)
  from compiler/crystal/codegen/exception.cr ... in 'codegen_re_raise'
```

**The fix — two parts, both in `compiler/crystal/codegen/exception.cr`:**

1. **Predicate consistency.** The ensure path's caller branches on the new `funclet_eh`, but
   `codegen_re_raise` itself still branches on `@program.has_flag?("msvc")`. On wasm the caller
   takes the funclet branch (where `unwind_ex_obj` is never assigned) and the callee takes the
   non-funclet branch and asserts on it. Both must branch on the same predicate.

2. **A wasm re-raise.** The funclet re-raise is
   `call windows_throw_fun, [void_pointer.null, void_pointer.null]` — `_CxxThrowException`,
   Windows-only. The direct wasm analogue is LLVM's **`llvm.wasm.rethrow`** intrinsic, which
   re-raises the exception currently being handled, exactly as the Windows call does: declare
   `void @llvm.wasm.rethrow()`, call it, `unreachable`.
   The alternative — give the funclet ensure-catchpad a real slot instead of
   `void_pointer.null` (the rescue path already allocates one for the caught exception) and call
   Crystal's own `raise_without_backtrace` on it — is more code but avoids the intrinsic.

**How to test:** the repro in §5. Success is `caught: boom` / `done`; failure is the
`WebAssembly.Exception` escaping.

**Do not reintroduce these — they were wrong paths:**

- `{% if flag?(:wasm32) %}` in codegen. That flag is evaluated when the *compiler is built*, so
  a natively-built `crystal-native` took the else branch. Use a runtime target check.
- A catch-all clause on a **landingpad** (`landingpad` clauses are irrelevant on wasm — the
  whole path is dropped).
- Any declaration inside a statement-position `{% if %}` in Crystal source: it is not visible
  after `{% end %}`. Use expression-position macros or a runtime `if`.

---

## 7. After exceptions — the remaining roadmap

1. **The lld step.** The compiler emits a wasm *object*; nothing in the browser can link it yet.
   clang-wasm ships `lld.wasm` (usable read-only), or build lld from the LLVM source in
   `build/llvm-wasm`. Then link the object with the wasm sysroot (see §8).
2. **Assets.** The Crystal stdlib is **1552 `.cr`, 15 MB** (fits clang-wasm's memfs budget of
   4091 nodes). It has to ship with the page, plus a wasm sysroot for linking user programs
   (`crt1.o`, `libc.a`, `libc++.a`, `libc++abi.a`, `libpcre2-8.a`).
3. **The page** (`public/index.html` today = read-only pane + precompiled samples):
   an editable editor → run the compiler (with a real filesystem) → take the emitted object →
   link with `lld` → run it through the existing WASI host (`public/wasi-preview1.js`, which
   has no filesystem and will need one for the compiler). `try-compile.mjs` is the Node harness
   that already proves the first three fifths of that flow.
4. **Consider `-Drelease`** for the compiler build — `crystal.wasm` is 96 MB because it is a
   debug build, and a page should not download that.

---

## 8. Everything learned the hard way

**WASI gaps** (all live in `build/llvm-wasm/wasi-compat/`; reuse them, don't rediscover them):

- `libdl.a` is an **empty stub** — `dlopen`/`dlclose`/`dlsym`/`dlerror` are stubbed in `compat.c`.
- The sysroot's `_Unwind_SetIP` returns `void` while Crystal's `LibUnwind` binding says
  `SizeT`; wasm-ld warns. Harmless while Crystal's personality is never called, but the
  bindings do not match the library.
- `Crystal::EventLoop::Wasi#open` was a `NotImplementedError`; implemented over `LibC.open`.
- `exception/call_stack.cr` picks `call_stack/null` on wasm, which does **not** require
  `exception/lib_unwind` and does **not** define `CallStack.print_backtrace`; both were patched.
- `process/status.cr` guards its method *bodies* for `!flag?(:wasm32)` but not the return-type
  annotations, which still named `Signal` (undefined on wasm).
- `compiler/crystal/config.cr`'s `exec_path` block could not infer a type because
  `Process.executable_path` is meaningless on wasm.
- libffi's ABI enum had no wasm32 entry (i386-unix values; wasm32 is ILP32).
- PCRE: Crystal falls back to its **PCRE1** engine when the host pkg-config lacks
  `libpcre2-8`. Build PCRE2 (`build-pcre2.sh`) and compile with `-Duse_pcre2`.

**Crystal build flags that matter:** `-Di_know_what_im_doing`, `-Dwithout_playground`,
`-Dwithout_docs` (a flag this repo adds, mirroring `without_playground`),
`-Dwithout_interpreter`, `-Duse_pcre2`, `--mattr=+exception-handling`.

**Link/compile facts:** `-nostartfiles` (Crystal defines its own `_start`, and `crt1` does too);
`-z stack-size=33554432` (the 64 KiB default overflows on semantic analysis);
`CRYSTAL_PATH` must be pinned at the patched copy or the compiler's source loads twice
("can't reopen enum and add more constants").

**Two self-inflicted lessons worth keeping:**

- `apply-patches.py`'s idempotency check must test `old` **before** `new`; a replacement can be
  a common string (`{% else %}`) and looks "already applied" when it is not.
- The bootstrap is unavoidable for **any** codegen change: landing pads come from whichever
  compiler compiles the code, so the native compiler must be rebuilt with the patch and then
  used for the cross-compile.

---

## 9. Commit log (`main`)

```
5b5ecbb  Wasm EH: it is the funclet form, and the repro proves it
0a384fc  Wasm landing pads verify; the catch still does not take effect
d2ed612  Fix the type-id load, which the verifier named exactly
0b70ad1  Encode the catch-all clause as LLVM's IR does
5cc2647  Codegen: check the target at runtime, not with flag?(:wasm32)
00a749b  Name the exact bootstrap prerequisites
3f6a789  Give wasm a landing-pad shape it can catch, and bootstrap the compiler
c6f4fb3  Wasm exceptions: raise now throws, and the remaining gap is landing pads
ed0f188  Push on the wasm exception codegen: the model is there, the runtime is stubbed
fbd1988  Give the compiler a WASI filesystem, and find where it really stops
ba5862b  Run the wasm Crystal compiler under a WASI filesystem
7ad7dc6  The Crystal compiler runs as wasm32-wasip1
f2cb74f  Link the Crystal compiler against the wasm libLLVM
87ca8a8  Cross the Crystal compiler as far as its own stdlib
f1494f5  Start crossing the Crystal compiler to wasm
1305861  build artifacts                    (user: committed the libLLVM output deliberately)
e0b1867  libLLVM builds for wasm32-wasip1 and runs in a wasm engine
5b851fa  Get LLVMSupport building for wasm32-wasip1
ed71913  Add a pipeline to build libLLVM for wasm32-wasip1
```

## 10. Cautions

- `build/llvm-wasm/out/` is ~140 MB and **committed on purpose** by the user. Don't "clean" it.
- `.commandcode/taste/taste.md` is modified by the learning system — leave it alone.
- `D:\DevWork\live-codes\clang-wasm` is read-only for this work.
- The working tree is clean; `build/crystal-wasm/README.md` is the detailed log and is kept
  current with each finding.
