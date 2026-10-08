# Handoff — Crystal running in the browser

Everything a new session needs to pick this up cold. Read this first, then
[`FINDINGS.md`](FINDINGS.md) §9–§10 for the narrative and
[`build/crystal-wasm/README.md`](build/crystal-wasm/README.md) for the detailed blocker log.

**The goal.** Add Crystal to LiveCodes: edit Crystal in a page, compile it in the tab, run it —
no server. Crystal has no client-side compiler, so this repo set out to make one.

**One-line status.** libLLVM for wasm is built and verified; the Crystal compiler builds, links
and *runs* as wasm; **exception handling now works**, and the compiler compiles a program to a
wasm object that links and runs. The remaining work is the browser side: `lld` in the page and
shipping the stdlib/sysroot as assets (§7). See §6 for the (now closed) exception story.

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
| **Compiling a program** | Reads the stdlib, parses, does semantic analysis and macro interpretation, **and emits a wasm object** — `try-compile.mjs` produces `out.o.wasm` for a real program. |
| **Exceptions on wasm** | **Done.** `raise`/`rescue`/`ensure` work on `wasm32-wasip1`. See §6. |
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
python3 build/crystal-wasm/apply-patches.py $OUT/src      # idempotent; safe to re-run

OUT=$OUT bash build/crystal-wasm/repro.sh                 # seconds: caught: boom / done

OUT=$OUT bash build/crystal-wasm/bootstrap.sh             # native crystal-native
CRYSTAL=$OUT/bin/crystal-native CRYSTAL_SRC=/opt/crystal-1.17.0/share/crystal/src \
  bash build/crystal-wasm/cross-compile.sh                # crystal.o.wasm
bash build/crystal-wasm/link.sh                           # crystal.wasm

# ~1 min warm (Crystal caches objects); the --stack-size is required — see §6.3
/root/emsdk/node/24.19.0_64bit/bin/node --stack-size=4000 build/crystal-wasm/try-compile.mjs
```

That last step writes `/root/bc-crystal/out.o.wasm`; link and run it like the repro below
(wasi-sdk `clang -fwasm-exceptions` + `-lunwind -lc++ -lc++abi`) and it prints
`hello from the wasm Crystal compiler`.

**The fast repro.** Never iterate on the compiler cycle above. Use a three-line program that
compiles and links in seconds — `build/crystal-wasm/repro.sh` does all of the following in one
command:

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
`/opt/wasi-sdk-33/bin/llvm-objdump -d exc.wasm` (look for `try`/`catch`/`rethrow` — their absence
was the whole bug).

**Gotcha: don't redirect the WSL command's output from Windows.** `wsl … -- bash x.sh > log`
puts the log on the *Windows* side; write scripts to files, redirect inside WSL, and read the
file.

---

## 6. RESOLVED — the wasm catch works

**Status: done.** `raise`/`rescue`/`ensure` work on `wasm32-wasip1`; the repro prints
`caught: boom` / `done`, and `crystal.wasm` compiles a program whose object links and runs.
The full detail is in [`build/crystal-wasm/README.md`](build/crystal-wasm/README.md#resolution--the-wasm-catch-works);
the shape of the fix, so it is not undone:

**1. The funclet shape — Crystal's msvc path, with a wasm-specific catchpad.** LLVM's wasm
backend lowers the *Windows-style funclet* IR (`catchswitch`/`catchpad`/`catchret`), never an
Itanium `landingpad`, so a wasm target takes the **msvc** path (`funclet_eh = msvc || wasm_target`,
a *runtime* target check). But the catchpad is shaped differently from msvc's:
a single catch-all operand (`[ptr null]`) and the caught exception fetched with
`llvm.wasm.get.exception(token)` (which `WasmEHPrepare` rewrites to the wasm `catch`
instruction) — **not** msvc's three-operand pad with a catch-object slot. Re-raise is
**`llvm.wasm.rethrow`** (no `_CxxThrowException` on wasm). A wasm personality
(`__gxx_wasm_personality_v0`) is set on every function that owns a catchpad.
`codegen_re_raise` branches on the *same* predicate as its caller — the old mismatch was the
`NilAssertionError`.

**2. `-wasm-enable-eh` — this was the actual blocker.** `WebAssemblyMCAsmInfo` only selects
`ExceptionHandling::Wasm` when the LLVM `cl::opt` **`-wasm-enable-eh`** is set
(`WebAssemblyMCAsmInfo.cpp:53`). `--mattr=+exception-handling` only toggles the subtarget
feature; it does **not** select the model. With the model at `None`, `TargetPassConfig` runs the
**`lowerinvoke`** pass, which rewrites every `invoke` to a `call` and deletes the
`catchswitch`/`catchpad` — so the exception escapes no matter how correct the funclet IR is (and
the disassembly shows a bare `throw` and no `try`, which is how this looked like a landing-pad
bug for so long; the `throw` was libunwind's, not the compiler's). clang's `-fwasm-exceptions`
sets the same option through `TargetOptions`, which the LLVM C API does not expose — so the
compiler flips it itself, in `codegen/target.cr`:
`LLVM.parse_command_line_options(["crystal", "-wasm-enable-eh"])` before the target machine is
built, plus `features += "+exception-handling"`. This is in a *compiler* file, not `llvm.cr`,
because the bootstrap resolves `require "llvm"` against the installed distribution.

**3. Two stacks, and only one of them is the module's.** The compiler's AST passes recurse
deeply, and there are two different stacks:
- Crystal's allocas are on the wasm **linear-memory stack**, sized by
  `-Wl,-z,stack-size=` (`link.sh`, default 32 MiB, `STACK_SIZE` to override). Exhausting it is a
  `memory access out of bounds` **trap**.
- The wasm **call frames** are on V8's **native** stack. Overrunning it is a
  `RangeError: Maximum call stack size exceeded`, and *no* `-z stack-size` value changes it.
  Node's default native stack is ~1 MiB, below the 8 MiB a native build gets, so
  `CleanupTransformer` overflows it **non-deterministically** (Crystal's hashes are randomly
  seeded; traversal depth varies run to run). The harness needs
  **`node --stack-size=4000`** (`try-compile.mjs` documents this). A browser cannot raise this —
  see §7.

**Do not reintroduce these — they were wrong paths:**

- `{% if flag?(:wasm32) %}` in codegen — it is evaluated when the *compiler is built*, so a
  natively-built `crystal-native` takes the else branch. Use a runtime target check.
- A catch-all clause on a **`landingpad`** — wasm never lowers `landingpad`; the whole path is
  dropped. The catchpad is the shape (above).
- Relying on `--mattr=+exception-handling` to turn on wasm EH — it does not; `-wasm-enable-eh`
  does (part 2). `--mattr`/the `features +=` line only makes `try`/`catch` *selectable*.
- Treating the two stacks as one. `-z stack-size` will not fix a `RangeError`.
- Any declaration inside a statement-position `{% if %}` in Crystal source: it is not visible
  after `{% end %}`. Use expression-position macros or a runtime `if`.

---

## 7. After exceptions — the remaining roadmap

The exception blocker is closed (§6). What is left is the browser:

1. **The lld step.** `try-compile.mjs` already links with wasi-sdk's `wasm-ld`, but nothing *in
   the browser* can link the emitted object yet. clang-wasm ships `lld.wasm` (usable read-only),
   or build lld from the LLVM source in `build/llvm-wasm`. The link needs the wasm sysroot and
   the EH runtime (`-fwasm-exceptions`, `-lunwind`, `-lc++abi`) now that EH is on — see the
   command in `README.md`.
2. **Assets.** The Crystal stdlib is **1552 `.cr`, 15 MB** (fits clang-wasm's memfs budget of
   4091 nodes). It has to ship with the page, plus a wasm sysroot for linking user programs
   (`crt1.o`, `libc.a`, `libc++.a`, `libc++abi.a`, `libpcre2-8.a`).
3. **The page** (`public/index.html` today = read-only pane + precompiled samples):
   an editable editor → run the compiler (with a real filesystem) → take the emitted object →
   link with `lld` → run it through the existing WASI host (`public/wasi-preview1.js`, which
   has no filesystem and will need one for the compiler). `try-compile.mjs` is the Node harness
   that already proves the first three fifths of that flow.
4. **Consider `-Drelease`** for the compiler build — `crystal.wasm` is 96 MB because it is a
   debug build, and a page should not download that. It would also help the deep recursion:
   smaller frames mean the AST passes need less of V8's native stack (§6.3), and a browser
   cannot be given `--stack-size`. Worth measuring against `try-compile.mjs`; if a release build
   still overflows, the transformer's recursion depth is the thing to look at.

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
`-z stack-size=33554432` (the 64 KiB default overflows the *linear* stack on semantic analysis);
`CRYSTAL_PATH` must be pinned at the patched copy or the compiler's source loads twice
("can't reopen enum and add more constants"). Note the bootstrap resolves `require "llvm"`
against the *installed* distribution, so a patch to `src/llvm.cr` does **not** reach the
bootstrap compiler — put compiler-side helpers in `compiler/…` files instead.

**Lessons worth keeping:**

- `apply-patches.py` idempotency: the check must look for a marker that exists *only* in the
  patched file. `old`-first alone is not enough — a pure insertion keeps `old` alive inside
  `new`, so the patch re-applies on every run (this bit us: duplicated `<% unless %>` blocks and
  a duplicated `print_backtrace`). Patches whose `new` contains `old` now carry an explicit
  `marker`; the script is verified to be a no-op on the second and third run.
- The bootstrap is unavoidable for **any** codegen change: the catchpad/landingpad shape comes
  from whichever compiler compiles the code, so the native compiler must be rebuilt with the
  patch and then used for the cross-compile. (Warm Crystal caches make this ~30 s, not 10 min.)
- When disassembling a linked wasm to check EH, remember the `throw` may be libunwind's, not the
  compiler's — check the *object* (`exc.o.wasm`), not just the linked module.

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
