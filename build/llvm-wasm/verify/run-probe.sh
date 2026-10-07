#!/bin/bash
# run-probe.sh — link verify/llvm-probe.c against the packaged wasm libLLVM and
# run it under Node's WASI. This is the proof that the library is real: the C API
# links, LLVM runs inside a wasm engine, and it can construct a module.
#
# Two extra pieces go on the link line:
#   - wasi-compat/compat.c, the stub definitions for the POSIX calls WASI lacks
#     (see wasi-compat/include/wasi-compat.h), which libLLVMSupport references;
#   - the libwasi-emulated-* libraries for signals, mman and process clocks.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
LLVM_HERE="$(cd "$HERE/.." && pwd)"
LLVM_OUT="${LLVM_OUT:-$LLVM_HERE/out}"
WASI_SDK="${WASI_SDK:-/opt/wasi-sdk-33}"
NODE="${NODE:-$(command -v node 2>/dev/null || echo /root/emsdk/node/24.19.0_64bit/bin/node)}"

CC="$WASI_SDK/bin/clang"
SYSROOT="$WASI_SDK/share/wasi-sysroot"
MODE="${1:---smoke}"

EMULATED="-D_WASI_EMULATED_SIGNAL -D_WASI_EMULATED_MMAN -D_WASI_EMULATED_GETPID -D_WASI_EMULATED_PROCESS_CLOCKS"
COMPAT="-I$LLVM_HERE/wasi-compat/include -include wasi-compat.h"

if [ ! -d "$LLVM_OUT/lib" ]; then
	echo "no packaged libLLVM at $LLVM_OUT/lib — run the build first" >&2
	exit 1
fi

LIBS=$(find "$LLVM_OUT/lib" -name 'libLLVM*.a' | sort | tr '\n' ' ')
echo "linking against $(echo "$LIBS" | wc -w) archives"

set -x
# The stubs first, so their symbols are available to the archives.
"$CC" --target=wasm32-wasip1 --sysroot="$SYSROOT" $EMULATED $COMPAT -O1 \
	-c "$LLVM_HERE/wasi-compat/compat.c" -o "$HERE/compat.o"

"$CC" --target=wasm32-wasip1 --sysroot="$SYSROOT" $EMULATED $COMPAT -O1 \
	-I"$LLVM_OUT/include" \
	"$HERE/llvm-probe.c" -o "$HERE/llvm-probe.wasm" \
	-Wl,--start-group "$HERE/compat.o" $LIBS -Wl,--end-group \
	-lc++ -lc++abi \
	-lwasi-emulated-signal -lwasi-emulated-mman -lwasi-emulated-getpid -lwasi-emulated-process-clocks 2>&1 | tail -40
set +x

echo "=== running under node WASI ==="
"$NODE" "$HERE/run-wasi.mjs" "$HERE/llvm-probe.wasm" "$MODE"
