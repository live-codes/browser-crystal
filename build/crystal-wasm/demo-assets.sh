#!/bin/bash
# demo-assets.sh — collect what the in-browser demo fetches into public/crystal-demo/.
#
#   bash demo-assets.sh          # run in the racket-build WSL distro
#
# Everything is gzipped and the page inflates it itself (DecompressionStream), so
# no server configuration is needed and any static host works. Gzipped, the whole
# payload is ~24 MB; uncompressed it is ~110 MB. The directory is gitignored.
#
#   compiler.wasm.gz   the wasm Crystal compiler (release, --strip-debug)
#   lld.wasm.gz        clang-wasm's lld
#   stdlib.json.gz     the patched stdlib as { "path": "contents" }
#   lib/…​.a.gz         the libraries wasm-ld links against (with the eh/ variants)
#
# Sources: $OUT (the WSL build tree), clang-wasm's asset cache, and wasi-sdk-33.
set -uo pipefail

REPO=${REPO:-/mnt/d/DevWork/live-codes/browser-crystal}
CLANG_WASM=${CLANG_WASM:-/mnt/d/DevWork/live-codes/clang-wasm}
OUT=${OUT:-/root/bc-crystal}
WASI_SDK=${WASI_SDK:-/opt/wasi-sdk-33}
PCRE_LIB=${PCRE_LIB:-/root/bc-pcre2/build}
DEST="$REPO/public/crystal-demo"

SYSROOT="$WASI_SDK/share/wasi-sysroot/lib/wasm32-wasip1"
CLANG_RT="$WASI_SDK/lib/clang/22/lib/wasm32-unknown-wasip1"

mkdir -p "$DEST/lib/eh"
# Drop artifacts from an earlier, uncompressed run.
rm -f "$DEST/compiler.wasm" "$DEST/lld.wasm" "$DEST/stdlib.json"
find "$DEST/lib" -type f -name '*.a' -delete
gz() { gzip -9 -c "$1" > "$2"; }

echo "=== compiler ==="
gz "$OUT/crystal.wasm" "$DEST/compiler.wasm.gz"
ls -l "$DEST/compiler.wasm.gz"

echo "=== lld ==="
# clang-wasm already publishes it gzipped; do not inflate and re-deflate it.
cp "$CLANG_WASM/.asset-cache/bin/lld.wasm.gz" "$DEST/lld.wasm.gz"
ls -l "$DEST/lld.wasm.gz"

echo "=== stdlib -> stdlib.json.gz ==="
python3 - "$OUT/src" "$DEST/stdlib.json" <<'PY'
import json, os, sys
root, out = sys.argv[1], sys.argv[2]
# `compiler/` is the compiler's own source: a program being compiled never
# requires it (the stdlib's prelude and library are all a program can reach), and
# it is 3.5 MB of the 9.5 MB -- over a third of the stdlib for nothing.
SKIP = ("compiler/",)
files = {}
for dirpath, _dirs, names in os.walk(root):
    for name in names:
        full = os.path.join(dirpath, name)
        rel = os.path.relpath(full, root).replace(os.sep, "/")
        if rel.startswith(SKIP):
            continue
        try:
            with open(full, encoding="utf-8") as fh:
                files[rel] = fh.read()
        except UnicodeDecodeError:
            continue  # not source; the compiler never opens it
with open(out, "w", encoding="utf-8") as fh:
    json.dump(files, fh, separators=(",", ":"))
print(f"{len(files)} files, {os.path.getsize(out) / 1e6:.1f} MB json")
PY
gz "$DEST/stdlib.json" "$DEST/stdlib.json.gz"
rm -f "$DEST/stdlib.json"
ls -l "$DEST/stdlib.json.gz"

echo "=== libraries ==="
copy() { gz "$1" "$DEST/$2.gz"; echo "  $2.gz <- $1"; }
copy "$SYSROOT/libc.a"                              "lib/libc.a"
copy "$SYSROOT/libwasi-emulated-signal.a"           "lib/libwasi-emulated-signal.a"
copy "$SYSROOT/libwasi-emulated-mman.a"             "lib/libwasi-emulated-mman.a"
copy "$SYSROOT/libwasi-emulated-getpid.a"           "lib/libwasi-emulated-getpid.a"
copy "$SYSROOT/libwasi-emulated-process-clocks.a"   "lib/libwasi-emulated-process-clocks.a"
copy "$SYSROOT/eh/libc++.a"                         "lib/eh/libc++.a"
copy "$SYSROOT/eh/libc++abi.a"                      "lib/eh/libc++abi.a"
copy "$SYSROOT/eh/libunwind.a"                      "lib/eh/libunwind.a"
copy "$PCRE_LIB/libpcre2-8.a"                       "lib/libpcre2-8.a"
copy "$CLANG_RT/libclang_rt.builtins.a"             "lib/libclang_rt.builtins.a"

echo
echo "=== what the page fetches ==="
du -ch "$DEST"/compiler.wasm.gz "$DEST"/lld.wasm.gz "$DEST"/stdlib.json.gz "$DEST"/lib | tail -1
