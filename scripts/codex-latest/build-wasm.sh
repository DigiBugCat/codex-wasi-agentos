#!/usr/bin/env bash
# Build codex-exec for wasm32-wasip1 against agentOS's patched wasi-libc, the way
# rivet-dev/codex scripts/build-wasi-codex-exec.sh (+ agentOS patches 0005/0007) did:
#   * -Z build-std from the agentOS-patched rust-src (scripts: patch-std.sh)
#   * prebuilt wasm32-wasip1 std rlibs stashed during the build (E0152 duplicate core)
#   * build-std's panic_abort copied into the sysroot (the bin resolves it from there)
#   * link with the patched libc.a + crt1-command.o + emulated pthread
# Output: $OUT/codex-exec.wasm (raw) and $OUT/codex-exec.opt.wasm
set -euo pipefail
source "$(dirname "$0")/env.sh"

LIBC_DIR="$CL/sysroot/lib/wasm32-wasi"
[ -f "$LIBC_DIR/libc.a" ] || { echo "ERROR: run build-wasi-libc.sh first" >&2; exit 1; }
LIBC_DIGEST="$(shasum -a 256 "$LIBC_DIR/libc.a" | cut -c1-16)"

SYSROOT="$(rustc "+$TOOLCHAIN" --print sysroot)"
LIBDIR="$SYSROOT/lib/rustlib/wasm32-wasip1/lib"
STASH="$LIBDIR/.prebuilt-stash"
REL="$CARGO_TARGET_DIR/wasm32-wasip1/release"

mkdir -p "$STASH" "$OUT"
shopt -s nullglob
for f in "$LIBDIR"/*.rlib "$LIBDIR"/*.rmeta; do mv "$f" "$STASH/"; done
shopt -u nullglob
restore() {
	shopt -s nullglob
	for f in "$LIBDIR"/libpanic_abort-*; do
		[ -e "$STASH/$(basename "$f")" ] || rm -f "$f"
	done
	for f in "$STASH"/*; do mv "$f" "$LIBDIR/"; done
	shopt -u nullglob
	rmdir "$STASH" 2>/dev/null || true
}
trap restore EXIT

export CARGO_TARGET_WASM32_WASIP1_RUSTFLAGS="-C link-self-contained=no -C link-arg=$LIBC_DIR/crt1-command.o -C link-arg=$LIBC_DIR/libc.a -C link-arg=$LIBC_DIR/libwasi-emulated-pthread.a -C link-arg=$LIBC_DIR/libwasi-emulated-signal.a -C link-arg=$LIBC_DIR/libwasi-emulated-mman.a -C link-arg=$LIBC_DIR/libwasi-emulated-process-clocks.a -C link-arg=-L$LIBC_DIR -C metadata=agentos-libc-$LIBC_DIGEST --cfg tokio_unstable"
# Release profile: size-oriented (124 MB -> 60 MB vs. opt=s/no LTO/unstripped; the
# wasm `name` section alone was 54 MB). For symbolized panics use
# CARGO_PROFILE_RELEASE_STRIP=none.
export CARGO_PROFILE_RELEASE_DEBUG="${CARGO_PROFILE_RELEASE_DEBUG:-none}"
export CARGO_PROFILE_RELEASE_STRIP="${CARGO_PROFILE_RELEASE_STRIP:-symbols}"
export CARGO_PROFILE_RELEASE_LTO="${CARGO_PROFILE_RELEASE_LTO:-thin}"
export CARGO_PROFILE_RELEASE_CODEGEN_UNITS="${CARGO_PROFILE_RELEASE_CODEGEN_UNITS:-16}"
export CARGO_PROFILE_RELEASE_OPT_LEVEL="${CARGO_PROFILE_RELEASE_OPT_LEVEL:-z}"
export CARGO_PROFILE_RELEASE_PANIC=abort
export CARGO_INCREMENTAL=0

build() {
	(cd "$WS" && cargo "+$TOOLCHAIN" build -p codex-exec --release --target wasm32-wasip1 \
		-Z build-std=std,panic_abort "$@")
}

place_panic_abort() {
	shopt -s nullglob
	for pa in "$REL"/deps/libpanic_abort-*.rlib "$REL"/deps/libpanic_abort-*.rmeta; do
		[ -e "$LIBDIR/$(basename "$pa")" ] || cp "$pa" "$LIBDIR/"
	done
	shopt -u nullglob
}

place_panic_abort
if ! build "$@"; then
	# First pass on a clean target: panic_abort only exists after build-std ran once.
	place_panic_abort
	build "$@"
fi

RAW="$REL/codex-exec.wasm"
[ -f "$RAW" ] || { echo "ERROR: no $RAW" >&2; exit 1; }
cp "$RAW" "$OUT/codex-exec.wasm"
echo "raw: $(wc -c < "$OUT/codex-exec.wasm") bytes"
if command -v wasm-opt >/dev/null 2>&1; then
	wasm-opt --all-features -O2 "$OUT/codex-exec.wasm" -o "$OUT/codex-exec.opt.wasm"
else
	cp "$OUT/codex-exec.wasm" "$OUT/codex-exec.opt.wasm"
fi
echo "out: $OUT/codex-exec.opt.wasm ($(wc -c < "$OUT/codex-exec.opt.wasm") bytes)"
