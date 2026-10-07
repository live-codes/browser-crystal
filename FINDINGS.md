# Spike findings — Crystal in the browser

**Status: the runtime half works; the compiler half is blocked, and the block is not ours to
remove.**

Real Crystal programs run in the tab, with no server and no cross-origin isolation, and that is
verified end to end in headless Chrome (§1). But they have to be compiled *before* the page is
served, because **there is no way to run Crystal's compiler in a browser** (§2) — and a playground
whose editor cannot compile is not a language playground. Everything below was run, not inferred,
except where it says otherwise.

## 1. The pipeline, and the two steps Crystal does not do for you

```
source.cr
  → crystal build --cross-compile --target wasm32-unknown-wasi   → a wasm *object*
  → wasm-ld <object> -lc -L<wasi-sysroot> [-lpcre2-8]            → a WASI preview 1 module
  → instantiate in the tab                                       → output
```

`--cross-compile` is the whole story. It does not produce a runnable module — it produces an object
file and *prints* the link command it would have run:

```
wasm-ld hello.wasm -o hello  -lc -L/usr/bin/../lib/crystal
```

That command cannot work as printed: the official `crystallang/crystal` image ships **no `wasm-ld`
and no WASI sysroot** (§8 has the check). So the toolchain here adds `wasi-sdk` (for `wasm-ld`,
`crt1.o`, `libc.a`) and, for regex, a wasm build of PCRE2.

Three things about this target are worth knowing before reading the rest:

- **Nothing needs linking for the garbage collector.** `src/gc.cr` line 139 reads
  `{% if flag?(:gc_none) || flag?(:wasm32) %}` — on wasm32 Crystal selects its *no-GC* allocator
  itself, so the `-lgc` that a native build needs is absent here for free. (It also means memory is
  never reclaimed. For a short-lived playground program that is a fine trade; for a long-running one
  it is not.)
- **`Regex` needs PCRE2 built for wasm.** Crystal asks the linker for `-lpcre2-8`, and nothing
  provides a wasm build of it, so `build/Dockerfile` compiles PCRE2 10.42 from source against the
  same sysroot. Without it the link fails on `undefined symbol: pcre2_compile_8`. Only the 8-bit
  library is built: pcre2's default `make` target also builds `pcre2test`, which uses `getrlimit`
  and cannot compile for WASI.
- **The module is a plain WASI command.** It defines and exports its own memory, exports `_start`,
  and imports exactly eight functions — the entire host contract (§5).

### Verified working

Each row ran in headless Chrome through `public/index.html`, with `crossOriginIsolated === false`,
and the output pane read back. Timings are from the page's own status line.

| sample | what it covers | output | run |
| --- | --- | --- | --- |
| `01-hello` | strings, interpolation, ranges, `%w`, `#sum` | correct | 13 ms |
| `02-collections` | arrays, hashes, blocks, `sort_by`/`select`/`map`, `each_char` | correct | 54 ms |
| `03-types` | structs, classes, modules, generics, operator and method overloading | correct | 32 ms |
| `04-errors` | `nil`-returning methods, `case … when Nil`, safe indexing `[]?` | correct | 30 ms |
| `05-stdin` | `gets` over WASI `fd_read`, fed by the page's stdin box | correct | 46 ms |
| `06-regex` | `scan`, `gsub`, `\b\w{5}\b` — i.e. PCRE2 actually working | correct | 104 ms |

All six exit 0. `npm test` runs the same modules against Node's WASI implementation instead, which is
a *different* host from `public/wasi-preview1.js` — so it checks the artifacts, not the page.

## 2. The blocker: Crystal's compiler cannot run in a browser

This is the finding that decides the shape of the whole thing, so here is the reasoning rather than a
conclusion.

LiveCodes' own criteria say a language needs *"a compiler/runtime that runs client-side in the
browser (not on a remote server)"*. Crystal does not have one, and the reasons are structural:

- **The compiler is self-hosted and built on LLVM.** `crystal` is a Crystal program that links
  `libLLVM`. Compiling it to wasm32 would require libLLVM itself to exist for wasm32. It does not.
- **It shells out to a linker.** Even the successful cross-compile here is a *two-process* pipeline
  (`crystal` then `wasm-ld`). WASI preview 1 cannot spawn processes, so a wasm-hosted compiler could
  not run the second step — it could only emit an object and hand it to the host to link.
- **Its interpreter does not help.** Crystal has an official bytecode interpreter (`crystal i`,
  merged 2021), but it is a mode *of the compiler binary*, not a separate runtime, and it is still
  built with LLVM linked in. It is experimental, and many things do not work. There is no
  interpreter-only binary to port.
- **Nothing else is doing it.** Crystal appears in the "compile *to* wasm" column of
  [awesome-wasm-langs](https://github.com/appcypher/awesome-wasm-langs), on the strength of the
  cross-compile path used here ([PR #10870](https://github.com/crystal-lang/crystal/pull/10870) added
  initial WebAssembly output support). There is no Crystal compiler or interpreter in wasm, and no
  Crystal-to-JavaScript backend. Every "online Crystal playground" found is a hosted native compiler
  behind an HTTP endpoint — which is the thing LiveCodes does not allow.

So the honest summary: **Crystal today is a compile-to-wasm language whose compiler is native-only.**
That is enough to *run* Crystal in a browser and not enough to *compile* it in one.

What that costs a playground, concretely:

| | consequence |
| --- | --- |
| No compilation in the tab | the source pane is read-only; samples are fixed at build time |
| No compiler diagnostics | a typo cannot be reported, because nothing in the page can parse Crystal |
| No error markers, no formatter, no completions from the real compiler | they all need the compiler |
| Editing is not a feature that can be added later by wiring | it needs a wasm Crystal compiler to exist first |

The last row is the one that matters for planning. This is not a missing integration; it is a missing
upstream artifact.

## 3. The wasm target is broken in the current release

The pipeline above needs Crystal **1.17.0**. On **1.21.0** — the current release, 2026-07-16 —
*every* wasm build fails, before reaching any user code:

```
In /usr/share/crystal/src/crystal/event_loop/wasi.cr:2:1

 2 | class Crystal::EventLoop::Wasi < Crystal::EventLoop
     ^
Error: abstract `def Crystal::EventLoop#run(queue : ::Pointer(Fiber::List), blocking : Bool)` must be implemented by Crystal::EventLoop::Wasi
```

The compiler's **own standard library** does not compile for wasm32, so `crystal build
--target wasm32-unknown-wasi` cannot build *anything* — hello world included, with or without
`--no-debug`. This looks like a regression rather than a deliberate removal, and it is worth
reporting upstream; it also means any real integration has to pin a Crystal version, which is
uncomfortable for something the ecosystem is still calling experimental.

`build/Dockerfile` therefore pins `crystallang/crystal:1.17.0`, and `build/build-samples.mjs` says so
in its output.

## 4. Exceptions trap

`raise` does not unwind on this target. It prints a message and then hits `unreachable`:

```
EXITING: Attempting to raise:
below absolute zero (TemperatureError)
→ RuntimeError: unreachable
```

This is not a `--no-debug` artefact — the probe built the same program three ways and all three
trapped identically:

| build | size | raising an exception |
| --- | --- | --- |
| `--no-debug` | 527 KB | traps (`unreachable`) |
| default (debug info) | 645 KB | traps (`unreachable`) |
| `--release` | 370 KB | traps (`unreachable`) |

The probe program is the smallest thing that shows it — a raise that is caught:

```crystal
begin
  raise "boom"
rescue error
  puts "caught: #{error.message}"
end
puts "never reached"
```

Built and run three ways with the toolchain image (`$FLAGS` being each row above), it prints the
`EXITING: Attempting to raise:` banner and then traps — in every case:

```bash
docker run --rm --user root -v "$PWD:/project" -w /project crystal-wasm-toolchain:1.17 sh -c '
  crystal build /tmp/probe.cr --cross-compile --target wasm32-unknown-wasi $FLAGS -o /tmp/probe.o.wasm
  wasm-ld /tmp/probe.o.wasm -o /tmp/probe.wasm -L$WASI_SDK/share/wasi-sysroot/lib/wasm32-wasi -lc'
```

Crystal's exceptions are Itanium-ABI unwinding, and there is no unwinder in the picture: the link
line Crystal asks for includes no unwind library, and the DWARF call-frame information a wasm-side
unwinder would need isn't reachable through the browser either. There is no
`begin`/`rescue`/`ensure` in a Crystal playground on this target — which is why `04-errors` was
written the way it is, and why `raise`/`rescue` deserve a place in the limitations list of any
integration rather than a mention in a footnote.

## 5. No cross-origin isolation, and a tiny host contract

Both points were measured, not assumed.

**Isolation.** The module defines and exports its own linear memory and wasm-ld was not asked for
shared memory, so the parsed memory section reads `shared=false`:

| module | memories | shared | initial |
| --- | --- | --- | --- |
| `01-hello.wasm` | 1 | **false** | 4 pages |
| `06-regex.wasm` | 1 | **false** | 6 pages |

And the page confirms it from the other side: with `crossOriginIsolated === false` and
`typeof SharedArrayBuffer === "undefined"`, all six programs ran. So a Crystal result page can be
served from an ordinary CDN with no COOP/COEP headers, and needs no `SharedArrayBuffer` shim to get
there — the host here never mentions it.

**Host contract.** Across all six samples the union of imports is eight functions:

```
args_sizes_get  args_get  fd_fdstat_get  fd_fdstat_set_flags
fd_read  fd_write  proc_exit  random_get
```

That is all of `wasi_snapshot_preview1` that a Crystal program used here — no filesystem, no clocks,
no sockets, no `environ`. `public/wasi-preview1.js` implements them in about 120 lines, and refuses
loudly if a future module asks for something it does not have, rather than failing with
"function import requires a callable".

## 6. Payload

Built artifacts, committed, so a clone runs with no build step:

| sample | module |
| --- | --- |
| `01-hello` | 477 KB |
| `02-collections` | 630 KB |
| `03-types` | 546 KB |
| `04-errors` | 630 KB |
| `05-stdin` | 673 KB |
| `06-regex` | 914 KB |
| **total** | **3.8 MB** |

For comparison, the ~29 MB Clang toolchain that `browser-nim` and `browser-cobol` need is a different
order of magnitude entirely — Crystal's wasm output needs no compiler in the page, so what is
downloaded is the program and nothing else. Each module is served like any other static asset; the
page fetches nothing on a run that it has not already fetched, and the modules are cached by the
browser like any other file.

## 7. What this means for LiveCodes

- **`lang-crystal` does not meet the criteria yet.** Not because of licensing (Crystal is
  Apache-2.0) or popularity, but because of the client-side compiler requirement, and there is no
  workaround — the criteria exist precisely to exclude a hosted compiler.
- **If it is ever revisited, the runtime half is already solved and is small.** Everything in
  `public/wasi-preview1.js` and the run path in `public/crystal-worker.js` is what a language module
  would need; the module shape would follow `lang-haskell` — an identity `factory`, a
  `{{hash:lang-crystal-script.js}}` bundle, `scriptType: 'text/crystal'` — with `largeDownload:
  false` and no isolation headers (unusual, in a good way).
- **The two things to watch upstream** are the 1.21.0 regression (§3) and any movement on a wasm
  compiler or a standalone interpreter (§2). Until one of those lands, the interesting Crystal work
  in LiveCodes is on the ✗ side of the checklist.
- **What is genuinely reusable regardless:** the toolchain in `build/` (it is the only place a
  wasm32 Crystal build is fully specified — cross-compile, sysroot, `-lpcre2-8`), and the eight-function
  host contract in §5.

## 8. Reproducing

```bash
npm run build          # Docker: Crystal 1.17.0 + wasi-sdk 22 + PCRE2 → public/crystal/*.wasm
npm start              # → http://localhost:8127/   (no isolation; it is not needed)
npm test               # every sample, run under Node's WASI instead of the page's
npm run check          # syntax-check the server, the build script and the client modules
```

Docker is the only requirement for `npm run build`. To confirm the toolchain gap for yourself:

```console
$ docker run --rm crystallang/crystal:1.17.0 sh -c "which wasm-ld; ls /usr/bin/../lib/crystal"
libgc.a
```

— no `wasm-ld`, and the one library present is the x86-64 libgc that wasm32 does not use.

The browser run above was driven with the `agent-browser` CLI against headless Chrome. The page
exposes `document.documentElement.dataset` (`status`, `stage`, `runs`, `exitCode`, `ms`, `sample`)
and its element ids as globals, so the checks can read state and click Run without string literals.

## 9. Update — producing the libLLVM ourselves

A later effort stopped waiting for the missing artifact and set out to build it: `libLLVM`
compiled to `wasm32-wasip1`, the one thing Crystal's compiler has to link and that exists
nowhere to download. The pipeline is in [`build/llvm-wasm/`](build/llvm-wasm/); its live
status is [`build/llvm-wasm/STATUS.md`](build/llvm-wasm/STATUS.md). What it established:

- **The artifact has a reproducible path.** LLVM **20.1.8** — the newest release Crystal 1.17
  accepts — cross-compiled with **wasi-sdk 33** (clang 22 → wasm32-wasip1), WebAssembly backend
  only, static, threads/EH/RTTI off; host `llvm-tblgen` built natively. The cross **configure
  succeeds**, and `LLVMSupport` compiles apart from four files.
- **It is a port, not a build.** LLVM’s Unix support layer assumes an operating system that WASI
  preview 1 is not. Every edit is recorded in `build/llvm-wasm/patches/apply-patches.py`
  (platform detection, `endian.h`, `sys/wait.h`, `alarm`, `getsid`, and excluding the two
  unreferenced pure-OS files `CrashRecoveryContext.cpp` and `raw_socket_stream.cpp`).
- **What is left is bounded and named.** The four remaining files are the process/signal core —
  `Unix/Path.inc` (`pwd.h`), `Unix/Process.inc` (`rlimit`, `dup2`, `sigfillset`), `Unix/Program.inc`
  (`fork`, `execv`, `wait4`, `setsid`), `Unix/Signals.inc` (`sigaction`, `dladdr`). None of those
  symbols exist in wasi-libc, so they must be stubbed with the symbol present but failing;
  `STATUS.md` carries the exact error list to resume from.
- **The §2 conclusion stands, now sharper.** The blocker is neither licensing nor appetite: the
  compiler’s front end is fine, but the LLVM the compiler links has to be ported to a platform
  with no processes, signals or sockets. This is upstream-grade work — which is precisely why the
  artifact does not exist to download.

