# Handoff — Crystal running in the browser

Everything a new session needs to pick this up cold. Read this first, then
[`FINDINGS.md`](FINDINGS.md) §9–§10 for the narrative and
[`build/crystal-wasm/README.md`](build/crystal-wasm/README.md) for the detailed blocker log.

**The goal.** Add Crystal to LiveCodes: edit Crystal in a page, compile it in the tab, run it —
no server. Crystal has no client-side compiler, so this repo set out to make one.

**One-line status.** Done, end to end. libLLVM for wasm is built and verified; the Crystal compiler
builds, links and *runs* as wasm; **exception handling works**; and **the page compiles, links and
runs Crystal in the tab** — about 2 s a compile, on a 22 MB gzipped payload, with a stdin box and
eight samples that are compiled by the compiler on the page. What is left is packaging, not
capability: a `crystal` language package for LiveCodes (§7). See §6 for the (closed) exception story.

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
mid-transfer). `git ls-remote`/`git clone` are fine; for release assets use `fetch.sh` — it lives in
the llvm-wasm repository and package now (`node_modules/@live-codes/llvm-wasm/fetch.sh`) and does a
parallel ranged download with per-chunk resume. One 194 MB tarball took ~20 minutes with it.

Do not modify `D:\DevWork\live-codes\clang-wasm`; reading/using its assets is fine.

---

## 2. Status, layer by layer

| Layer | State |
| --- | --- |
| **libLLVM 20.1.8 for `wasm32-wasip1`** | **Done.** 99 static archives. A probe links them all, runs under Node's WASI, calls the LLVM C API, registers the wasm target and constructs an IR module. |
| **Crystal compiler as wasm** | **Done.** `crystal.wasm` (96 MB) builds, links and runs. `--version` prints `Crystal 1.17.0 / LLVM: 20.1.8 / Default target: wasm32-unknown-wasip1`. |
| **Compiling a program** | Reads the stdlib, parses, does semantic analysis and macro interpretation, **and emits a wasm object** — `try-compile.mjs` produces `out.o.wasm` for a real program. |
| **Exceptions on wasm** | **Done.** `raise`/`rescue`/`ensure` work on `wasm32-wasip1`. See §6. |
| **The page** | **Done.** `public/index.html`: edit, press Run, and the compiler, the linker and your program all run in the tab. Eight samples, a stdin box, ~2 s a compile, 22 MB gzipped. It is a consumer of the package below. |
| **The package** | **Done.** `packages/crystal-wasm` → `@live-codes/crystal-wasm`, in the shape of `@live-codes/nim-wasm`: `createCompiler({ baseUrl, toolchain })` → `run(code, input, { args, files })` → `{ ok, output, errors, exitCode, compileMs, runMs }`, assets pinned by SHA-256 receipts, a `crystal-wasm-copy-assets` bin, and 12 Node tests. The page is its first consumer. |

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
(the libLLVM-for-wasm pipeline and its 99 archives are **not here**: they are the
`llvm-wasm` repository, published as `@live-codes/llvm-wasm` — D:\DevWork\live-codes\llvm-wasm,
§7. This repo installs it as a devDependency and `link.sh` finds it in node_modules, or in a
checkout beside this one.)

build/crystal-wasm/       the Crystal compiler pipeline
  cross-compile.sh          patches a source copy, cross-compiles compiler/crystal.cr
  bootstrap.sh              builds a NATIVE compiler from the patched source
  apply-patches.py          every Crystal source edit, idempotent and commented
  link.sh                   links the wasm object against libLLVM + PCRE2 + compat
  build-pcre2.sh            cross-builds PCRE2 for wasm
  repro.sh                  the fast loop: one exception program, seconds per iteration
  try-compile.mjs           the compiler alone, under clang-wasm's toolchain (real FS)
  try-link.mjs              links what the compiler emitted, with lld.wasm, then runs it
  README.md                 the detailed blocker log — read this alongside §6

public/
  index.html                THE page: editor, Run/Stop, output, stdin box, phase timings
  demo-worker.js            the page's side of the package: a protocol and an output policy

packages/crystal-wasm/    THE language package (@live-codes/crystal-wasm)
  src/api.js                createCompiler / run / dispose — the public contract
  src/engine.js             compile → link → run, no browser-only API
  src/loader.js             which assets, in what order, with progress
  src/assets.js             hosted (baseUrl) or packaged, every read receipt-checked
  src/asset-receipts.js     the pin — generated by scripts/write-receipts.mjs
  src/index.js              browser entry; src/index.node.js reads the assets off disk
  bin/copy-assets.mjs       what a page-facing consumer runs once
  build-assets.sh           builds the payload; run by `npm run demo:assets`
  assets/crystal/           the payload, gzipped, gitignored
  vendor/browser_wasi_shim/ the WASI host and its filesystem (third-party, vendored)
  test/compiler.test.mjs    `npm test` — the whole chain under Node
  docs/ASSETS.md            what is in the payload, and how it is rebuilt and re-pinned

FINDINGS.md               §9 = libLLVM, §10 = the compiler
```

---

## 5. How to run each stage

**libLLVM** — not built here any more. It is a package
([`llvm-wasm`](https://github.com/live-codes/llvm-wasm), published as `@live-codes/llvm-wasm`), which
this repo installs as a devDependency rather than carrying. To *rebuild* it — on the order of an
hour — clone that repository and run its `build.sh` there:

```bash
WASI_SDK=/opt/wasi-sdk-33 bash build.sh          # all stages, in the llvm-wasm checkout
STAGE=verify WASI_SDK=/opt/wasi-sdk-33 bash build.sh
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
/root/emsdk/node/24.19.0_64bit/bin/node node_modules/@live-codes/llvm-wasm/verify/run-wasi.mjs exc.wasm
```

`llvm-objdump` from wasi-sdk disassembles wasm and is the tool that cracked the last step:
`/opt/wasi-sdk-33/bin/llvm-objdump -d exc.wasm` (look for `try`/`catch`/`rethrow` — their absence
was the whole bug).

**The page.** No WSL needed after the payload exists; the payload itself is built by the package's
`build-assets.sh` (`wasm-opt -Oz --enable-exception-handling` → `--strip-debug` at link → gzip →
receipts):

```bash
npm run demo:assets   # once, in WSL — builds packages/crystal-wasm/assets/crystal/
npm start             # → http://localhost:8127/
npm test              # the package's tests: the whole chain under Node, with stdin and argv
npm run check         # syntax-check the server, the worker and the package
```

To drive the page the way this repo's checks do (`agent-browser`): open it, then set `#sample`,
click `#run` and read `document.documentElement.dataset` — `runs` counts finished runs, `status`
is `idle`/`running`/`ok`/`error`, `exitCode` is the program's. All eight samples pass that way in
headless Chrome. A sample's source lives in a JS template literal, so any backslash in it must be
doubled and any backtick escaped — the regex sample is the one that bites.

**Start the server with `node serve.mjs`, not `npm start`, when you will have to stop it.**
`npm start` runs node as a *child*: killing the npm process leaves the server listening on 8127,
the next `npm start` fails to bind, and the old code keeps being served — which presents as a bug
in the file you just edited (this cost an hour: a `/packages/` route that 404'd because the server
predated it). Check with `Get-NetTCPConnection -LocalPort 8127 -State Listen`, from PowerShell.

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
  **`node --stack-size=4000`** (`try-compile.mjs` documents this). A browser cannot raise this — so
  the page build is `--release`, whose optimized frames pass 5/5 even at `--stack-size=700`.

**4. One EH proposal, not two.** LLVM 20 emits the **legacy** proposal (`try`/`catch`/`rethrow`) by
default; **wasi-sdk 33's libc++ uses the standardized one** (`try_table`/`throw_ref`). Linking our
object against those libraries yields a module containing **both**, which V8 rejects at validation
(*"module uses a mix of legacy and new exception handling instructions"*). The patch therefore also
passes **`-wasm-use-legacy-eh=false`** so everything is emitted for the standardized proposal. This
hid for a long time because `WebAssembly.compileStreaming` compiles lazily and never validated the
offending functions; a plain `WebAssembly.compile` (what the demo does) surfaces it immediately.

**Do not reintroduce these — they were wrong paths:**

- `{% if flag?(:wasm32) %}` in codegen — it is evaluated when the *compiler is built*, so a
  natively-built `crystal-native` takes the else branch. Use a runtime target check.
- A catch-all clause on a **`landingpad`** — wasm never lowers `landingpad`; the whole path is
  dropped. The catchpad is the shape (above).
- Relying on `--mattr=+exception-handling` to turn on wasm EH — it does not; `-wasm-enable-eh`
  does (part 2). `--mattr`/the `features +=` line only makes `try`/`catch` *selectable*.
- Treating the two stacks as one. `-z stack-size` will not fix a `RangeError`.
- Trusting a module because it *runs*: `WebAssembly.compileStreaming` validates lazily, so a module
  that mixes EH proposals appears fine until something calls `WebAssembly.compile`. Check the
  opcodes, not the run.
- Any declaration inside a statement-position `{% if %}` in Crystal source: it is not visible
  after `{% end %}`. Use expression-position macros or a runtime `if`.

---

## 7. What is left — the libLLVM split

Everything the page and the language package needed is done (§2). One artifact here is not Crystal's
and only a build machine ever wants it: libLLVM-for-wasm.

1. ~~**`@live-codes/crystal-wasm`**~~ **Done** — `packages/crystal-wasm/`, with the contract as
   planned (`createCompiler({ baseUrl, toolchain?, compileArgs?, args? })` → `run(code, input,
   { args?, files? })` → `{ ok, output, errors, exitCode, compileMs, runMs }`, receipt-pinned assets,
   a `crystal-wasm-copy-assets` bin), `files` and `args` in the first cut, and the page consuming it.
   Two things the plan left open and the implementation settled: the libraries are keyed **without**
   their `.gz` (`lib/libc.a`), because those keys become paths in the linker's filesystem; and a
   caller's `toolchain` replaces only the *linker* (its lld is the same program), while the sysroot
   libraries still come from this package.
2. ~~**`@live-codes/llvm-wasm`**~~ **Done.** The pipeline and its archives are their own
   repository, `D:\DevWork\live-codes\llvm-wasm`, **published as `@live-codes/llvm-wasm@0.1.0`**,
   with a `package.json`, a `llvm-wasm-path` bin
   so a build script can find them, a `prepack` check that refuses an incomplete `out/`, and the
   licences. **It is verified against the real consumer**: with `LLVM_WASM` pointing at the new
   repository, `link.sh` resolves every symbol, and the compiler it produces runs and reports
   `LLVM: 20.1.8` — i.e. those are the archives, not a copy that happens to be the right size.

   **Both follow-ups are done:** it is published, and this repo's `build/llvm-wasm/` copy is
   deleted — 2273 files, the ~140 MB that made a clone awkward — because a fresh clone can install
   what it needs. `link.sh` resolves in order `$LLVM_WASM`, a checkout beside this one, then the
   installed package; verified by linking the compiler from an install with nothing unpacked.

   Shape: the archives ship **gzipped, one file each** (`out/lib/*.a.gz`), which is the only form a
   page can use — `DecompressionStream` does gzip and nothing else, and one file per archive means a
   link fetches only what it names. `src/index.js` is the browser entry
   (`loadArchives({ baseUrl })` → verified, inflated bytes), `src/index.node.js` does the same off
   disk, and `llvm-wasm-unpack` inflates them in place for a link on disk. **There is no
   `postinstall`** — lifecycle scripts get blocked, so nothing runs at install time and the
   decompressing happens where it is used: `link.sh` inflates the archives into `$OUT/libLLVM` when
   it finds no plain ones. A single `.tar.xz` of the whole tree would be 22 MB against 37.7 — half
   again smaller — but a browser cannot open it, and the browser is the target, so the tarball
   carries that difference. `npm test` there (`scripts/check-load.mjs`) loads all 99 archives
   through the browser entry over HTTP, which is the path that has to keep working.
3. **Deliberately not now:** upstreaming the `browser_wasi_shim` file-growth fix (our patch exists
   only because upstream grows files quadratically — it needs network access); the wasm-only lld
   (see below — built, and *larger*); and further compiler trimming (11.8 MB gzipped is the floor for
   the whole compiler plus the whole standard library as wasm).

**Both packages load from a CDN in a browser, and that is verified, not assumed.** The target for
all of this is the page, so the shape of each payload is decided by what a page can inflate:

- `@live-codes/crystal-wasm` — its entry imported **by URL** (not by a local path), with `baseUrl`
  pointing at the package's own `assets/crystal/`, compiled and ran a program in headless Chrome:
  `caught: boom`, exit 0, 3.3 s. Its `files` list had to include `vendor/` or the published package
  could not load at all — that was a real bug until this was checked.
- `@live-codes/llvm-wasm` — its browser entry fetched, verified and inflated all 99 archives over
  HTTP (`npm test` there), and the same archives, packed into the tarball, extracted elsewhere and
  unpacked, still link the compiler.

**Both published packages load from a CDN in a browser, and that is verified, not assumed.** A page
on one origin imported the published entry from jsDelivr (`access-control-allow-origin: *`), pulled
all 22.8 MB from the CDN and ran a program: `caught: boom`, exit 0, no errors. (It took six minutes
here, which is this machine's link to jsDelivr — 22.8 MB at ~60 KB/s — not the package.)

**What is left, in order:**

1. **The compiler rebuild.** The `_Unwind_SetIP` binding mismatch (§8) is the last known correctness
   item: it needs a fresh `crystal.wasm` from WSL, a `npm run demo:assets` to re-pin the payload, and
   therefore a `0.1.1` publish. Small, but it invalidates the shipped receipts — batch anything else
   into it.
2. **The LiveCodes integration** — the point of all of it, and the one piece that lives in another
   repository: a `lang-crystal` module (an identity `factory`, `scriptType: 'text/crystal'`, the CDN
   `baseUrl`, `largeDownload: true`), in the shape `browser-nim`'s module has. Everything it needs is
   published now.

**Facts from the finished work, worth keeping** — they are in the log, not visible in the code:

- **`--release` is required, not an optimization.** `RELEASE=1 cross-compile.sh` adds `--release`
  (-O3 --single-module). It is 79 MB instead of 98 MB, but the real reason is the stack: the
  **debug** compiler needs more native stack than a browser gives (measured: `--stack-size=1000`
  fails, `1234` passes; a browser's V8 is ~1 MB and cannot be raised), while the **release** build
  passes 5/5 even at **700 KB**. With it, the whole flow runs at Node's *default* stack, which is
  the shape a browser has. If it ever regresses, the transformer's recursion depth is the thing to
  look at.
- **The payload is 22.8 MB gzipped**, from 68 MB raw (and 110 MB before the trimming started).
  `packages/crystal-wasm/build-assets.sh` does all of it: **`wasm-opt -Oz
  --enable-exception-handling`** on the linked module (59 → 35.5 MB raw; do *not* use `-all` — one of
  those passes emits a module V8 rejects, `unknown import kind 0x7e`), **gzip** (~4×, inflated by the
  loader with `DecompressionStream`), **`-Wl,--strip-debug`** in `link.sh` (79 → 59 MB, keeping the
  `name` section because named wasm stack traces are how this project debugs itself), and
  **dropping code nothing needs** — `compiler/` from the shipped stdlib, and `libc++.a` (a Crystal
  program is not C++; it needs libc++abi and libunwind for the EH runtime, which stay).
- **Most of what is left is `lld.wasm`** (7.8 MB): a *generic* lld that `wasm-opt` barely touches
  (20.80 → 20.38 MB). **A wasm-only lld was built and is not worth adopting** — it builds and
  validates (lld compiles for `wasm32-wasip1` almost unmodified once trimmed to the `wasm` driver)
  but comes out 27.9 MB raw / 9.8 MB gzipped, *larger* than the generic artifact, because lld's LTO
  is not separable by a flag (it is in `InputFiles.cpp`'s bitcode parsing, `Driver.cpp`'s target
  init, and `lld/Common`'s codegen flags) and dragging it in is a fork of lld. Numbers:
  [build/crystal-wasm/README.md](build/crystal-wasm/README.md#a-wasm-only-lld--built-and-not-adopted).
- **The link is done by `lld.wasm`, invoked as `wasm-ld`** (argv[0] dispatch — it is a generic
  driver), and its LLVM 22 links our LLVM 20 objects fine. It needs the `eh/` sysroot libraries
  (`libc++abi.a`, `libunwind.a` — the wasm personality and `_Unwind_*`), which clang-wasm's own
  bundled sysroot deliberately excludes, so they ship with the page. `try-compile.mjs` and
  `try-link.mjs` remain the smaller, independently-runnable proofs of each half.

---

## 8. Everything learned the hard way

**WASI gaps** (in the llvm-wasm package's `wasi-compat/` — that pipeline is its own repository now,
§7 — reuse them, don't rediscover them):

- `libdl.a` is an **empty stub** — `dlopen`/`dlclose`/`dlsym`/`dlerror` are stubbed in `compat.c`.
- The sysroot's `_Unwind_SetIP` returns `void` while Crystal's `LibUnwind` binding says `SizeT`;
  wasm-ld warns. Harmless — Crystal's personality is never called — and the page hides build
  chatter, but the binding is simply wrong: `set_ip` should be `Void`. **Scheduled** to be patched
  into `src/lib_unwind.cr` at the next compiler rebuild (§7), which removes the warning at source.
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
- **Measure the host before blaming the compiler.** A demo compile was 10–15 s and the wasm compiler
  looked like the reason; `--stats` showed it was `Codegen (bc+obj)` (8.8 s vs 0.23 s native), and
  per-syscall timing showed **110,599 `fd_write` calls taking 7.4 s**: `browser_wasi_shim` grows a
  file by reallocating and copying on every write past the end, so writing an object file is
  quadratic. Fixed in the package's `src/engine.js` (geometric growth, a separately tracked length,
  and trimming before anything reads) — **10.7 s → 4.2 s**. Parsing and semantic analysis had been
  within a few percent of native the whole time.

---

## 9. Commit log (`main`)

```
bb4fcca  One page, one pipeline: fold the samples in, drop the samples page
43919bd  Give the demo a stdin box
68428e0  Keep build chatter out of the output pane
ca3b5c0  Make a demo compile ~5x faster: the WASI host's file writes were quadratic
1ef5945  Record the wasm-only lld attempt: it builds, and it is not smaller
bbaced6  Shrink the compiler: 68 MB raw -> 35.5, payload 110 MB -> 23 MB gzipped
2f14efd  Make the demo shippable: 110 MB -> 27 MB, and one EH proposal
4e7e7dc  The compiler runs in the page: an editable demo
5227c13  Link in the WASI host, and make --release the page build
22a55d5  Wasm EH: the catch works — it needed -wasm-enable-eh, not just codegen
708b544  Add a handoff document for the next session
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
e6f8dd1  initial commit
```

## 10. Cautions

- **The hosting limits, and how to stay under them.** jsDelivr will not serve a package over 150 MB,
  and GitHub refuses a file over 100 MB. Measured: `@live-codes/llvm-wasm` is **37.7 MB on the wire,
  62.4 MB unpacked**, `@live-codes/crystal-wasm` is **22.8 MB**, and the largest file in either
  repository is **12.82 MB**. Re-check after any change to a payload with
  `npm pack <dir> --dry-run` (sizes and file count), and the largest files in a repository with
  `cd <repo> && git ls-files -z | xargs -0 stat -c '%s %n' | sort -rn | head`. The way to break it
  is to ship the plain archives again: `files` must list `out/lib/*.a.gz`, never `out/lib`.
- **`build/llvm-wasm/` is gone from this repository** — 2273 files, ~140 MB, deleted once
  `@live-codes/llvm-wasm` was published (§7). The pipeline and the archives live there now, and this
  repo installs the package as a devDependency. Note that git *history* still carries the blobs, so
  a fresh clone is no smaller unless the user chooses to rewrite it.
- `packages/crystal-wasm/assets/crystal/` (the payload, ~22 MB gzipped) is **not** committed —
  regenerate it with `npm run demo:assets` (or `npm run assets` inside the package) and re-pin with
  `node scripts/write-receipts.mjs`. The receipts in `src/asset-receipts.js` *are* committed, and
  `npm pack` refuses to publish without matching assets.
- There is one page (`public/index.html`) and no Docker pipeline; the samples are compiled by the
  page's own compiler, and there is no second WASI host.
- `.commandcode/taste/taste.md` is modified by the learning system — leave it alone.
- `D:\DevWork\live-codes\clang-wasm` is read-only for this work (as is `browser-nim`, whose package
  this one is shaped after).
- The working tree is clean; `build/crystal-wasm/README.md` is the detailed log and is kept
  current with each finding.
