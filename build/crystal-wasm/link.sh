#!/bin/bash
# link.sh — link the Crystal compiler's wasm object against the wasm libLLVM.
#
#   bash link.sh                 # expects $OUT/crystal.o.wasm from cross-compile.sh
#
# The libLLVM comes from @live-codes/llvm-wasm (github.com/live-codes/llvm-wasm):
# `$LLVM_WASM` if it is set, otherwise the copy in this repo (build/llvm-wasm,
# which stays until the package is published), otherwise the installed package.
#
# Unlike the LLVM probe, the Crystal object defines `_start` itself, so the link
# uses -nostartfiles; and it pulls LLVM's DynamicLibrary.cpp, so the compat
# layer's dlopen/dlclose/dlsym/dlerror stubs are needed.
#
# With this link line every symbol resolves except PCRE (`pcre_compile`,
# `pcre_exec`, ...): Crystal's Regex needs a wasm build of PCRE. That is the one
# outstanding artifact — see README.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="${OUT:-/root/bc-crystal}"
WASI_SDK="${WASI_SDK:-/opt/wasi-sdk-33}"
PCRE_LIB="${PCRE_LIB:-/root/bc-pcre2/build}"   # wasm libpcre2-8.a, from build-pcre2.sh

if [ -z "${LLVM_WASM:-}" ]; then
  for candidate in "$HERE/../llvm-wasm" "$HERE/../../node_modules/@live-codes/llvm-wasm"; do
    if [ -d "$candidate/out/lib" ]; then LLVM_WASM="$candidate"; break; fi
  done
fi
if [ -z "${LLVM_WASM:-}" ] || [ ! -d "$LLVM_WASM/out/lib" ]; then
  echo "link.sh: no libLLVM found. Set LLVM_WASM, install @live-codes/llvm-wasm," >&2
  echo "         unpack it (npx llvm-wasm-unpack) if lifecycle scripts were skipped," >&2
  echo "         or keep build/llvm-wasm/ (its out/lib has the archives)." >&2
  exit 1
fi

S="$WASI_SDK/share/wasi-sysroot"
CC="$WASI_SDK/bin/clang"
EMU="-D_WASI_EMULATED_SIGNAL -D_WASI_EMULATED_MMAN -D_WASI_EMULATED_GETPID -D_WASI_EMULATED_PROCESS_CLOCKS"
COMPAT="$LLVM_WASM/wasi-compat"
LLVM_LIB="$LLVM_WASM/out/lib"

# The archives ship gzipped — one file each, because that is the shape a browser can fetch
# and inflate — and a link needs files. So inflate them here, into the build tree, instead of
# depending on something having run at install time: the package has no lifecycle script, and
# this is the "decompress when you need it" half of that. A checkout, or a package somebody
# ran `llvm-wasm-unpack` in, already has the plain files and is used as it is.
if [ -z "$(find "$LLVM_LIB" -name 'libLLVM*.a' -print -quit)" ]; then
  mkdir -p "$OUT/libLLVM"
  for gz in "$LLVM_LIB"/libLLVM*.a.gz; do
    target="$OUT/libLLVM/$(basename "${gz%.gz}")"
    [ -f "$target" ] || gzip -dc "$gz" > "$target"
  done
  LLVM_LIB="$OUT/libLLVM"
fi
LIBS=$(find "$LLVM_LIB" -name 'libLLVM*.a' | sort | tr '\n' ' ')

echo "libLLVM: $LLVM_WASM"

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
