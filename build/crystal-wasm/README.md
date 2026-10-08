# Crossing the Crystal compiler to wasm

This is where the **"validate, then split"** plan starts: build the Crystal
compiler itself as a `wasm32-wasip1` module, linked against the libLLVM produced
in [`../llvm-wasm`](../llvm-wasm). If that links, the libLLVM package's interface
is proven by a real consumer and the split is safe.

**Status: begun, not finished.** The compiler cross-compiles far enough to hit
its own tooling, and the remaining work is charted below. This is a port of the
compiler's environment — the same shape as the libLLVM port, and a comparable
amount of effort.

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
   objects, plus `lld` to link them — the same problem `wasi-preview1.js` solves
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
That is the same problem `public/wasi-preview1.js` solves for running programs,
one level up.

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
be built for `wasm32-wasip1`; `../llvm-wasm` already knows how to cross-build
PCRE2 (its `build/Dockerfile` does it) if PCRE2 is the one wanted.

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

## Compiling on the page — what is still needed

| Piece | State |
| --- | --- |
| The compiler as wasm | done — `crystal.wasm`, runs |
| A WASI filesystem host | done on the prototype path — `clang-wasm`'s toolchain (memfs), via `try-compile.mjs` |
| Crystal's WASI file `open` | patched — the compiler reads sources |
| Stack size for deep recursion | patched at link — 32 MiB |
| **Exceptions on `wasm32-wasip1`** | **missing — Crystal's codegen has no wasm exception model** |
| wasm `lld` to link the emitted object | available from `clang-wasm`, not yet wired |
| stdlib (1552 `.cr`, 15 MB) + wasm sysroot as assets | collected, not yet shipped |
| The page: editable editor → compile → link → run | blocked on the exceptions row |

## Reproduce

Needs a native Crystal on `PATH` (or `CRYSTAL=`), plus the built libLLVM.

```bash
CRYSTAL=/opt/crystal-1.17.0/bin/crystal bash build/crystal-wasm/cross-compile.sh
```

The output is a wasm *object* plus the link command Crystal would have run; the
real link will be done by hand with wasi-sdk against `../llvm-wasm/out/lib/*.a`,
the compat stubs, and PCRE2 — exactly as `..//llvm-wasm/verify/run-probe.sh`
links the LLVM probe.
