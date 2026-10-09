#!/bin/bash
# build-pcre2.sh — build PCRE2 (8-bit) for wasm32-wasip1, statically.
#
# Crystal's Regex needs a PCRE library, and no wasm build of one exists to
# download — the same situation as libLLVM. This is a plain CMake cross-build:
# no patching, because PCRE2 has no platform layer to fight.
#
# Only the 8-bit library is built (that is what Crystal binds), with JIT off
# (WASI has no executable memory) and tests/grep/readline disabled.
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
WORK="${WORK:-/root/bc-pcre2}"
CACHE="${CACHE:-/root/.cache/browser-crystal}"
WASI_SDK="${WASI_SDK:-/opt/wasi-sdk-33}"
VER="${PCRE2_VERSION:-10.42}"
BYTES="${PCRE2_BYTES:-2397194}"

TARBALL="pcre2-$VER.tar.gz"
URL="https://github.com/PCRE2Project/pcre2/releases/download/pcre2-$VER/$TARBALL"

mkdir -p "$WORK" "$CACHE"

# fetch.sh — the parallel, resumable downloader — lives in the llvm-wasm repository, which is
# published as @live-codes/llvm-wasm and no longer vendored here: a checkout beside this one,
# or the installed package.
FETCH="${LLVM_WASM:-}"
if [ -z "$FETCH" ]; then
  for candidate in "$REPO/../llvm-wasm" "$REPO/node_modules/@live-codes/llvm-wasm"; do
    if [ -f "$candidate/fetch.sh" ]; then FETCH="$candidate"; break; fi
  done
fi
if [ ! -f "$FETCH/fetch.sh" ]; then
  echo "build-pcre2.sh: no fetch.sh found. Either set LLVM_WASM, or install the package:" >&2
  echo "                  npm install --save-dev @live-codes/llvm-wasm" >&2
  exit 1
fi

bash "$FETCH/fetch.sh" "$URL" "$CACHE/$TARBALL" "$BYTES" 8
[ -d "$WORK/pcre2-$VER" ] || tar -xzf "$CACHE/$TARBALL" -C "$WORK"

cmake -G Ninja -S "$WORK/pcre2-$VER" -B "$WORK/build" \
  -DCMAKE_SYSTEM_NAME=WASI -DCMAKE_SYSTEM_PROCESSOR=wasm32 \
  -DCMAKE_C_COMPILER="$WASI_SDK/bin/clang" \
  -DCMAKE_C_COMPILER_TARGET=wasm32-wasip1 \
  -DCMAKE_SYSROOT="$WASI_SDK/share/wasi-sysroot" \
  -DCMAKE_BUILD_TYPE=Release \
  -DPCRE2_BUILD_PCRE2_8=ON -DPCRE2_BUILD_PCRE2_16=OFF -DPCRE2_BUILD_PCRE2_32=OFF \
  -DPCRE2_BUILD_TESTS=OFF -DPCRE2_BUILD_PCRE2GREP=OFF \
  -DPCRE2_SUPPORT_JIT=OFF \
  -DPCRE2_SUPPORT_LIBZ=OFF -DPCRE2_SUPPORT_LIBBZ2=OFF \
  -DPCRE2_SUPPORT_LIBREADLINE=OFF -DPCRE2_SUPPORT_LIBEDIT=OFF \
  -DBUILD_SHARED_LIBS=OFF

cmake --build "$WORK/build" -j"$(nproc)"

echo "=== result ==="
find "$WORK/build" -name 'libpcre2-8.a' -exec ls -l {} \;
