#!/bin/bash
# link.sh — link the Crystal compiler's wasm object against the wasm libLLVM.
#
#   bash link.sh                 # expects $OUT/crystal.o.wasm from cross-compile.sh
#
# Unlike the LLVM probe, the Crystal object defines `_start` itself, so the link
# uses -nostartfiles; and it pulls LLVM's DynamicLibrary.cpp, so the compat
# layer's dlopen/dlclose/dlsym/dlerror stubs are needed.
#
# With this link line every symbol resolves except PCRE (`pcre_compile`,
# `pcre_exec`, ...): Crystal's Regex needs a wasm build of PCRE. That is the one
# outstanding artifact — see README.
set -uo pipefail

OUT="${OUT:-/root/bc-crystal}"
WASI_SDK="${WASI_SDK:-/opt/wasi-sdk-33}"
LLVM_WASM="${LLVM_WASM:-/mnt/d/DevWork/live-codes/browser-crystal/build/llvm-wasm}"
PCRE_LIB="${PCRE_LIB:-/root/bc-pcre2/build}"   # wasm libpcre2-8.a, from build-pcre2.sh

S="$WASI_SDK/share/wasi-sysroot"
CC="$WASI_SDK/bin/clang"
EMU="-D_WASI_EMULATED_SIGNAL -D_WASI_EMULATED_MMAN -D_WASI_EMULATED_GETPID -D_WASI_EMULATED_PROCESS_CLOCKS"
COMPAT="$LLVM_WASM/wasi-compat"
LIBS=$(find "$LLVM_WASM/out/lib" -name 'libLLVM*.a' | sort | tr '\n' ' ')

"$CC" --target=wasm32-wasip1 --sysroot="$S" $EMU -I"$COMPAT/include" -include wasi-compat.h -O1 \
  -c "$COMPAT/compat.c" -o "$OUT/compat.o"

PCRE_FLAGS=""
if [ -n "$PCRE_LIB" ]; then
  PCRE_FLAGS="-L$PCRE_LIB -lpcre2-8"
fi

# This is Crystal's *linear-memory* stack -- where allocas live. The 64 KiB wasm
# default overflows it during semantic analysis. Note the other stack: deep
# *call* recursion (the AST passes) uses V8's native stack, which this flag does
# not affect; that one needs `node --stack-size` (see try-compile.mjs).
STACK_SIZE="${STACK_SIZE:-33554432}"

# `--strip-debug` drops the DWARF the object carries (~20 MB of a 79 MB module)
# but keeps the `name` section -- the page has to *compile* this, so the size is
# latency, and named wasm stack traces are how this project debugs itself.
# (`--strip-all` would save another 12 MB raw / 1 MB gzipped; not worth losing
# the names.)
STRIP_TOOLING=(-Wl,--strip-debug)

"$CC" --target=wasm32-wasip1 --sysroot="$S" -O1 -nostartfiles -fwasm-exceptions \
  -Wl,-z,stack-size="$STACK_SIZE" "${STRIP_TOOLING[@]}" \
  -o "$OUT/crystal.wasm" \
  "$OUT/crystal.o.wasm" "$OUT/compat.o" $LIBS $PCRE_FLAGS \
  -lc++ -lc++abi -lunwind \
  -lwasi-emulated-signal -lwasi-emulated-mman -lwasi-emulated-getpid -lwasi-emulated-process-clocks

echo "link rc=$?"
ls -l "$OUT/crystal.wasm" 2>/dev/null
