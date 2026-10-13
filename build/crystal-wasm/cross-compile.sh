#!/bin/bash
# cross-compile.sh — build compiler/crystal.cr for wasm32-unknown-wasi, against
# the wasm libLLVM from the llvm-wasm package (@live-codes/llvm-wasm).
#
# Run on Linux/WSL with a native Crystal (the distribution's own source is used).
# This is the beginning of the port, not a finished pipeline.
set -uo pipefail

CRYSTAL="${CRYSTAL:-/opt/crystal-1.22.0/bin/crystal}"
CRYSTAL_SRC="${CRYSTAL_SRC:-/opt/crystal-1.22.0/share/crystal/src}"
OUT="${OUT:-/root/bc-crystal}"
LLC="${LLC:-/usr/lib/llvm-20/bin/llc}"
HERE="$(cd "$(dirname "$0")" && pwd)"

mkdir -p "$OUT"

# Work on a copy, so the installed Crystal is never mutated.
if [ ! -d "$OUT/src" ]; then
	echo "=== copying Crystal source to $OUT/src ==="
	cp -r "$CRYSTAL_SRC" "$OUT/src"
fi
SRC="$OUT/src"

echo "=== applying Crystal source patches ==="
python3 "$HERE/apply-patches.py" "$SRC" || exit 1

# Point CRYSTAL_PATH at the patched copy alone. The default also contains the
# installed dist, and the compiler's source refers to itself by CRYSTAL_PATH
# (e.g. `require "compiler/crystal/tools/formatter"`), so leaving both in makes
# every file load twice -- "can't reopen enum and add more constants to it".
export CRYSTAL_PATH="$SRC:lib"

# Crystal reads its LLVM binding set from llvm-config, and link flags from
# LLVM_LDFLAGS. The host's llvm-config reports the *host* LLVM, which would
# select the wrong bindings for a compiler whose target libLLVM is 20.1.8 -- so
# LLVM_CONFIG points at this shim and the version vars are set explicitly.
cat > "$OUT/llvm-config" <<'EOF'
#!/bin/sh
for a in "$@"; do
  case "$a" in
    --version) echo "20.1.8"; exit 0;;
    --targets-built) echo "WebAssembly"; exit 0;;
  esac
done
echo ""
EOF
chmod +x "$OUT/llvm-config"

export LLVM_CONFIG="$OUT/llvm-config"
export LLVM_VERSION=20.1.8
export LLVM_TARGETS=WebAssembly
export LLVM_LDFLAGS=""   # the real link is done by hand: wasi-sdk + the llvm-wasm package's out/lib

cd "$SRC" || exit 1

echo "=== crystal build compiler/crystal.cr --target wasm32-unknown-wasi ==="
# The compiler is no longer asked to optimize or to emit the object itself:
# `--release` (-O3, in-process) is what segfaults on this module, so the IR is
# emitted unoptimized and `llc -O3` below optimizes and emits it (see the note there).

"$CRYSTAL" build compiler/crystal.cr \
  -Di_know_what_im_doing \
  -Dwithout_playground \
  -Dwithout_docs \
  -Dwithout_interpreter \
  -Duse_pcre2 \
  -Dwithout_mt \
  --mattr=+exception-handling \
  --cross-compile --target wasm32-unknown-wasi \
  --emit llvm-bc \
  --single-module \
  -o "$OUT/crystal.bc"
rc=$?
echo "crystal -> llvm-bc rc=$rc"
[ "$rc" -eq 0 ] || exit $rc
ls -l "$OUT/crystal.bc" 2>/dev/null

# `llc` does the codegen. Crystal's own in-process emitter segfaults on a module
# this large (1.22's compiler; 1.17 was small enough to miss it), while `llc -O3`
# on the same IR does not -- and llc applies WebAssembly's exception model itself,
# so EH is lowered by LLVM 20, the lowering Crystal's funclet codegen patch is
# written for. `llc` also carries the -O3 middle-end `--release` would have run
# in-process.
"$LLC" -march=wasm32 -mattr=+exception-handling \
  -wasm-enable-eh -wasm-use-legacy-eh=false -O3 -filetype=obj \
  "$OUT/crystal.bc" -o "$OUT/crystal.o.wasm"
rc=$?
echo "llc rc=$rc"
ls -l "$OUT/crystal.o.wasm" 2>/dev/null
exit $rc

# Next blockers, in order:
#   1. The compiler's own stdlib surface for wasm32 (File, Dir, Process, the
#      event loop) -- the same class of port as libLLVM's.
#   2. A runtime host: an in-memory filesystem to read sources and write emitted
#      objects, plus lld to link them.
