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

The runtime host: an in-memory filesystem so the compiler can read sources and
write emitted objects, and `lld` to link them — the same problem
`public/wasi-preview1.js` solves for running programs, one level up.

## Reproduce

Needs a native Crystal on `PATH` (or `CRYSTAL=`), plus the built libLLVM.

```bash
CRYSTAL=/opt/crystal-1.17.0/bin/crystal bash build/crystal-wasm/cross-compile.sh
```

The output is a wasm *object* plus the link command Crystal would have run; the
real link will be done by hand with wasi-sdk against `../llvm-wasm/out/lib/*.a`,
the compat stubs, and PCRE2 — exactly as `..//llvm-wasm/verify/run-probe.sh`
links the LLVM probe.
