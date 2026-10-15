#!/usr/bin/env bash
# Reproducible build of upstream openai/codex (codex-exec --session-turn) for agentOS 0.4.1.
#
#   scripts/codex-latest/build.sh [REF]      # REF defaults to the newest stable release tag
#   scripts/codex-latest/build.sh rust-v0.162.1           # -> build/codex-latest/dist-stable/
#   scripts/codex-latest/build.sh bb64b894fd              # main snapshot -> build/codex-latest/dist/
#   STEPS="source wasm pack" scripts/codex-latest/build.sh  # subset of steps
#
# Release tags (rust-vX.Y.Z) build into src-stable/out-stable/dist-stable; any other ref
# into src/out/dist. Override with BUILD_SUFFIX. UPSTREAM_REF env works as well as $1.
#
# Why stable by default: main sends request fields the production backend rejects
# (2026-10-15: "Unknown parameter: 'input[1].internal_chat_message_metadata_passthrough
# .content_item_metadata'"), so a real ChatGPT/API turn needs a released revision.
#
# Steps (default: all, in order):
#   clone    clone openai/codex, rivet-dev/codex (tokio-wasi), rivet-dev/agent-os (toolchain history)
#   tools    rustup nightly-2026-03-01 (+rust-src, wasm32-wasip1), wasi-sdk 25, agentOS toolchain files
#   std      apply agentOS std patches (patch-std.sh) + patches/std/* to the toolchain's rust-src
#   libc     build agentOS's patched wasi-libc sysroot (build-wasi-libc.sh)
#   source   worktree at UPSTREAM_REF + `git am patches/codex/*` + stage wasi-deps (stage-wasi-deps.sh)
#   wasm     cargo build codex-exec for wasm32-wasip1 (build-wasm.sh)
#   pack     v2 .aospkg at build/codex-latest/dist/package.aospkg (pack.sh)
#   mock     CODEX_PKG=... npx tsx codex-mock-turn.ts (expects PASS)
#
# Everything lands under build/codex-latest/ (gitignored). Needs ~25 GB free disk.
# The rustup toolchain's rust-src is patched in place (it is a dedicated toolchain pin).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
SUFFIX_FROM_USER="${BUILD_SUFFIX+x}"
source "$HERE/env.sh"

UPSTREAM_REF="${1:-${UPSTREAM_REF:-}}"
FORK_PIN=8f4655a9dbfc7db91768c78ccaea7357ba47127e   # rivet-dev/codex wasi-port-codex-core
AGENTOS_REV=63ae3b256749d47c7b3a7c463128d5deda57d1bb # rivet-dev/agent-os a6c668c^ (last tree with Codex WASI tooling)
export AGENTOS_DIR="${AGENTOS_DIR:-$CL/agent-os}"
STEPS="${STEPS:-clone tools std libc source wasm pack mock}"
latest_stable_tag() {
	git -C "$CL/fork" tag --sort=-v:refname | grep -E '^rust-v[0-9]+\.[0-9]+\.[0-9]+$' | head -1
}
has() { case " $STEPS " in *" $1 "*) return 0;; *) return 1;; esac; }
mkdir -p "$CL"

if has clone; then
	echo "== clone =="
	[ -d "$CL/upstream/.git" ] || git clone --filter=blob:none https://github.com/openai/codex.git "$CL/upstream"
	git -C "$CL/upstream" fetch -q origin main
	[ -d "$CL/fork/.git" ] || git clone --filter=blob:none https://github.com/rivet-dev/codex.git "$CL/fork"
	git -C "$CL/fork" cat-file -e "$FORK_PIN" 2>/dev/null || git -C "$CL/fork" fetch -q origin "$FORK_PIN"
	git -C "$CL/fork" remote get-url upstream >/dev/null 2>&1 || git -C "$CL/fork" remote add upstream https://github.com/openai/codex.git
	git -C "$CL/fork" fetch -q --filter=blob:none --tags upstream main
	[ -d "$AGENTOS_DIR/.git" ] || git clone --filter=blob:none https://github.com/rivet-dev/agent-os.git "$AGENTOS_DIR"
	git -C "$AGENTOS_DIR" cat-file -e "$AGENTOS_REV" 2>/dev/null || git -C "$AGENTOS_DIR" fetch -q origin
fi

[ -n "$UPSTREAM_REF" ] || UPSTREAM_REF="$(latest_stable_tag)"
[ -n "$UPSTREAM_REF" ] || { echo "ERROR: no upstream ref (run the clone step first)" >&2; exit 1; }
if [ -z "$SUFFIX_FROM_USER" ]; then
	case "$UPSTREAM_REF" in rust-v*) BUILD_SUFFIX="-stable";; *) BUILD_SUFFIX="";; esac
fi
export BUILD_SUFFIX
source "$HERE/env.sh"   # recompute SRC/OUT/DIST/WS for the flavor
echo "== ref $UPSTREAM_REF -> src$BUILD_SUFFIX / dist$BUILD_SUFFIX =="

if has tools; then
	echo "== tools =="
	command -v rustup >/dev/null || {
		echo "installing rustup (no PATH/profile changes)"
		curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --no-modify-path --default-toolchain none --profile minimal
	}
	rustup toolchain list | grep -q "^$TOOLCHAIN" ||
		rustup toolchain install "$TOOLCHAIN" --profile minimal --component rust-src --target wasm32-wasip1
	mkdir -p "$CL/agentos-toolchain"
	git -C "$AGENTOS_DIR" archive "$AGENTOS_REV" toolchain/std-patches toolchain/scripts toolchain/c/include \
		toolchain/rust-toolchain.toml | tar -x -C "$CL/agentos-toolchain"
	if [ ! -x "$WASI_SDK_DIR/bin/clang" ]; then
		mkdir -p "$(dirname "$WASI_SDK_DIR")"
		arch="$(uname -m)"; [ "$arch" = aarch64 ] && arch=arm64
		os="$(uname -s | tr '[:upper:]' '[:lower:]')"; [ "$os" = darwin ] && os=macos
		curl -fsSL "https://github.com/WebAssembly/wasi-sdk/releases/download/wasi-sdk-25/wasi-sdk-25.0-$arch-$os.tar.gz" |
			tar -xz -C "$(dirname "$WASI_SDK_DIR")"
		mv "$(dirname "$WASI_SDK_DIR")/wasi-sdk-25.0-$arch-$os" "$WASI_SDK_DIR"
	fi
fi

if has std; then
	echo "== std =="
	(cd "$AOS_TC" && PATH="$HOME/.cargo/bin:$PATH" ./scripts/patch-std.sh)
	STD_SRC="$(rustc "+$TOOLCHAIN" --print sysroot)/lib/rustlib/src/rust"
	for p in "$HERE"/patches/std/*.patch; do
		if patch -p1 -R --dry-run -s -d "$STD_SRC" < "$p" >/dev/null 2>&1; then
			echo "already applied: $(basename "$p")"
		else
			patch -p1 --batch -s -d "$STD_SRC" < "$p"; echo "applied: $(basename "$p")"
		fi
	done
fi

if has libc; then
	echo "== libc =="
	"$HERE/build-wasi-libc.sh"
fi

if has source; then
	echo "== source ($UPSTREAM_REF + patches/codex) =="
	if [ ! -e "$SRC/.git" ]; then
		git -C "$CL/fork" worktree add -q --detach "$SRC" "$UPSTREAM_REF"
	else
		git -C "$SRC" am --abort >/dev/null 2>&1 || true
		git -C "$SRC" checkout -q --detach -f "$UPSTREAM_REF"
	fi
	# Cargo.lock in patch 0001 is the lock of the known-good main build. On other refs it
	# conflicts; take the patch's version (same third-party versions as the tested build,
	# which the [patch] entries are pinned to) and let cargo fix up workspace members.
	# Keeping the ref's own lock instead failed: socket2 0.6.3 / gix-fs versions without
	# the WASI patches. Any other conflict stops the build.
	export GIT_AUTHOR_NAME=agentos-lab GIT_AUTHOR_EMAIL=lab@local GIT_COMMITTER_NAME=agentos-lab GIT_COMMITTER_EMAIL=lab@local
	if ! git -C "$SRC" am -q -3 "$HERE"/patches/codex/*.patch; then
		while c="$(git -C "$SRC" diff --name-only --diff-filter=U)"; [ -n "$c" ]; do
			[ "$c" = codex-rs/Cargo.lock ] || { echo "ERROR: patch conflict in: $c" >&2; exit 1; }
			git -C "$SRC" checkout --theirs codex-rs/Cargo.lock
			git -C "$SRC" add codex-rs/Cargo.lock
			git -C "$SRC" am --continue >/dev/null || true
		done
		[ ! -d "$(git -C "$SRC" rev-parse --git-path rebase-apply)" ] || { echo "ERROR: git am did not finish" >&2; exit 1; }
	fi
	# Upstream main carries version 0.0.0 (release CI stamps it). The ChatGPT backend
	# gates models on client_version (minimal_client_version), so stamp the newest
	# stable release tag unless CODEX_VERSION is given.
	CODEX_VERSION="${CODEX_VERSION:-$(latest_stable_tag | sed 's/^rust-v//')}"
	sed -i.bak "s/^version = \"0.0.0\"$/version = \"$CODEX_VERSION\"/" "$WS/Cargo.toml" && rm -f "$WS/Cargo.toml.bak"
	echo "workspace version: $CODEX_VERSION"
	if [ -d "$WS/wasi-deps" ]; then
		mv "$WS/wasi-deps" "$CL/.wasi-deps.old.$$"
		echo "(previous wasi-deps moved to $CL/.wasi-deps.old.$$; delete it when done)"
	fi
	"$HERE/stage-wasi-deps.sh" "$WS/wasi-deps"
fi

if has wasm; then
	echo "== wasm =="
	"$HERE/build-wasm.sh"
fi

if has pack; then
	echo "== pack =="
	"$HERE/pack.sh"
fi

if has mock; then
	echo "== mock turn =="
	(cd "$LAB" && CODEX_PKG="$DIST/package.aospkg" timeout 240 npx tsx codex-mock-turn.ts)
fi
