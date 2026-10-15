# Source me: environment for building upstream Codex for wasm32-wasip1 (agentOS).
# Paths are relative to the agentos-lab project; override with env vars.
LAB="${LAB:-$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/../.." && pwd)}"
export CL="${CL:-$LAB/build/codex-latest}"
export PATH="$HOME/.cargo/bin:$PATH"
export TOOLCHAIN="${TOOLCHAIN:-nightly-2026-03-01}"
export AOS_TC="$CL/agentos-toolchain/toolchain"
export WASI_SDK_DIR="${WASI_SDK_DIR:-$AOS_TC/c/vendor/wasi-sdk}"
# BUILD_SUFFIX selects a build flavor: "" = main (src/, out/, dist/), "-stable" = release tag
# (src-stable/, out-stable/, dist-stable/). build.sh sets it from the ref.
export BUILD_SUFFIX="${BUILD_SUFFIX-}"
export SRC="$CL/src$BUILD_SUFFIX"
export OUT="$CL/out$BUILD_SUFFIX"
export DIST="$CL/dist$BUILD_SUFFIX"
export WS="$SRC/codex-rs"
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$CL/target}"
export CC_wasm32_wasip1="$WASI_SDK_DIR/bin/clang"
export CXX_wasm32_wasip1="$WASI_SDK_DIR/bin/clang++"
export AR_wasm32_wasip1="$WASI_SDK_DIR/bin/llvm-ar"
export CFLAGS_wasm32_wasip1="--sysroot=$WASI_SDK_DIR/share/wasi-sysroot -D_WASI_EMULATED_SIGNAL -D_WASI_EMULATED_PTHREAD -D_WASI_EMULATED_MMAN -D_WASI_EMULATED_PROCESS_CLOCKS"
export CARGO_TARGET_WASM32_WASIP1_RUSTFLAGS="${CARGO_TARGET_WASM32_WASIP1_RUSTFLAGS:---cfg tokio_unstable}"
# cargo for the wasm target: cw check -p codex-exec
cw() { local sub="$1"; shift; (cd "$WS" && cargo "+$TOOLCHAIN" "$sub" --target wasm32-wasip1 -Z build-std=std,panic_abort "$@"); }
