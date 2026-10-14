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
OPT="${OPT:-/usr/lib/llvm-20/bin/opt}"
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
# The compiler is asked only to emit IR: it does not optimize or emit the object
# itself (see the note below on why), which is done by `opt` and `llc`.

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

# Crystal's own in-process `--release` segfaults on this compiler: LLVM 20's
# `WebAssembly CFG Stackify` cannot handle the optimized form of the macro-generated
# `pretty_print` methods. So the optimization is done by the `opt` tool -- the same
# -O3 pipeline Crystal would have run in-process, and the reason this build is as
# fast as the 1.17 one -- with those methods marked `optnone` so the optimizer skips
# them (`optnone` requires `noinline`), and `llc` then codegens (it applies
# WebAssembly's exception model too, which the LLVM C API cannot set). See README
# "Crystal 1.22".
#
# The names are read back out of the IR rather than listed by hand, so this keeps
# working when the compiler changes. `opt -S` dumps the whole module, so the list is
# built from its `define` lines only.
"$OPT" -S "$OUT/crystal.bc" -o - 2>/dev/null \
  | grep '^define ' | grep -oE '@"[^"]*pretty_print[^"]*"' \
  | sed 's/^@"//; s/"$//' | sort -u \
  | awk '{print $0",optnone"} {print $0",noinline"}' > "$OUT/no-opt.csv"
echo "keeping $(($(wc -l < "$OUT/no-opt.csv") / 2)) functions out of the optimizer"
"$OPT" -passes=forceattrs -forceattrs-csv-path="$OUT/no-opt.csv" \
  "$OUT/crystal.bc" -o "$OUT/crystal.marked.bc" || exit $?
"$OPT" -O3 "$OUT/crystal.marked.bc" -o "$OUT/crystal.opt.bc" || exit $?
"$LLC" -march=wasm32 -mattr=+exception-handling \
  -wasm-enable-eh -wasm-use-legacy-eh=false -O3 -filetype=obj \
  "$OUT/crystal.opt.bc" -o "$OUT/crystal.o.wasm"
rc=$?
echo "llc rc=$rc"
ls -l "$OUT/crystal.o.wasm" 2>/dev/null
exit $rc

# Next blockers, in order:
#   1. The compiler's own stdlib surface for wasm32 (File, Dir, Process, the
#      event loop) -- the same class of port as libLLVM's.
#   2. A runtime host: an in-memory filesystem to read sources and write emitted
#      objects, plus lld to link them.
