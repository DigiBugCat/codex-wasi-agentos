#!/usr/bin/env bash
# Pack $OUT/codex-exec.opt.wasm into a v2 .aospkg at $DIST/package.aospkg.
set -euo pipefail
source "$(dirname "$0")/env.sh"
WASM="${1:-$OUT/codex-exec.opt.wasm}"
PKG="$CL/pkg$BUILD_SUFFIX"
rm -rf "$PKG"; mkdir -p "$PKG/bin" "$DIST"
cp "$WASM" "$PKG/bin/codex-exec"
cp "$WASM" "$PKG/bin/codex"
WSV="$(sed -n 's/^version = "\(.*\)"$/\1/p' "$WS/Cargo.toml" | head -1)"
V="${WSV:-0.0.0}-upstream.$(git -C "$SRC" rev-parse --short=9 "HEAD~$(ls "$(dirname "$0")"/patches/codex/*.patch | wc -l | tr -d " ")" 2>/dev/null || echo unknown)"
for f in package.json agentos-package.json; do printf '{\n  "name": "codex",\n  "version": "%s"\n}\n' "$V" > "$PKG/$f"; done
(cd "$LAB" && npx agentos-toolchain build "$PKG")
mv "$PKG/dist/package.aospkg" "$DIST/package.aospkg"
rm -rf "$PKG"
echo "packed codex@$V -> $DIST/package.aospkg ($(wc -c < "$DIST/package.aospkg") bytes)"
