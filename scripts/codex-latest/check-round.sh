#!/usr/bin/env bash
# Iteration helper: cargo check a crate for wasm32-wasip1 and summarize errors.
#   scripts/codex-latest/check-round.sh <log-name> [-p crate ...]
set -uo pipefail
source "$(dirname "$0")/env.sh"
name="$1"; shift
pkgs=("$@"); [ ${#pkgs[@]} -eq 0 ] && pkgs=(-p codex-exec)
cd "$WS"
cw check "${pkgs[@]}" --keep-going --message-format short > "$CL/$name.log" 2>&1
echo "EXIT=$?" >> "$CL/$name.log"
grep -E '^error: (could not compile|failed to run)' "$CL/$name.log" | sort -u
grep -E ': error' "$CL/$name.log" | sed -E "s|^$HOME/.cargo/registry/src/[^/]+/||" | sort -u | head -${MAXERR:-60}
echo "errors: $(grep -cE ': error' "$CL/$name.log")"
