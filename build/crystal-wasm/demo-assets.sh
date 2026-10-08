#!/bin/bash
# demo-assets.sh — collect everything the in-browser demo needs into public/crystal-demo/.
#
#   bash demo-assets.sh          # run in the racket-build WSL distro
#
# Produces (all served statically; the directory is gitignored — these are big
# binaries and a 15 MB stdlib, not source):
#
#   public/crystal-demo/compiler.wasm   the wasm Crystal compiler (release build)
#   public/crystal-demo/lld.wasm        clang-wasm's lld, renamed
#   public/crystal-demo/stdlib.json     the patched stdlib: { "path": "contents" }
#   public/crystal-demo/lib/…           the libraries wasm-ld needs (with the EH variants)
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

echo "=== compiler ==="
cp "$OUT/crystal.wasm" "$DEST/compiler.wasm"
ls -l "$DEST/compiler.wasm"

echo "=== lld ==="
if [ -f "$DEST/lld.wasm" ]; then
  echo "already present"
else
  gzip -dc "$CLANG_WASM/.asset-cache/bin/lld.wasm.gz" > "$DEST/lld.wasm"
fi
ls -l "$DEST/lld.wasm"

echo "=== stdlib -> stdlib.json ==="
python3 - "$OUT/src" "$DEST/stdlib.json" <<'PY'
import json, os, sys
root, out = sys.argv[1], sys.argv[2]
files = {}
for dirpath, _dirs, names in os.walk(root):
    for name in names:
        full = os.path.join(dirpath, name)
        rel = os.path.relpath(full, root).replace(os.sep, "/")
        try:
            with open(full, encoding="utf-8") as fh:
                files[rel] = fh.read()
        except UnicodeDecodeError:
            continue  # not source; the compiler never opens it
with open(out, "w", encoding="utf-8") as fh:
    json.dump(files, fh, separators=(",", ":"))
print(f"{len(files)} files")
PY
ls -l "$DEST/stdlib.json"

echo "=== libraries ==="
copy() { cp "$1" "$DEST/$2"; echo "  $2 <- $1"; }
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
echo "=== total ==="
du -sh "$DEST"; du -sh "$DEST"/* | sort -h
