#!/bin/bash
# run-probe.sh — link verify/llvm-probe.c against the packaged wasm libLLVM and
# run it under Node's WASI. This is the proof that the library is real: the C API
# links, LLVM runs inside a wasm engine, and it can construct a module.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
LLVM_OUT="${LLVM_OUT:-$HERE/../out}"
WASI_SDK="${WASI_SDK:-/opt/wasi-sdk-33}"
NODE="${NODE:-$(command -v node 2>/dev/null || echo /root/emsdk/node/24.19.0_64bit/bin/node)}"

CC="$WASI_SDK/bin/clang"
SYSROOT="$WASI_SDK/share/wasi-sysroot"
MODE="${1:---smoke}"

if [ ! -d "$LLVM_OUT/lib" ]; then
	echo "no packaged libLLVM at $LLVM_OUT/lib — run the build first" >&2
	exit 1
fi

LIBS=$(find "$LLVM_OUT/lib" -name 'libLLVM*.a' | sort | tr '\n' ' ')
echo "linking against $(echo "$LIBS" | wc -w) archives"

set -x
"$CC" --target=wasm32-wasip1 --sysroot="$SYSROOT" -O1 \
	-I"$LLVM_OUT/include" \
	"$HERE/llvm-probe.c" -o "$HERE/llvm-probe.wasm" \
	-Wl,--start-group $LIBS -Wl,--end-group \
	-lc++ -lc++abi \
	-lwasi-emulated-mman -lwasi-emulated-signal 2>&1 | tail -40
set +x

echo "=== running under node WASI ==="
"$NODE" "$HERE/run-wasi.mjs" "$HERE/llvm-probe.wasm" "$MODE"
