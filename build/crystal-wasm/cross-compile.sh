#!/bin/bash
# cross-compile.sh — start the Crystal compiler down the same road libLLVM went:
# build compiler/crystal.cr for wasm32-unknown-wasi, linked against the wasm
# libLLVM in ../llvm-wasm/out.
#
# Run on Linux/WSL with a native Crystal (see README). This is the beginning of
# the port, not a finished pipeline — it currently stops on the markd shard.
set -uo pipefail

CRYSTAL="${CRYSTAL:-/opt/crystal-1.17.0/bin/crystal}"
SRC="${SRC:-/opt/crystal-1.17.0/share/crystal/src}"
OUT="${OUT:-/root/bc-crystal}"
HERE="$(cd "$(dirname "$0")" && pwd)"

mkdir -p "$OUT"

# Crystal reads its LLVM binding set from llvm-config, and the link flags from
# LLVM_LDFLAGS. The host's llvm-config reports the *host* LLVM (18), which would
# select the wrong bindings for a compiler whose target libLLVM is 20.1.8 -- so
# LLVM_CONFIG points at this shim and the two version vars are set explicitly.
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
  --cross-compile --target wasm32-unknown-wasi \
  -o "$OUT/crystal.o.wasm"
echo "rc=$?"
ls -l "$OUT" 2>/dev/null

# Next blockers, in order:
#   1. `require "markd"` — compiler/crystal/tools/doc/generator.cr and
#      tools/playground/server.cr pull a C-binding shard. Exclude those commands
#      for wasm, or shim markd.
#   2. The compiler's own stdlib surface for wasm32 (File, Dir, Process, the
#      event loop) — the same class of port as libLLVM's.
#   3. A runtime host: an in-memory filesystem to read sources/write objects,
#      plus lld to link what the compiler emits.
