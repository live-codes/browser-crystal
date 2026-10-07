#!/bin/bash
# fetch.sh — parallel, resumable download.
#
#   fetch.sh <url> <out-file> <total-bytes> [connections] [sha256]
#
# Why this exists rather than a plain curl/wget: the network this was built on
# throttles a single connection to ~20 KB/s and resets large transfers mid-flight.
# The pinned GitHub asset supports `accept-ranges: bytes`, so this opens many
# range connections and resumes each from wherever it left off, retrying on reset
# until every byte has arrived. Verified: 147 MB, 16 connections.
set -euo pipefail

URL="${1:?usage: fetch.sh <url> <out> <size> [connections] [sha256]}"
OUT="${2:?}"
SIZE="${3:?}"
N="${4:-16}"
SHA="${5:-}"

mkdir -p "$(dirname "$OUT")"

have() { [ -f "$OUT" ] && stat -c%s "$OUT" 2>/dev/null || echo 0; }

if [ "$(have)" -eq "$SIZE" ]; then
	echo "fetch: already have $OUT ($SIZE bytes)"
else
	PARTS="$OUT.parts"
	rm -rf "$PARTS"; mkdir -p "$PARTS"
	CHUNK=$(( (SIZE + N - 1) / N ))
	echo "fetch: $URL"
	echo "fetch: $SIZE bytes, $N connections, ~$CHUNK bytes each"

	for i in $(seq 0 $((N-1))); do
		start=$(( i * CHUNK ))
		end=$(( start + CHUNK - 1 ))
		[ "$end" -ge "$SIZE" ] && end=$(( SIZE - 1 ))
		want=$(( end - start + 1 ))
		(
			p="$PARTS/$i"; tries=0
			while :; do
				got=0; [ -f "$p" ] && got=$(stat -c%s "$p")
				[ "$got" -ge "$want" ] && break
				tries=$(( tries + 1 ))
				if [ "$tries" -gt 400 ]; then echo "fetch: part $i gave up at $got/$want" >&2; break; fi
				curl -sL --max-time 900 -r "$(( start + got ))-$end" -o "$p.add" "$URL" || true
				[ -s "$p.add" ] && cat "$p.add" >> "$p"
				rm -f "$p.add"
			done
		) &
	done
	wait

	: > "$OUT"
	for i in $(seq 0 $((N-1))); do cat "$PARTS/$i" >> "$OUT"; done
	rm -rf "$PARTS"

	if [ "$(have)" -ne "$SIZE" ]; then
		echo "fetch: size mismatch: got $(have), expected $SIZE" >&2
		exit 1
	fi
	echo "fetch: complete ($(have) bytes)"
fi

if [ -n "$SHA" ]; then
	echo "$SHA  $OUT" | sha256sum -c -
fi
