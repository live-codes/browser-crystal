#!/bin/bash
# build.sh — produce libLLVM for wasm32-wasip1: the artifact Crystal's compiler
# has to link, which does not exist anywhere to download.
#
# Run on Linux or WSL. Needs: cmake >= 3.20, ninja, a native C/C++ toolchain,
# curl, tar, xz, and an extracted wasi-sdk (see llvm-wasm.lock.json).
#
#   WASI_SDK=/opt/wasi-sdk-33 bash build.sh
#
# Stages (STAGE=all runs them in order):
#   fetch   download + extract the pinned LLVM source tarball
#   host    build llvm-tblgen natively (the cross build cannot run a wasm tblgen)
#   cross   configure + build LLVM for wasm32-wasip1, WebAssembly backend only
#   pack    collect the archives + headers into build/llvm-wasm/out
#   verify  compile verify/llvm-probe.c against them, link, and run it
#
# Env: WORK (build tree) CACHE (downloads) OUT (packaged result) JOBS WASI_SDK STAGE
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
WORK="${WORK:-/root/bc-llvm}"
CACHE="${CACHE:-/root/.cache/browser-crystal}"
OUT="${OUT:-$HERE/out}"
JOBS="${JOBS:-$(nproc)}"
STAGE="${STAGE:-all}"
WASI_SDK="${WASI_SDK:-/opt/wasi-sdk-33}"

# Pins — kept in sync with llvm-wasm.lock.json.
LLVM_TAG=llvmorg-20.1.8
LLVM_TARBALL=llvm-project-20.1.8.src.tar.xz
LLVM_URL="https://github.com/llvm/llvm-project/releases/download/${LLVM_TAG}/${LLVM_TARBALL}"
LLVM_BYTES=147242952

SRC="$WORK/src/llvm-project"
SRC_EXTRACTED="$WORK/src/llvm-project-20.1.8.src"
HOST="$WORK/build-host"
CROSS="$WORK/build-wasi"

log() { printf '\n=== %s ===\n' "$*"; }

fetch() {
	log "fetch: $LLVM_TARBALL"
	bash "$HERE/fetch.sh" "$LLVM_URL" "$CACHE/$LLVM_TARBALL" "$LLVM_BYTES" 16
	if [ ! -d "$SRC" ]; then
		log "extract"
		mkdir -p "$WORK/src"
		tar -xf "$CACHE/$LLVM_TARBALL" -C "$WORK/src"
		[ -d "$SRC_EXTRACTED" ] && mv "$SRC_EXTRACTED" "$SRC"
	fi
	log "source ready at $SRC"
	ls "$SRC" | head
}

host() {
	log "host tblgen (native, $JOBS jobs)"
	[ -d "$SRC/llvm" ] || { echo "no source at $SRC — run the fetch stage first" >&2; exit 1; }
	cmake -G Ninja -S "$SRC/llvm" -B "$HOST" \
		-DCMAKE_BUILD_TYPE=Release \
		-DLLVM_TARGETS_TO_BUILD=WebAssembly \
		-DLLVM_INCLUDE_TESTS=OFF -DLLVM_INCLUDE_EXAMPLES=OFF \
		-DLLVM_INCLUDE_BENCHMARKS=OFF -DLLVM_INCLUDE_DOCS=OFF \
		-DLLVM_ENABLE_ZLIB=OFF -DLLVM_ENABLE_ZSTD=OFF \
		-DLLVM_ENABLE_TERMINFO=OFF -DLLVM_ENABLE_LIBXML2=OFF \
		-DLLVM_ENABLE_LIBEDIT=OFF -DLLVM_ENABLE_BINDINGS=OFF
	cmake --build "$HOST" --target llvm-tblgen -j "$JOBS"
	"$HOST/bin/llvm-tblgen" --version | head -2
}

configure_cross() {
	log "cross configure (wasm32-wasip1, WebAssembly backend, static, $JOBS jobs)"
	[ -x "$HOST/bin/llvm-tblgen" ] || { echo "no host tblgen — run the host stage first" >&2; exit 1; }
	log "applying WASI patches"
	python3 "$HERE/patches/apply-patches.py" "$SRC"
	cmake -G Ninja -S "$SRC/llvm" -B "$CROSS" \
		-DCMAKE_TOOLCHAIN_FILE="$HERE/toolchain-wasi.cmake" \
		-DWASI_SDK="$WASI_SDK" \
		-DCMAKE_BUILD_TYPE=Release \
		-DLLVM_TABLEGEN="$HOST/bin/llvm-tblgen" \
		-DLLVM_TARGETS_TO_BUILD=WebAssembly \
		-DLLVM_DEFAULT_TARGET_TRIPLE=wasm32-wasip1 \
		-DLLVM_HOST_TRIPLE=wasm32-wasip1 \
		-DLLVM_ENABLE_THREADS=OFF \
		-DLLVM_ENABLE_EH=OFF -DLLVM_ENABLE_RTTI=OFF \
		-DLLVM_ENABLE_ZLIB=OFF -DLLVM_ENABLE_ZSTD=OFF \
		-DLLVM_ENABLE_TERMINFO=OFF -DLLVM_ENABLE_LIBXML2=OFF \
		-DLLVM_ENABLE_LIBEDIT=OFF -DLLVM_ENABLE_BINDINGS=OFF \
		-DLLVM_BUILD_TOOLS=OFF -DLLVM_INCLUDE_TOOLS=OFF \
		-DLLVM_INCLUDE_TESTS=OFF -DLLVM_INCLUDE_EXAMPLES=OFF \
		-DLLVM_INCLUDE_BENCHMARKS=OFF -DLLVM_INCLUDE_DOCS=OFF \
		-DLLVM_BUILD_LLVM_DYLIB=OFF -DLLVM_LINK_LLVM_DYLIB=OFF
}

cross() {
	configure_cross
	log "cross build"
	cmake --build "$CROSS" -j "$JOBS"
}

pack() {
	log "pack -> $OUT"
	rm -rf "$OUT"
	mkdir -p "$OUT/lib" "$OUT/include"
	cp "$CROSS"/lib/libLLVM*.a "$OUT/lib/"
	# Headers the C and C++ APIs need: the source tree plus generated config.
	cp -r "$SRC/llvm/include/llvm-c" "$OUT/include/"
	cp -r "$SRC/llvm/include/llvm" "$OUT/include/"
	cp -r "$CROSS/include/llvm" "$OUT/include/" 2>/dev/null || true
	find "$OUT/lib" -name '*.a' | wc -l | xargs echo "archives:"
	du -sh "$OUT"
}

verify() {
	log "verify"
	bash "$HERE/verify/run-probe.sh"
}

case "$STAGE" in
	all) fetch; host; cross; pack; verify ;;
	fetch) fetch ;;
	host) host ;;
	conf) configure_cross ;;
	cross) cross ;;
	pack) pack ;;
	verify) verify ;;
	*) echo "unknown STAGE=$STAGE" >&2; exit 2 ;;
esac
