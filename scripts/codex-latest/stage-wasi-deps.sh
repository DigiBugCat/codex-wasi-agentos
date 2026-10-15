#!/usr/bin/env bash
# Stage codex-rs/wasi-deps/: the WASI replacement crates referenced by the
# [patch.crates-io] table that patches/codex/0001 adds.
#
#   stage-wasi-deps.sh <out-dir> [--pristine]
#
# Sources (all pinned):
#   tokio                   rivet-dev/codex@8f4655a9 codex-rs/vendor/tokio-wasi (tokio 1.52.3 + WASI process/fs/net)
#   stubs/*, crates/*       rivet-dev/agent-os@a6c668c^ toolchain/{stubs,crates} (reqwest shim over host_net, ...)
#   patched/<crate>-<ver>   pristine crates.io sources
# then applies patches/wasi-deps.patch (agentos-lab changes) unless --pristine.
set -euo pipefail
source "$(dirname "$0")/env.sh"
OUT="$1"; MODE="${2:-}"
FORK="${FORK_DIR:-$CL/fork}"
AGENTOS="${AGENTOS_DIR:?set AGENTOS_DIR to a rivet-dev/agent-os clone with history (a6c668c^)}"
FORK_PIN=8f4655a9dbfc7db91768c78ccaea7357ba47127e
AGENTOS_REV="a6c668c^"
CRATES="rustls-native-certs-0.8.3 tokio-graceful-0.2.2 gethostname-1.1.0 hyper-util-0.1.20 libc-0.2.186 socket2-0.6.5 tonic-0.14.3 opentelemetry-http-0.31.0 rama-net-0.3.0-alpha.4 rama-tcp-0.3.0-alpha.4 rama-udp-0.3.0-alpha.4 gix-fs-0.19.2"

[ ! -e "$OUT" ] || { echo "ERROR: $OUT exists" >&2; exit 1; }
mkdir -p "$OUT/stubs" "$OUT/crates/libs" "$OUT/patched"
tmp="$(mktemp -d "$CL/.stage.XXXXXX")"
trap 'rm -rf "$tmp"' EXIT

git -C "$FORK" archive "$FORK_PIN" codex-rs/vendor/tokio-wasi | tar -x -C "$tmp"
mv "$tmp/codex-rs/vendor/tokio-wasi" "$OUT/tokio"

git -C "$AGENTOS" archive "$AGENTOS_REV" toolchain/stubs/reqwest-shim toolchain/stubs/portable-pty-wasi \
	toolchain/stubs/ctrlc toolchain/crates/libs/wasi-http toolchain/crates/libs/wasi-spawn \
	toolchain/crates/libs/wasi-pty toolchain/crates/wasi-ext | tar -x -C "$tmp"
mv "$tmp"/toolchain/stubs/* "$OUT/stubs/"
mv "$tmp"/toolchain/crates/libs/* "$OUT/crates/libs/"
mv "$tmp/toolchain/crates/wasi-ext" "$OUT/crates/wasi-ext"

for c in $CRATES; do
	name="${c%-*}"; ver="${c##*-}"
	case "$c" in rama-*-0.3.0-alpha.4) name="${c%-0.3.0-alpha.4}"; ver="0.3.0-alpha.4";; esac
	reg="$(ls -d "$HOME"/.cargo/registry/src/*/"$c" 2>/dev/null | head -1 || true)"
	if [ -n "$reg" ]; then
		cp -R "$reg" "$OUT/patched/$c"
	else
		curl -fsSL "https://static.crates.io/crates/$name/$c.crate" | tar -xz -C "$OUT/patched"
	fi
	rm -f "$OUT/patched/$c/.cargo-ok" "$OUT/patched/$c/.cargo_vcs_info.json"
done

if [ "$MODE" != "--pristine" ]; then
	(cd "$OUT" && patch -p1 --batch --forward -s < "$(dirname "$0")/patches/wasi-deps.patch")
fi
echo "staged $OUT"
