#!/bin/sh
# Runs inside the toolchain container, with the repo mounted at /project.
#
# For every samples/*.cr:
#   crystal build --cross-compile --target wasm32-unknown-wasi   -> a wasm object
#   wasm-ld <object> -lc -L<wasi-sysroot>                        -> a WASI module
# The second step is the one the Crystal compiler does not do for you.
set -eu

SYSROOT="${WASI_SDK}/share/wasi-sysroot"
OBJECTS=build/objects
OUT=public/crystal

mkdir -p "$OBJECTS" "$OUT"
failed=0

for src in samples/*.cr; do
	name=$(basename "$src" .cr)
	object="$OBJECTS/$name.o.wasm"
	wasm="$OUT/$name.wasm"
	log="$OBJECTS/$name.log"

	printf '%-22s ' "$name"

	if ! crystal build "$src" \
			--cross-compile \
			--target wasm32-unknown-wasi \
			--no-debug \
			${CRYSTAL_FLAGS:-} \
			-o "$object" >"$log" 2>&1; then
		echo 'FAILED (crystal)   — see '"$log"
		failed=1
		continue
	fi

	# -lpcre2-8 before -lc: the archive is pulled in by the program's own
	# references, and pcre2's references to libc are only resolved by an archive
	# that comes after it.
	if ! wasm-ld "$object" \
			-o "$wasm" \
			-L"$SYSROOT/lib/wasm32-wasi" \
			-L"${PCRE2_LIB}" \
			-lpcre2-8 \
			-lc >>"$log" 2>&1; then
		echo 'FAILED (wasm-ld)   — see '"$log"
		failed=1
		continue
	fi

	printf '%s KB\n' "$(( $(wc -c < "$wasm") / 1024 ))"
done

if [ "$failed" -ne 0 ]; then
	echo
	echo 'Some samples did not build. Their logs are in '"$OBJECTS"'/.' >&2
fi
exit "$failed"
