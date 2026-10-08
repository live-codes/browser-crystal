#!/bin/bash
# cross-compile.sh — build compiler/crystal.cr for wasm32-unknown-wasi, against
# the wasm libLLVM in ../llvm-wasm/out.
#
# Run on Linux/WSL with a native Crystal (the distribution's own source is used).
# This is the beginning of the port, not a finished pipeline.
set -uo pipefail

CRYSTAL="${CRYSTAL:-/opt/crystal-1.17.0/bin/crystal}"
CRYSTAL_SRC="${CRYSTAL_SRC:-/opt/crystal-1.17.0/share/crystal/src}"
OUT="${OUT:-/root/bc-crystal}"
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
# LLVM_LDFLAGS. The host's llvm-config reports the *host* LLVM (18), which would
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
export LLVM_LDFLAGS=""   # the real link is done by hand with wasi-sdk + ../llvm-wasm/out/lib

cd "$SRC" || exit 1

echo "=== crystal build compiler/crystal.cr --target wasm32-unknown-wasi ==="
"$CRYSTAL" build compiler/crystal.cr \
  -Di_know_what_im_doing \
  -Dwithout_playground \
  -Dwithout_docs \
  -Dwithout_interpreter \
  -Duse_pcre2 \
  --mattr=+exception-handling \
  --cross-compile --target wasm32-unknown-wasi \
  -o "$OUT/crystal.o.wasm"
rc=$?
echo "rc=$rc"
ls -l "$OUT"/*.wasm 2>/dev/null
exit $rc

# Next blockers, in order:
#   1. The compiler's own stdlib surface for wasm32 (File, Dir, Process, the
#      event loop) -- the same class of port as libLLVM's.
#   2. A runtime host: an in-memory filesystem to read sources and write emitted
#      objects, plus lld to link them.
