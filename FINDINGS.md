# Spike findings — Crystal in the browser

**Status: answered — and the answer changed. This is the chronicle, in the order it happened.**

§1–§8 are the original spike, and everything in them was run, not inferred: real Crystal programs
run in the tab with no server and no cross-origin isolation (§1), but **Crystal's compiler could
not run in a browser** — that is what §2 concludes, and it is the finding this repository was built
to overturn. §9 records the first half of the overturning (libLLVM was built for `wasm32-wasip1`);
§10 the second (the compiler itself, in the page, compiling what you type). Read §2 as the problem
statement, not as the current state.

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
  provides a wasm build of it, so the spike's Dockerfile compiled PCRE2 10.42 from source against the
  same sysroot (`build/crystal-wasm/build-pcre2.sh` does it now). Without it the link fails on
  `undefined symbol: pcre2_compile_8`. Only the 8-bit library is built: pcre2's default `make`
  target also builds `pcre2test`, which uses `getrlimit` and cannot compile for WASI.
- **The module is a plain WASI command.** It defines and exports its own memory, exports `_start`,
  and imports exactly eight functions — the entire host contract (§5).

### Verified working

Each row ran in headless Chrome, with `crossOriginIsolated === false`, and the output pane read
back. In the spike these were modules compiled ahead of time; the same six samples now ship inside
the demo, compiled by the compiler on the page, and all eight of its samples pass there (§10).

| sample | what it covers | output | run |
| --- | --- | --- | --- |
| `01-hello` | strings, interpolation, ranges, `%w`, `#sum` | correct | 13 ms |
| `02-collections` | arrays, hashes, blocks, `sort_by`/`select`/`map`, `each_char` | correct | 54 ms |
| `03-types` | structs, classes, modules, generics, operator and method overloading | correct | 32 ms |
| `04-errors` | `nil`-returning methods, `case … when Nil`, safe indexing `[]?` | correct | 30 ms |
| `05-stdin` | `gets` over WASI `fd_read`, fed by the page's stdin box | correct | 46 ms |
| `06-regex` | `scan`, `gsub`, `\b\w{5}\b` — i.e. PCRE2 actually working | correct | 104 ms |

All six exit 0. In the spike `npm test` ran the same modules against Node's WASI implementation
instead — a different host from the page's hand-written one — so it checked the artifacts rather
than the page. That is the role `test/demo.mjs` plays now, except that it drives the page's own code
against the same assets the page fetches.

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

The spike's Dockerfile therefore pinned `crystallang/crystal:1.17.0`, and the pipeline in this repo
pins the same version for the same reason.

## 4. Exceptions trap *(superseded — §10 has the fix)*

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
no sockets, no `environ`. The spike's page implemented those eight in about 120 lines. The demo does
not, and cannot: the *compiler* needs a real filesystem to read the standard library from, so it uses
a full WASI host (`@bjorn3/browser_wasi_shim`, vendored) — and a compiled program is simply given an
empty one.

## 6. Payload — the spike's, and why it was not the answer

Built artifacts, committed, so a clone ran with no build step. **This is history:** those modules
were removed when the demo became the page, because a playground whose editor cannot compile is not
a playground — §10 pays 22 MB instead.

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

The demo trades that back deliberately: 22 MB gzipped, once, for a compiler that can compile whatever
you type — which is the better trade for a playground, and the trade `browser-nim` and `browser-cobol`
make too.

## 7. What this meant for LiveCodes *(written when the compiler half was blocked — §9–§10 changed the conclusion)*

- **`lang-crystal` did not meet the criteria then.** Not because of licensing (Crystal is
  Apache-2.0) or popularity, but because of the client-side compiler requirement, and there was no
  workaround — the criteria exist precisely to exclude a hosted compiler. **The wasm compiler removes
  exactly that objection**, which is why building it was worth the effort.
- **The runtime half was already solved and small**, and it is now a package rather than a page. The
  module shape would follow `lang-haskell` — an identity `factory`, a `{{hash:…}}` bundle,
  `scriptType: 'text/crystal'` — but with `largeDownload: true`, since a real compiler is a real
  download. [HANDOFF.md](HANDOFF.md) §7 has the packaging plan.
- **The two things worth watching upstream** are the 1.21.0 regression (§3) — still real; the
  compiler is pinned at 1.17.0 — and any movement on a wasm compiler or a standalone interpreter,
  which did not arrive, and is why this one was built here.
- **What is genuinely reusable:** the toolchain in `build/` (the only place a wasm32 Crystal build is
  fully specified — cross-compile, sysroot, `-lpcre2-8`), the libLLVM-for-wasm artifact (§9), the
  exception-handling patches (§10), and the eight-function host contract in §5 — which is what a
  *compiled Crystal program* needs, as opposed to what the compiler needs.

## 8. Reproducing

```bash
npm run demo:assets    # WSL: the compiler, the linker, the stdlib and the sysroot archives
npm start              # → http://localhost:8127/   (no isolation; it is not needed)
npm test               # the page's compile → link → run, under Node, with stdin
npm run check          # syntax-check the server and the client modules
```

The spike's build ran in Docker (Crystal 1.17.0 + wasi-sdk 22 + PCRE2), and that pipeline is gone —
the compiler in the page does the job now. The toolchain gap it worked around is still worth knowing:

```console
$ docker run --rm crystallang/crystal:1.17.0 sh -c "which wasm-ld; ls /usr/bin/../lib/crystal"
libgc.a
```

— no `wasm-ld`, and the one library present is the x86-64 libgc that wasm32 does not use.

The browser runs above were driven with the `agent-browser` CLI against headless Chrome. The page
exposes `document.documentElement.dataset` (`status`, `stage`, `runs`, `exitCode`, `ms`, `sample`)
and its element ids as globals, so the checks can read state and click Run without string literals.

## 9. Update — the libLLVM now exists

A later effort stopped waiting for the missing artifact and built it: `libLLVM` compiled to
`wasm32-wasip1`, the one thing Crystal's compiler has to link and that existed nowhere to
download. The pipeline is in [`build/llvm-wasm/`](build/llvm-wasm/); its status is
[`build/llvm-wasm/STATUS.md`](build/llvm-wasm/STATUS.md).

- **It works.** LLVM **20.1.8** — the newest release Crystal 1.17 accepts — builds for
  `wasm32-wasip1` with wasi-sdk 33 (clang 22), WebAssembly backend only: **99 static archives**,
  140 MB packaged. A probe linked against all of them runs inside a Node WASI engine, calls the
  LLVM C API, registers the wasm target and **constructs an IR module** — the compiler-side
  capability this whole question turned on. That artifact did not exist anywhere to download;
  it does now, reproducibly.
- **It was a port, not a build.** LLVM's Unix support layer assumes an operating system that WASI
  preview 1 is not. Every edit is in `build/llvm-wasm/patches/apply-patches.py`; the POSIX surface
  wasi-libc omits entirely (`sigaction`, `sigset_t`, `rlimit`, `<sys/wait.h>`,
  `fork`/`exec`/`wait`, `pwd`, `Dl_info`/`dladdr`, `fcntl` locks) is declared in
  `build/llvm-wasm/wasi-compat/include/` and stubbed in `wasi-compat/compat.c`. On WASI those
  stubs cannot do real work — there are no processes, signals or sockets — but a compiler does
  not need them to.
- **§2 is revised, not overturned.** Crystal's *own* compiler still cannot run in a browser
  without further work — but the reason it could not is now gone. The remaining task is the
  Crystal compiler port on top of a linkable wasm libLLVM, not the absence of one. §10 takes
  that further.

## 10. The Crystal compiler, in wasm

With libLLVM built (§9), the thing it was built for was attempted: the Crystal compiler
itself, compiled to `wasm32-wasip1`. The pipeline is in
[`build/crystal-wasm/`](build/crystal-wasm/); the detail is in its
[`README.md`](build/crystal-wasm/README.md).

**What works.** Using Crystal 1.17.0's own source and the wasm libLLVM, the compiler builds
(60 MB wasm object), links, and **runs** in a wasm engine:

```
$ node run-wasi.mjs crystal.wasm --version
Crystal 1.17.0
LLVM: 20.1.8
Default target: wasm32-unknown-wasip1
```

That LLVM is this repo's, not the host's 18. Run against a real filesystem (clang-wasm's
toolchain, via `try-compile.mjs`), it then reads the standard library, parses it, and
reaches semantic analysis and macro interpretation.

**What it took**, all recorded as idempotent patches in `apply-patches.py`:

| Blocker | Fix |
| --- | --- |
| `crystal docs` needs the `markd` shard | excluded with a new `without_docs` flag (mirroring Crystal's `without_playground`) |
| the interpreter/REPL needs `reply` | Crystal's existing `-Dwithout_interpreter` |
| libffi's ABI enum had no wasm32 entry | i386-unix values (wasm32 is ILP32) |
| the compiler's source loaded twice | `CRYSTAL_PATH` pinned at the patched copy — it refers to itself by `CRYSTAL_PATH` |
| `Signal` undefined in `process/status.cr` | the stdlib guarded the method *bodies* for `!wasm32` but not the return-type annotation |
| `Process.executable_path` block type in `config.cr` | made explicit for wasm |
| `crt1` `_start` clash | link with `-nostartfiles` — Crystal defines its own |
| `dlopen`/`dlclose`/`dlsym`/`dlerror` | wasi-libc's `libdl.a` is an empty stub; stubbed in the libLLVM compat layer |
| `Crystal::EventLoop::Wasi#open` | was a `NotImplementedError`; implemented over `LibC.open` |
| 64 KiB default stack | semantic analysis overflowed it; `-z stack-size=33554432` |
| PCRE for `Regex` | `build-pcre2.sh` cross-builds PCRE2; Crystal compiled with `-Duse_pcre2` |

**Exception handling on wasm — solved, in three parts.** It looked like a landing-pad problem
and was not.

1. *The runtime was stubbed — and is not any more.* `src/raise.cr` had four deliberate stubs for
   `wasm32` (`__crystal_personality`, `__crystal_raise`, `__crystal_get_exception` printed
   `"EXITING: …"` and exited, and `raise` called `LibIntrinsics.debugtrap`). Removing them,
   requiring `exception/lib_unwind` explicitly (wasm's `call_stack/null` does not pull it in) and
   adding the missing `CallStack.print_backtrace` made **`raise` a real wasm `throw`**.
2. *The catch is funclet IR, not a landing pad.* LLVM's wasm backend lowers the Windows-style
   funclet IR (`catchswitch`/`catchpad`/`catchret`, `llvm.wasm.rethrow`), so a wasm target takes
   Crystal's **msvc** path — but with a wasm-specific catchpad: one catch-all operand
   (`[ptr null]`), the exception fetched with `llvm.wasm.get.exception(token)`, and a
   `__gxx_wasm_personality_v0` personality. Crystal's Itanium `landingpad` is never lowered on
   wasm.
3. *The real blocker: the exception model is an LLVM `cl::opt`.* `WebAssemblyMCAsmInfo` selects
   `ExceptionHandling::Wasm` only when **`-wasm-enable-eh`** is set; `--mattr=+exception-handling`
   only toggles the subtarget feature. Unset, `TargetPassConfig` runs the `lowerinvoke` pass,
   which rewrites `invoke` → `call` and deletes the `catchswitch`/`catchpad` — the exception then
   escapes however correct the funclet IR is, and the disassembly shows a bare `throw` and no
   `try` (the `throw` being libunwind's, which is why it read as a landing-pad bug). clang's
   `-fwasm-exceptions` sets that option via `TargetOptions`, which the LLVM C API does not expose,
   so the compiler now sets it itself: `LLVM.parse_command_line_options(["crystal",
   "-wasm-enable-eh"])` in `codegen/target.cr`, before the target machine is built, plus
   `+exception-handling` in the features.
4. *One EH proposal, not two.* LLVM 20 emits the **legacy** proposal by default; wasi-sdk 33's
   libc++ is built with the **standardized** one (`try_table`/`throw_ref`). A module may not mix
   them — V8 rejects it at validation — so the compiler also passes `-wasm-use-legacy-eh=false` and
   everything is standardized. It stayed hidden because `WebAssembly.compileStreaming` validates
   lazily and the mix only fails when something forces full validation.

**The consequence that shapes the work:** the catchpad/personality come from whichever compiler
compiles the code, so the fix required a **patched compiler binary** — the host compiler rebuilt
from source (`bootstrap.sh`) and then used to cross-compile.

**It works, in the host and in a browser.** `begin`/`raise`/`rescue` on `wasm32-wasip1` prints
`caught: boom` / `done`; the wasm compiler compiles a program; and — with no host tool — clang-wasm's
`lld.wasm` links the object it emits and the result runs. [`public/index.html`](public/index.html) puts
the whole chain behind an editor: edit, press Run, and the compiler, the linker and the program all
run in the tab (~2 s a compile, verified in headless Chrome — it was 10–15 s until the WASI host's
quadratic file growth was fixed; see [build/crystal-wasm/README.md](build/crystal-wasm/README.md#where-the-compile-time-went)).
The compiler must be built
`--release`: the debug build needs ~1.2 MB of V8's *native* stack and a browser gives ~1 MB and
cannot be raised, while the optimized build fits in 700 KB. The full detail — including the
two-stacks trap (Crystal's linear stack vs V8's native stack, and why `-z stack-size` cannot fix a
`RangeError`) — is in
[`build/crystal-wasm/README.md`](build/crystal-wasm/README.md#resolution--the-wasm-catch-works).

**Still to do:** packaging, not capability. The payload is 22.8 MB gzipped (68 MB raw) — 11.8 MB of
it the compiler, 7.8 MB the linker, which is a *generic* lld. A wasm-only lld was built and is *not*
smaller (27.9 MB raw: lld's LTO is not separable by a flag), so what remains is a `crystal` language
package for LiveCodes — [HANDOFF.md](HANDOFF.md) §7.

**The honest headline.** The question this document opened with — can Crystal's compiler run in
a browser — is now answered in the affirmative: libLLVM-for-wasm exists and is verified; the
compiler runs, reads the standard library, catches exceptions, and compiles a program to a wasm
object that links and runs. What stands between that and an editable playground is the browser
linking/UI work — not a gap in Crystal's own codegen.

