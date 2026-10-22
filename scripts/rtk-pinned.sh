#!/usr/bin/env bash
# Downloads the rtk release pinned in rtk.pin, verifies it against the
# release's checksums.txt AND the sha256 recorded in rtk.pin, extracts the
# binary into .cache/rtk/<version>/ and prints its path. Idempotent.
#
#   RTK_BIN="$(bash scripts/rtk-pinned.sh)"
#
# Picks the asset for the current platform: linux x86_64 uses the primary
# `asset`; other platforms must be listed under `alt` in rtk.pin.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PIN="$ROOT/rtk.pin"
CACHE="${RTK_CACHE_DIR:-$ROOT/.cache/rtk}"

VERSION="$(node -p "JSON.parse(require('fs').readFileSync('$PIN','utf8')).version")"
PLATFORM="$(uname -s)-$(uname -m)"
case "$PLATFORM" in
  Linux-x86_64)  KEY="" ;;
  Darwin-arm64)  KEY="aarch64-apple-darwin" ;;
  Darwin-x86_64) KEY="x86_64-apple-darwin" ;;
  Linux-aarch64) KEY="aarch64-unknown-linux-gnu" ;;
  *) echo "rtk-pinned: unsupported platform $PLATFORM" >&2; exit 2 ;;
esac
if [ -z "$KEY" ]; then
  ASSET="$(node -p "JSON.parse(require('fs').readFileSync('$PIN','utf8')).asset")"
  SHA="$(node -p "JSON.parse(require('fs').readFileSync('$PIN','utf8')).sha256")"
else
  ASSET="$(node -p "(JSON.parse(require('fs').readFileSync('$PIN','utf8')).alt['$KEY']||{}).asset||''")"
  SHA="$(node -p "(JSON.parse(require('fs').readFileSync('$PIN','utf8')).alt['$KEY']||{}).sha256||''")"
  if [ -z "$ASSET" ]; then echo "rtk-pinned: no asset for $KEY in rtk.pin" >&2; exit 2; fi
fi

DEST="$CACHE/$VERSION/$KEY"
BIN="$DEST/rtk"
if [ -x "$BIN" ] && "$BIN" --version >/dev/null 2>&1; then
  echo "$BIN"
  exit 0
fi

mkdir -p "$DEST"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
BASE="https://github.com/rtk-ai/rtk/releases/download/$VERSION"
curl -fsSL --retry 3 -o "$TMP/$ASSET" "$BASE/$ASSET"
curl -fsSL --retry 3 -o "$TMP/checksums.txt" "$BASE/checksums.txt"

if command -v sha256sum >/dev/null; then GOT="$(sha256sum "$TMP/$ASSET" | awk '{print $1}')"; else GOT="$(shasum -a 256 "$TMP/$ASSET" | awk '{print $1}')"; fi
FROM_RELEASE="$(grep -E "[[:space:]]$ASSET\$" "$TMP/checksums.txt" | awk '{print $1}')"
if [ "$GOT" != "$SHA" ]; then echo "rtk-pinned: sha256 mismatch vs rtk.pin ($GOT != $SHA)" >&2; exit 1; fi
if [ "$GOT" != "$FROM_RELEASE" ]; then echo "rtk-pinned: sha256 mismatch vs release checksums.txt ($GOT != $FROM_RELEASE)" >&2; exit 1; fi

tar -xzf "$TMP/$ASSET" -C "$TMP"
FOUND="$(find "$TMP" -type f -name rtk -perm -u+x | head -1)"
if [ -z "$FOUND" ]; then echo "rtk-pinned: no rtk binary inside $ASSET" >&2; exit 1; fi
mv "$FOUND" "$BIN"
chmod +x "$BIN"
"$BIN" --version >&2
echo "$BIN"
