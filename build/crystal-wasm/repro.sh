#!/bin/bash
# repro.sh — the fast exception-handling repro.
#
#   bash repro.sh
#
# A three-line begin/rescue/raise, compiled by the *native* patched compiler
# ($OUT/bin/crystal-native, built by bootstrap.sh) and run under Node's WASI.
# This is the seconds-long proxy for the 25-minute compiler cycle: if the wasm
# catch is broken, this is where it shows first.
#
# Success:
#     caught: boom
#     done
# Failure: `Exception [WebAssembly.Exception] {}` (the throw escaped uncaught).
set -uo pipefail

OUT="${OUT:-/root/bc-crystal}"
CRYSTAL_PATH="${CRYSTAL_PATH:-$OUT/src}"
NODE="${NODE:-/root/emsdk/node/24.19.0_64bit/bin/node}"
WASI_SDK="${WASI_SDK:-/opt/wasi-sdk-33}"
HERE="$(cd "$(dirname "$0")" && pwd)"

cat > "$OUT/exc.cr" <<'EOF'
begin
  raise "boom"
rescue ex : Exception
  puts "caught: #{ex.message}"
end
puts "done"
EOF

cd "$OUT" || exit 1
export CRYSTAL_PATH

echo "=== compile exc.cr -> exc.o.wasm ==="
"$OUT/bin/crystal-native" build exc.cr \
  --mattr=+exception-handling --cross-compile --target wasm32-unknown-wasi -o exc.o.wasm
echo "compile rc=$?"

echo "=== link ==="
"$WASI_SDK/bin/clang" --target=wasm32-wasip1 \
  --sysroot="$WASI_SDK/share/wasi-sysroot" -O1 -nostartfiles -fwasm-exceptions \
  -o exc.wasm exc.o.wasm -lc++ -lc++abi -lunwind \
  -lwasi-emulated-signal -lwasi-emulated-mman -lwasi-emulated-getpid -lwasi-emulated-process-clocks
echo "link rc=$?"

echo "=== run ==="
"$NODE" "$HERE/../llvm-wasm/verify/run-wasi.mjs" exc.wasm
echo "run rc=$?"
