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

`cross-compile.sh` now gets through the compiler's own tooling and into the
**standard library**, which is where the remaining work is:

| Blocker | State |
| --- | --- |
| `-Di_know_what_im_doing` — the guard in `compiler/crystal.cr` | handled |
| `require "markd"` (the `docs` command) | excluded via a new `without_docs` flag, mirroring Crystal's own `without_playground` |
| `require "reply"` (interpreter/REPL) | excluded via Crystal's existing `-Dwithout_interpreter` |
| libffi's ABI enum had no wasm32 entry | patched — i386-unix values, since wasm32 is ILP32 |
| Compiler source loaded twice, from the patched copy and the installed dist | fixed: `CRYSTAL_PATH` pinned at the patched copy |
| **`Signal` undefined in `process/status.cr`** | **next: the stdlib surface for wasm32** |
| Runtime host (filesystem + lld) | not yet reached |

Every edit is in `apply-patches.py` and idempotent, so a Crystal version bump
fails loudly at the first drift rather than building something subtly wrong.

The next class of work is the standard library. `crystal/event_loop/wasi.cr`
exists — Crystal 1.17 has a WASI event loop — but parts of the stdlib still
reference facilities WASI does not have: `Process::Status#exit_signal?` asks for
`Signal`, and there will be more of this shape (signals, process, files). That is
a Crystal-upstream port of the same kind as the libLLVM patches, and it is where
the effort now sits.

## Reproduce

Needs a native Crystal on `PATH` (or `CRYSTAL=`), plus the built libLLVM.

```bash
CRYSTAL=/opt/crystal-1.17.0/bin/crystal bash build/crystal-wasm/cross-compile.sh
```

The output is a wasm *object* plus the link command Crystal would have run; the
real link will be done by hand with wasi-sdk against `../llvm-wasm/out/lib/*.a`,
the compat stubs, and PCRE2 — exactly as `..//llvm-wasm/verify/run-probe.sh`
links the LLVM probe.
