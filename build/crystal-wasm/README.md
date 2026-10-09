# Crossing the Crystal compiler to wasm

This is where the **"validate, then split"** plan starts: build the Crystal
compiler itself as a `wasm32-wasip1` module, linked against the libLLVM produced
in [`../llvm-wasm`](../llvm-wasm). If that links, the libLLVM package's interface
is proven by a real consumer and the split is safe.

**Status: the compiler runs, reads the stdlib, and compiles a program to a wasm
object that links and runs — exceptions included.** (See "Resolution" below; the
earlier narrative is kept as the log of how it was found.) What remains is the
*browser* side: `lld` inside the page, and shipping the stdlib and a wasm sysroot
as assets. This was a port of the compiler's environment — the same shape as the
libLLVM port.

## What has to be true for this to work

1. **A native Crystal 1.17.0** to drive the cross-compile. The distribution's own
   source is used (`share/crystal/src`), so no separate checkout is needed.
2. **The LLVM bindings pointed at the wasm libLLVM**, not the host's. Crystal
   picks its binding set from `llvm-config --version` and `--targets-built`, and
   takes link flags from `LLVM_LDFLAGS`; the host's `llvm-config` reports LLVM 18,
   but the target libLLVM is 20.1.8. `cross-compile.sh` sets `LLVM_CONFIG`,
   `LLVM_VERSION` and `LLVM_TARGETS` to keep them apart.
3. **The compiler's non-core tools dropped** — `crystal docs` and `crystal play`
   pull the `markd` shard (a binding to the md4c C library), which has no place
   in a wasm build.
4. **The stdlib the compiler itself uses** made to compile for `wasm32` — `File`,
   `Dir`, `Process`, the event loop. This is the open-ended part.
5. **A runtime host**: an in-memory filesystem to read sources and write emitted
   objects, plus `lld` to link them — the same problem the page's WASI host solves
   for running programs, one level up.

## Where it stands

**The Crystal compiler builds for `wasm32-wasip1`, links against the wasm
libLLVM, and runs.**

```
$ node run-wasi.mjs crystal.wasm --version
Crystal 1.17.0

The compiler was not built in release mode.

LLVM: 20.1.8
Default target: wasm32-unknown-wasip1
```

`crystal.wasm` is 94 MB — a 60 MB wasm object linked against
`../llvm-wasm/out/lib/*.a`, a wasm PCRE2, and the compat layer. It reports
**LLVM 20.1.8**, i.e. our wasm libLLVM rather than the host's 18, and its
default target is the wasm triple.

That is the validation the split decision was waiting for, and more: the libLLVM
is sufficient for a real, *running* consumer. What remains is not the compiler
binary but the environment it needs in order to compile something — a filesystem
holding the standard library and the sources, and `lld` to link what it emits.
That was the same problem the page's WASI host solved for running programs, one
level up — and it is solved below, in the demo.

| Blocker | State |
| --- | --- |
| `-Di_know_what_im_doing`, `without_docs`, `without_interpreter` | handled |
| `markd` / `reply` shards | excluded (new `without_docs` flag; existing `without_interpreter`) |
| libffi ABI enum had no wasm32 entry | patched — i386-unix values, wasm32 is ILP32 |
| Compiler source loaded twice (`CRYSTAL_PATH`) | fixed: pinned at the patched copy |
| `Signal` undefined in `process/status.cr` | patched: guard the whole methods, annotation included |
| `Process.executable_path` block type in `config.cr` | patched for wasm |
| `crt1` `_start` clash | link with `-nostartfiles` — Crystal defines its own `_start` |
| `dlopen`/`dlclose`/`dlsym`/`dlerror` (libdl.a is empty on WASI) | stubbed in the libLLVM compat layer |
| PCRE for `Regex` | done: `build-pcre2.sh` cross-builds PCRE2 for wasm, and Crystal is compiled with `-Duse_pcre2` |
| Runtime host (filesystem + lld) | not yet reached — the compiler runs, but cannot yet read sources |

Every source edit is in `apply-patches.py` and idempotent, so a Crystal version
bump fails loudly at the first drift rather than building something subtly wrong.

### The PCRE note, specifically

Crystal chooses its regex engine in `regex/engine.cr`: `-Duse_pcre2` forces
PCRE2, otherwise it probes the *host's* `pkg-config` for `libpcre2-8` and falls
back to PCRE1. Cross-compiling, it fell back to PCRE1 — so the object references
`pcre_compile`, `pcre_exec`, `pcre_fullinfo`, `pcre_study`, `pcre_free`,
`pcre_get_stringtable_entries`. Either engine works, but the matching PCRE has to
be built for `wasm32-wasip1`; `build-pcre2.sh` does exactly that, and PCRE2 is the
one the demo links.

### After PCRE

The compiler binary is done; what it needs to *compile something* is not. Working
the fastest path — reusing `clang-wasm`'s toolchain for the WASI filesystem —
`try-compile.mjs` runs the real compiler against the real stdlib, and each step is
recorded:

1. **`Crystal::EventLoop::Wasi#open` was a `NotImplementedError` stub**, so a
   Crystal program on wasm could not open a file at all — which a compiler must.
   Patched (`apply-patches.py`): `open` over `LibC.open`, which wasi-libc resolves
   against the preopened directories, exactly as every other event loop does. The
   compiler now reads its sources.
2. **The default wasm stack is 64 KiB.** Semantic analysis overflowed it —
   `memory access out of bounds` inside a recursive `MathInterpreter`. The link now
   passes `-z stack-size=33554432`.
3. **Then exceptions.** The compiler parses the standard library, enters macro
   interpretation, and `{% skip_file %}` raises `Crystal::SkipMacroException` —
   which cannot unwind on wasm:

```
RuntimeError: unreachable
  at *raise<Crystal::SkipMacroException>
  at *Crystal::MacroInterpreter#interpret_skip_file
```

This is §4 of FINDINGS again, and the codegen half turns out to be *already
possible*:

- The WebAssembly target machine **forces** `ExceptionModel = Wasm` itself
  (`WebAssemblyTargetMachine.cpp:430`, from `WebAssemblyMCAsmInfo.cpp:54`), so
  nothing needs the LLVM `TargetOptions` the C API cannot set.
- Crystal exposes `--mattr`, so the `+exception-handling` subtarget feature can be
  asked for without patching the compiler: `cross-compile.sh` now passes
  `--mattr=+exception-handling`.
- wasi-sdk ships the runtime: `-fwasm-exceptions` selects the `eh` sysroot, and
  `link.sh` adds `-lunwind` for `_Unwind_RaiseException`, `__cpp_exception` and
  friends. That link line now resolves.

**The blocker is four deliberate stubs in `src/raise.cr`.** Crystal 1.17 does not
implement exceptions for `wasm32` at all — it prints and exits:

```crystal
{% elsif flag?(:wasm32) %}
  fun __crystal_personality ...   # "EXITING: __crystal_personality called"; LibC.exit(1)
  fun __crystal_raise(ex) ...     # "EXITING: __crystal_raise called";       LibC.exit(1)
  fun __crystal_get_exception ... # "EXITING: __crystal_get_exception called"; LibC.exit(1)
{% end %}

{% if flag?(:wasm32) %}
  def raise(exception) : NoReturn
    Crystal::System.print_error "EXITING: Attempting to raise:\n%s\n", ...
    LibIntrinsics.debugtrap       # <- the `unreachable` we keep hitting
    LibC.exit(1)
  end
{% else %}
  ...the real raise, excluded for wasm...
{% end %}
```

Those four are now removed in `apply-patches.py`, so wasm uses the same
implementations as every other platform (with `exception/lib_unwind` required
explicitly, since `call_stack/null` does not pull it in, and a no-op
`CallStack.print_backtrace` added to `null.cr`). **`raise` now performs a real
wasm `throw`** rather than trapping — the runtime wiring works.

4. **But the throw is not caught, so it escapes the module:**

```
Exception [WebAssembly.Exception] {}
```

Because Crystal's landing pads carry **no clauses**, and its own personality is
what fills the landing pad's second slot with the exception's *type id*:

```crystal
lp = builder.landing_pad lp_ret_type, main_fun(personality_name).func, [] of LLVM::Value
unwind_ex_obj = extract_value lp, 0
exception_type_id = extract_value lp, 1   # set by __crystal_personality
```

On wasm `_Unwind_CallPersonality` calls **libc++abi's** `__gxx_personality_wasm0`
instead (it is hardcoded in `Unwind-wasm.c`), which finds no clause to match →
selector 0 → rethrow. Crystal's MSVC path already does the right thing — read the
exception and compute the type id at runtime — so the fix is to give wasm that
shape: **a landing pad with a catch-all clause, and dispatch on the exception's
runtime type id.**

That is a change to `compiler/crystal/codegen/exception.cr`, so it also needs a
**patched Crystal binary**: landing pads are generated by whichever compiler
compiles the code, so the host compiler must be built from source with the patch
before it can cross-compile the wasm compiler.

**Everything else is done** — libLLVM, PCRE, the link, the filesystem host, the
compiler running, reading sources, parsing, semantic analysis, and now a real
wasm throw.

## The codegen patch, and why it needs a bootstrap

`apply-patches.py` gives the wasm landing pads a catch-all clause and reads the
type id off the exception object instead of the pad's selector slot — the shape
Crystal's own **msvc** path already uses:

```crystal
{% if flag?(:wasm32) %}
  lp = builder.landing_pad lp_ret_type, main_fun(personality_name).func, [LLVM::Value.null]
  unwind_ex_obj = extract_value lp, 0
  caught_exception_ptr = call get_exception_fun, [get_exception_arg]
  caught_exception = int2ptr caught_exception_ptr, llvm_typer.type_id_pointer
  exception_type_id = load llvm_typer.type_id_pointer, caught_exception
{% else %}
  lp = builder.landing_pad lp_ret_type, main_fun(personality_name).func, [] of LLVM::Value
  exception_type_id = extract_value lp, 1     # our personality fills this
{% end %}
```

`LLVM::Value.null` as the only clause is LLVM's catch-all (`LLVMAddClause` with a
null value), which is what makes libc++abi's personality enter the pad. The
exception object begins with its type id, so `load` gives the same value Crystal's
personality used to write into the pad.

**This is the point where the fix changes the compiler, not the program.** The
landing pads above are emitted by *whichever* compiler compiles the code, so
patching the source handed to the distribution's compiler is not enough — its
codegen is fixed. The compiler has to be rebuilt from the patched source and then
used. `bootstrap.sh` does that:

```bash
# $OUT/src is the patched source; builds a native compiler from it
OUT=/root/bc-crystal bash build/crystal-wasm/bootstrap.sh   # → $OUT/bin/crystal-native
# then cross-compile with CRYSTAL=$OUT/bin/crystal-native
CRYSTAL=/root/bc-crystal/bin/crystal-native bash build/crystal-wasm/cross-compile.sh
```

The bootstrap runs natively, so the wasm LLVM pinning (`LLVM_CONFIG`,
`LLVM_VERSION`, …) is unset for it and the distribution's own `llvm-config` is
used. Two things it needs, which the first attempt ran into:

- a native LLVM that Crystal 1.17 supports (8–20). `find-llvm-config.sh` takes the
  first on `PATH`, which here was `llvm-config-21`, so `bootstrap.sh` picks a
  supported one explicitly. This machine has only `llvm-21` (and an
  `llvm-18` tree with no `bin/llvm-config`), so it needs
  `apt-get install llvm-20-dev` (available in Ubuntu 24.04 as 20.1.2) to have a
  usable `/usr/lib/llvm-20/bin/llvm-config`.
- the native development libraries: `apt-get install libpcre3-dev libgc-dev`
  (the first attempt failed at `cannot find -lpcre`).

## Compiling on the page — what is still needed

> **Superseded for the exception part — see "Resolution" at the end.** The
> subsections below are the log of how the blocker was chased down; where they
> contradict "Resolution", the latter is what actually works.

### Latest state: the catch-all clause, and a verifier crash

The codegen patch now branches on `@program.target_machine.triple` (a **runtime**
check). That mattered: the first version used `{% if flag?(:wasm32) %}`, which is
evaluated when the *compiler is built*, so a natively-built `crystal-native`
compiled the else branch and kept emitting clause-less pads.

With a real catch-all clause the bootstrapped compiler now **crashes while
verifying the module** (`rc=11`):

```
LLVMVerifyModule → llvm::Value::print → SIGSEGV
```

So the pad was invalid. Two things were wrong, both now fixed and both named by
LLVM's verifier once it stopped segfaulting:

1. **The catch-all clause** was a null *ValueRef*; it is now a null `i8*` constant
   (`llvm_context.int8.pointer.null`), which is how LLVM's own IR spells it.
2. **The type-id load** used the pointer type where the value type was meant —
   `load llvm_typer.type_id_pointer, …` loads a *pointer*, and the verifier said so
   exactly:

```
Both operands to ICmp instruction are not of the same type!
  %7 = icmp eq i32 %6, ptr %5
 i32  %9 = call i1 @"~match<IO::Error+>"(ptr %8)
```

   It loads `llvm_context.int32` now, which is what `~match<…>` and the `icmp` want.

With both fixed the module **verifies**, the compiler builds, and it links — and
the exception **still escapes uncaught** (`Exception [WebAssembly.Exception] {}`),
so the catch is not taking effect. Where to look next:

- **Is the catch generated at all?** Dump the emitted wasm (or the pre-codegen IR)
  and check whether the function containing the rescue has a `try`/`catch` and
  whether the landing-pad block calls `_Unwind_CallPersonality`. If the pad is
  still lowered as a cleanup, the clause is not reaching it.
- **Does the rescue match?** If the pad *is* entered, `match_any_type_id` decides
  from the type id read at the exception pointer; if that value is wrong the rescue
  falls through and Crystal re-raises — which also escapes. Worth checking against
  a known type id.
- **The `_Unwind_SetIP` mismatch below** is unresolved and may matter: Crystal's
  `LibUnwind` bindings assume the Itanium signatures, while libunwind's wasm port
  returns `void` from `_Unwind_SetIP`. Harmless if Crystal's personality is never
  called (which is the case on wasm), but it means the bindings do not match the
  library and should be reconciled.

A minimal repro made this much faster to work on — `begin / raise / rescue` in a
three-line program compiles and links in seconds (`sh_exc.sh` upstream of this
note), instead of the 25-minute compiler cycle. Disassembling it settled the
question the compiler could not: the module contained a **`throw 0` and no
`try`/`catch` at all**, so the landing pad was simply dropped.

**That is because wasm EH in LLVM uses the *funclet* representation** —
`catchswitch`/`catchpad`, lowered to `catch __cpp_exception`
(`WebAssemblyISelDAGToDAG.cpp`) — which is exactly Crystal's **msvc** path, not its
landing-pad path. The patch therefore gives the wasm target the msvc branch
(`msvc = @program.has_flag?("msvc")` is a runtime flag check, so a wasm target can
join it).

That gets further — it compiles to `codegen_re_raise` and stops on a
`NilAssertionError`:

```
Nil assertion failed (NilAssertionError)
  from src/compiler/crystal/codegen/exception.cr:304 in 'codegen_re_raise'
```

`codegen_re_raise` branches on `@program.has_flag?("msvc")` while its *caller* now
branches on `funclet_eh`, so on wasm the caller takes the funclet path (where
`unwind_ex_obj` is never assigned) and the callee takes the non-funclet path and
asserts on it. The funclet ensure-catchpad also never captures the exception, and
the msvc re-raise is `_CxxThrowException` — Windows-only. So finishing this needs
the wasm funclet path to capture the caught exception and re-raise it through
`__crystal_raise`, rather than Crystal's Windows re-raise.

```
wasm-ld: warning: function signature mismatch: _Unwind_SetIP
>>> defined as (i32, i32) -> i32 in crystal.o.wasm
>>> defined as (i32, i32) -> void in .../eh/libunwind.a(Unwind-wasm.c.o)
```

Everything else is ready: the bootstrap builds, the cross-compile runs with the
patched compiler, and the link resolves (only a benign `_Unwind_SetIP` signature
warning, from libunwind's wasm `_Unwind_SetIP` returning void where Crystal's
binding says `SizeT`).

| Piece | State |
| --- | --- |
| The compiler as wasm | done — `crystal.wasm`, runs |
| A WASI filesystem host | done on the prototype path — `clang-wasm`'s toolchain (memfs), via `try-compile.mjs` |
| Crystal's WASI file `open` | patched — the compiler reads sources |
| Stack size for deep recursion | patched at link — 32 MiB (tunable: `STACK_SIZE`) |
| **Exceptions on `wasm32-wasip1`** | **done — see "Resolution" below** |
| Compiling a program → object | **done** — `try-compile.mjs` emits `out.o.wasm` |
| Linking the emitted object (`lld`) | **done in the WASI host** — `try-link.mjs` drives clang-wasm's `lld.wasm`; its LLVM 22 links our LLVM 20 object |
| stdlib (1552 `.cr`, 15 MB) + wasm sysroot as assets | collected, not yet shipped |
| The page: editable editor → compile → link → run | needs the UI, and the assets |

## Resolution — the wasm catch works

The two codegen edits above turned out to be only part of it. The blocker was
resolved in three parts, all in `apply-patches.py`:

1. **The funclet shape, not the landing pad.** LLVM's wasm backend lowers the
   *Windows-style funclet* IR (`catchswitch`/`catchpad`/`catchret`), never an
   Itanium `landingpad`, so a wasm target has to take Crystal's **msvc** code path
   (`funclet_eh = msvc || wasm_target`). But wasm's catchpad is shaped differently
   from msvc's: a single catch-all operand (`[ptr null]`) and the caught exception
   from `llvm.wasm.get.exception(token)`, which `WasmEHPrepare` rewrites to the
   wasm `catch` instruction — *not* msvc's three-operand catchpad with a
   catch-object slot. `codegen_re_raise` then re-raises with **`llvm.wasm.rethrow`**
   (there is no `_CxxThrowException` on wasm), and both the rescue and the
   ensure-re-raise pads use that shape. A wasm personality
   (`__gxx_wasm_personality_v0`) is set on every function that owns a catchpad.
   `codegen_re_raise` branches on the *same* predicate as its caller — that
   mismatch was the `NilAssertionError`.

2. **The exception model is an LLVM option the C API cannot set.**
   `WebAssemblyMCAsmInfo` only selects `ExceptionHandling::Wasm` when the LLVM
   `cl::opt` **`-wasm-enable-eh`** is set (`WebAssemblyMCAsmInfo.cpp:53`).
   `--mattr=+exception-handling` only toggles the subtarget feature — it does not
   select the model. With the model at `None`, `TargetPassConfig` runs the
   **`lowerinvoke`** pass, which rewrites every `invoke` to a `call` and deletes
   the `catchswitch`/`catchpad`: the exception then escapes no matter how correct
   the funclet IR is. clang's `-fwasm-exceptions` sets the same option through
   `TargetOptions`, which the C API does not expose, so the compiler flips it
   itself — `LLVM.parse_command_line_options(["crystal", "-wasm-enable-eh"])`
   before the target machine is built (`codegen/target.cr`), and appends
   `+exception-handling` to the features. This is the single change that made the
   difference; it fixes both the native compiler (against the host LLVM) and the
   wasm compiler (against our libLLVM).

3. **Two V8/Node stacks, and only one of them is the module's.** The compiler's
   AST passes (semantic analysis, then `CleanupTransformer`) recurse deeply. Two
   separate stacks are involved:
   - Crystal's allocas live on the wasm **linear-memory stack** — the one
     `-Wl,-z,stack-size=33554432` sizes. Exhausting it is a
     `memory access out of bounds` trap.
   - The wasm **call frames** live on V8's **native** stack. Deep recursion there
     raises `RangeError: Maximum call stack size exceeded`, and *no* `-z
     stack-size` value helps. Node's default native stack is ~1 MiB, far below the
     8 MiB a native build gets, so the transformer overflows it
     **non-deterministically** (Crystal's hashes are randomly seeded, so the
     traversal order — and depth — varies run to run). The debug compiler needs
     **more than a browser gives**: measured, `--stack-size=1000` fails and `1234`
     passes, and a browser's V8 stack is ~1 MiB with no way to raise it. This is
     why the page build is **`--release`**: the optimized compiler passes 5/5 even
     at `--stack-size=700` (and is 79 MB instead of 98 MB). See below.

4. **One EH proposal, not two.** This one cost the most time to see. LLVM 20 emits
   the **legacy** wasm EH proposal (`try`/`catch`/`rethrow`) by default — the
   `WasmUseLegacyEH` cl::opt's own comment says *"Currently set to true by default
   because not all major web browsers turn on the new standard proposal by
   default, but will later change to false"* — while **wasi-sdk 33's libc++ is
   built with the standardized one** (`try_table`/`throw_ref`: 1430 and 1007 uses
   in `libc++.a`). Linking our object against those libraries produces a module
   containing **both**, and a module may not: V8 rejects it at validation with
   *"module uses a mix of legacy and new exception handling instructions"*. The
   patch therefore also passes **`-wasm-use-legacy-eh=false`**, so everything is
   emitted for the standardized proposal — the one LLVM's comment says browsers
   are moving to, and the one wasi-sdk's libraries already use.

   It hid for a long time because `WebAssembly.compileStreaming` compiles
   lazily: a lazy host never validates the offending functions, so the mixed
   module appeared to work. It surfaces as soon as anything validates eagerly —
   a plain `WebAssembly.compile`, which is what the demo does after inflating its
   assets. If EH ever starts failing "for no reason", count the opcodes:
   `crystal.wasm` must contain no legacy `try`/`catch` at all (it is 4983
   `try_table` + 1025 `throw_ref`), and `out.o.wasm` and the linked module must
   agree with each other.

**The reproducible end state** (all from `apply-patches.py`; see `HANDOFF.md`):

```
$ bash repro.sh
caught: boom
done

$ node --stack-size=4000 try-compile.mjs      # crystal.wasm compiles main.cr
exitCode: 0
out.o.wasm: 508917 bytes

$ clang --target=wasm32-wasip1 --sysroot=… -fwasm-exceptions -o out.wasm out.o.wasm -lc++ -lc++abi -lunwind …
$ node …/run-wasi.mjs out.wasm
hello from the wasm Crystal compiler
```

That is the whole pipeline: a program is compiled *by the wasm compiler*, and the
object it emits links and runs.

## Linking inside the host — the lld step

The link above used the host's `clang`/`wasm-ld`. A page has neither, so
**`try-link.mjs`** does the same link with clang-wasm's **`lld.wasm`**, run as a
WASI command in the same host the compiler runs in — no host tool involved:

```
$ node try-link.mjs
loading lld.wasm …
linking with lld.wasm …
link exitCode: 0
out.wasm: 817734 bytes
running the linked program in the same host …
run exitCode: 0
hello from the wasm Crystal compiler
```

Two things this settles:

- **The linker runs in the host.** `lld.wasm` is a *generic* lld driver and
  dispatches on `argv[0]`, so it must be told it is `wasm-ld` (the manifest
  records `"argv0": "wasm-ld"` too). It then takes the object and the libraries
  as its filesystem.
- **The versions compose.** clang-wasm's lld is **LLVM 22.1.8**; our compiler (and
  the libLLVM it links) is **LLVM 20.1.8**. Its object from LLVM 20 links with the
  LLVM 22 linker.

The libraries are the ones clang's driver passes under `-fwasm-exceptions`, and
the **`eh/` variants matter**: `libunwind.a`'s `_Unwind_RaiseException` is a real
`wasm throw` and libc++abi supplies `__gxx_wasm_personality_v0`. clang-wasm's own
bundled sysroot deliberately excludes `eh/` (it builds a non-EH libc++), so those
came from wasi-sdk-33 directly.

## The demo — the whole chain behind an editor, and the package that carries it

`public/index.html` is this pipeline as a page you can type into, and everything it knows about
compiling Crystal lives in [`packages/crystal-wasm/`](../../packages/crystal-wasm) —
`@live-codes/crystal-wasm`, the language package:

```
public/index.html       the editor, Run/Stop, output, phase timings, and a stdin box
public/demo-worker.js   the page's side of the package: a protocol and an output policy

packages/crystal-wasm/
  src/engine.js         compile → link → run; no browser-only API
  src/api.js            createCompiler / run / dispose — the contract a language module calls
  src/loader.js         which assets, in what order, with progress
  src/assets.js         hosted (baseUrl) or packaged, every read receipt-checked
  src/index.js          the browser entry; src/index.node.js reads the assets off disk
  vendor/browser_wasi_shim/   the WASI host and the filesystem the compiler needs
  build-assets.sh       builds the payload below into assets/crystal/ (gitignored)
  test/compiler.test.mjs      `npm test` — the exact code the page runs, under Node
```

`engine.js` is deliberately the same logic as `try-compile.mjs` + `try-link.mjs`, expressed once
with no Node API — so the package's tests run the exact code the page runs, against the exact
assets it fetches, and the worker adds only the protocol between them. The program's fd 0 is a file
holding the page's stdin box, so a program that calls `gets` reads what is typed there; the compiler
and the linker are given the empty string, since neither reads stdin at all.

`build-assets.sh` collects the payload into `assets/crystal/` (gitignored), **gzipped**, because the
loader inflates it itself with `DecompressionStream` — no server configuration, any static host:

| | raw | gzipped |
| --- | --- | --- |
| `compiler.wasm` (`--release`, `--strip-debug`, `wasm-opt -Oz`) | 35.5 MB | 11.8 MB |
| `lld.wasm` (clang-wasm's) | 21 MB | 7.8 MB |
| `stdlib.json` (the patched stdlib, 1369 files) | 6.3 MB | 1.3 MB |
| `lib/…` (sysroot, PCRE2, clang_rt — no libc++) | 5.4 MB | 1.7 MB |
| **total** | **68 MB** | **22.8 MB** |

Each of those is checked against a SHA-256 receipt on every read
(`packages/crystal-wasm/src/asset-receipts.js`, written by `scripts/write-receipts.mjs`), and
`npm pack` refuses to publish without matching assets.

Four things did that, in order of size:

- **`wasm-opt -Oz`** on the linked module: 59 → 35.5 MB raw (14.5 → 11.8 MB
  gzipped). It rewrites *everything*, including libLLVM's and libc++'s code, so it
  does more than any Crystal-side flag could. Not `-all`, though: one of those
  passes emits a module V8 rejects (`unknown import kind 0x7e`). It also drops the
  `name` section — that is the 40% of raw bytes the browser no longer has to
  compile, and `link.sh`'s `crystal.wasm` still has them for debugging.
- **gzip** (~4×), which the page inflates itself, so no server configuration.
- **`--strip-debug`** at link (79 → 59 MB): DWARF, and deliberately *not* the
  `name` section — `--strip-all` would save another 12 MB raw but only 1 MB
  gzipped, and named wasm stack traces are how this project debugs itself.
- **Dropping code nothing needs**: `compiler/` from the shipped stdlib (3.5 MB of
  9.5 MB — a program being compiled never requires it) and **`libc++.a`** (2.7 MB
  gzipped). A Crystal program is not C++; what it needs from the C++ runtime is
  the wasm EH personality and `_Unwind_*`, which are libc++abi and libunwind. The
  compiler's own link echo confirms it: `wasm-ld out.o.wasm -o out.o -lc`.

What is left is mostly `lld.wasm` — 7.8 MB of the 22.8, because it is a *generic*
lld (ELF, COFF, Mach-O and wasm).

### A wasm-only lld — built, and not adopted

That looked like the next win, so it was attempted from this repo's own LLVM 20
source. It *works*: `-DLLVM_ENABLE_PROJECTS=lld` configures into the cross build,
`lldCommon` + `lldWasm` compile for `wasm32-wasip1` once `lld/tools/lld/CMakeLists.txt`
and `lld.cpp` are trimmed to the one driver, and the result validates in V8.

It is **not smaller**: 27.9 MB raw / 9.8 MB gzipped against the generic artifact's
20.8 / 7.8. Two findings say why, and they are the reason it is not adopted:

- **lld's LTO is not a flag.** Removing it means patching `lld/wasm/InputFiles.cpp`
  (its `BitcodeFile` parses bitcode through `llvm::lto::InputFile`),
  `lld/wasm/Driver.cpp` (which calls `LLVMInitializeWebAssembly*` for LTO), and
  `lld/Common/` (`TargetOptionsCommandFlags.cpp` and `CommonLinkerContext.cpp` pull
  in LLVM's code generator for the `-mllvm`/target-option flags). That is a fork of
  lld, not a configuration. With LTO left in, the linker carries the whole
  CodeGen/SelectionDAG stack from `LLVMLTO` + `LLVMWebAssemblyCodeGen`.
- **`CrashRecoveryContext` had to be dealt with.** It is excluded from the WASI
  build (it needs `setjmp`, which wasi-libc gates behind the not-yet-standardized
  SJLJ proposal) and lld links it. The fix is a WASI path in the header with the
  interface intact and recovery as a no-op — which also resolves `Process.cpp`'s
  references in `LLVMSupport`. Nothing else in the libraries we ship needed it, so
  it stayed out of the build: an unshipped stub is worse than a documented one.

So the demo keeps clang-wasm's `lld.wasm`. The useful residue is that **lld
compiles for `wasm32-wasip1` with almost no porting** — the interaction above is
the only real one — so a wasm-only lld is a fork worth making only if the payload
ever has to shrink by those 4 MB badly enough to maintain it.

### Where the compile time went

A compile was 10–15 s; it is now ~2 s, and almost all of the difference was one
behaviour in the WASI host.

`--stats` on the *wasm* compiler, against the same program under the native
compiler, showed the cost was **not** parsing or semantic analysis — those match
the native build within a few percent — but `Codegen (bc+obj)`:

| phase | native | wasm before | wasm after |
| --- | --- | --- | --- |
| Parse | 0.01 s | 0.01 s | 0.01 s |
| Semantic (top level) | 1.13 s | 1.16 s | 1.16 s |
| Semantic (main) | 0.10 s | 0.27 s | 0.27 s |
| Codegen (crystal) | 0.06 s | 0.24 s | 0.24 s |
| **Codegen (bc+obj)** | 0.23 s | **8.81 s** | 1.8 s |
| **total** | 1.9 s | 10.7 s | ~4 s |

Counting and timing every WASI import named it exactly:

```
fd_write    110,599 calls   7,385 ms
fd_read         532 calls      20 ms
fd_seek      22,635 calls       5 ms
```

LLVM writes a wasm object in ~110k small positioned writes, and
`browser_wasi_shim` grows a file by allocating *exactly* what each write needs and
copying the old bytes in, on every write past the end. That is quadratic, and for
a 500 KB object it swamps everything else — the other 110k calls together are
under 100 ms.

`packages/crystal-wasm/src/engine.js` carries a small patch for it: files grow
geometrically, the written length is tracked separately from the buffer, every
length-sensitive operation (`File#size`, `WHENCE_END` seeks) uses that length, and
files are trimmed back to it before anything reads them. `fd_write` fell from 7.4 s to
86 ms in Node, and the browser's compile from 10–15 s to ~2 s.

Two bugs in that patch are worth not repeating: taking a buffer's *capacity* for
the file's length (the tracked length ratchets up to the capacity — the first
wrong object was exactly 524,288 bytes, a power of two), and leaving `WHENCE_END`
seeking to `data.byteLength`, which leaves a gap of zeros in the middle of the
object.

The vendored shim is untouched: the patch lives where the reason is visible.

Verified in headless Chrome with `crossOriginIsolated === false`: 4.3 s for the
first run (asset load, module compile and the program together), **2.0 s after**,
including `begin`/`rescue`/`ensure`.

## Reproduce

Everything below runs in the `racket-build` WSL distro (Ubuntu 24.04, root). The
whole sequence, from a clean patched source copy — `$OUT` is `/root/bc-crystal`:

```bash
OUT=$OUT
rm -rf $OUT/src && cp -r /opt/crystal-1.17.0/share/crystal/src $OUT/src
python3 build/crystal-wasm/apply-patches.py $OUT/src   # idempotent; safe to re-run

bash build/crystal-wasm/repro.sh                        # fast check: caught: boom / done

OUT=$OUT bash build/crystal-wasm/bootstrap.sh           # native patched compiler
# RELEASE=1 is what the page needs (smaller frames -> fits a browser's ~1 MB
# native stack; see "Resolution" §3). Drop it for a debug build.
RELEASE=1 CRYSTAL=$OUT/bin/crystal-native CRYSTAL_SRC=/opt/crystal-1.17.0/share/crystal/src \
  bash build/crystal-wasm/cross-compile.sh              # crystal.o.wasm
bash build/crystal-wasm/link.sh                         # crystal.wasm

node build/crystal-wasm/try-compile.mjs                     # compiles main.cr -> out.o.wasm
node build/crystal-wasm/try-link.mjs                        # links it in the host with lld.wasm and runs it
```

(The `--stack-size=4000` that `try-compile.mjs` needs applies to the *debug*
compiler; the release build runs at Node's default and is what a browser gets.)

`repro.sh` is the seconds-long proxy for the compiler cycle — a three-line
`begin`/`raise`/`rescue` through the native patched compiler. `try-compile.mjs`
runs the real `crystal.wasm` against the real stdlib under clang-wasm's WASI
filesystem; the `--stack-size` is required (see "Resolution" §3). The object it
writes (`/root/bc-crystal/out.o.wasm`) then links and runs like the repro:

```bash
clang --target=wasm32-wasip1 --sysroot=/opt/wasi-sdk-33/share/wasi-sysroot \
  -O1 -nostartfiles -fwasm-exceptions -o out.wasm out.o.wasm \
  -L/root/bc-pcre2/build -lpcre2-8 -lc++ -lc++abi -lunwind \
  -lwasi-emulated-signal -lwasi-emulated-mman -lwasi-emulated-getpid -lwasi-emulated-process-clocks
node build/llvm-wasm/verify/run-wasi.mjs out.wasm       # hello from the wasm Crystal compiler
```

The cross-compile on its own still prints the wasm *object* plus the link command
Crystal would have run; the real link is done by hand with wasi-sdk against
`../llvm-wasm/out/lib/*.a`, the compat stubs, and PCRE2 — exactly as
`../llvm-wasm/verify/run-probe.sh` links the LLVM probe.
