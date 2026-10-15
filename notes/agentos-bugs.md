# agentOS 0.4.1 bugs found (candidates for upstream issues/PRs)

## Shell pipelines (found 2026-10-15, repro: `npx tsx build/pipe-check.ts`)

| Pipeline | Result |
|---|---|
| `echo hi \| cat`, `seq 1 5 \| head -2`, `grep … \| grep -v …`, `rg … \| head` | OK |
| `seq 1 100000 \| tail -1` / `\| wc -l` | OK |
| `seq 1 100000 \| head -2` | correct output, but **20 s**: the writer gets no SIGPIPE/EPIPE after `head` exits and keeps writing |
| `yes \| head -3`, `cat big.txt \| head -1` | **hang until killed (exit 137)**: an infinite or long producer never learns the reader is gone |
| `node -e 'console.log(1)' \| cat` | **empty output**: a JS (V8) guest's stdout written into a pipe is lost |
| `node -e '…100k lines…' \| head -2` | empty, 8 s |

In real agent sessions, Claude Code's `grep … \| head` failed with `head: error writing 'standard output': Resource temporarily unavailable (os error 6)`, i.e. EAGAIN on a stdout write. The model wasted most of a 75 s turn working around it, against 11 s without pipes.

Fixes need the Rust sidecar / wasm-runner. Since agentos-core honors `AGENTOS_SIDECAR_BIN` / `AGENTOS_NATIVE_SIDECAR_BIN`, a locally built sidecar can be swapped in.

## Blocking stdin reads wake only every 10 s (found 2026-10-15, repro: `npx tsx build/codex-latest/stdin-probe.ts`)

A WASM guest blocked in `read(0)` sees bytes from `vm.process.writeStdin()` only when a fixed 10 s wait slice expires. The runner sends `__kernel_stdin_read(len, KERNEL_WAIT_SLICE_MS=10_000)` (`crates/execution/assets/runners/wasm-runner.mjs:1403`), the sidecar parks it until the deadline (`native-sidecar/src/execution/child_process.rs` ~8315), and a host stdin write doesn't wake it.

- Probe results: blocking read returns **10,008 ms** after the host write; `O_NONBLOCK` + polling sees it within ~2 ms.
- Impact: every interactive stdin protocol (Codex approvals, any REPL or agent driven over stdin) pays 10 s per message.
- Fix: wake parked stdin-read/poll RPCs when host stdin is queued. Workaround: Codex patch 0009 reads stdin non-blocking.

Side note: spawn env vars prefixed `AGENTOS_` are silently dropped before reaching the guest.

## Others (details in notes/claude.md)
- `/proc/self/fd/N/<tail>` path traversal is unsupported: ENOENT/EROFS.
- `child_process.poll` ignores `wait_ms`, so a guest `sh` waiting on a child busy-polls and is killed after ~2 min by `limits.wasm.runnerCpuTimeLimitMs`. The error message names the wrong limit.
- The PTY sessions leak WASM child output (including redirected output) onto the terminal.
- `process.exit()` throws `ProcessExitError` (programs that catch it break).
- Registry vs npm `git` both say 0.3.3; the npm one is a non-functional mini-git (agentos#1920).
- Default-software path built with `URL.pathname` breaks in directories with spaces.
