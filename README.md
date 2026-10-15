# codex-wasi-agentos

Running coding agents, **OpenAI Codex** and **Anthropic Claude Code**, inside
[Rivet agentOS](https://github.com/rivet-dev/agentos). agentOS is a Linux-like OS that runs as
a library inside a Node process: a Rust kernel, JavaScript in V8 isolates, tools as WebAssembly,
and VMs that boot in ~0.1 s.

This is a lab notebook: harnesses, patches, and write-ups of what worked, what broke, and why.
Everything here was run on macOS (Apple Silicon) against agentOS **0.4.1** in October 2026.

## Results

| | Status | How |
|---|---|---|
| **Latest Codex (0.162.1) in agentOS** | ✅ real turns on a ChatGPT subscription (`gpt-6-astra`): shell, `apply_patch`, node, all inside the VM (~26 s turn; edits ~0.1 s after a stdin fix) | upstream `openai/codex` re-ported to `wasm32-wasip1`, 9 patches, [`scripts/codex-latest/`](scripts/codex-latest/) |
| July Codex build (Rivet's) | ✅ real turns | Rivet's last published WASM build, repacked for 0.4.1 plus a socket-constant fix |
| **Claude Code 2.1.300, headless** | ✅ real multi-step coding turn (Bash/Read/Edit) on a Claude subscription | JS extracted from the official Bun binary and adapted for agentOS's V8, [`scripts/claude-bunfs/`](scripts/claude-bunfs/) |
| **Claude Code 2.1.300, interactive TUI** | ✅ full TUI on a pipe+TTY bridge; tools run in the VM | [`tui.ts`](tui.ts) plus a pure-JS `Bun.ant.CellSegmenter` reimplementation |
| Claude Code 2.1.87 (Rivet's July package) | ✅ | repacked v1 → v2 |
| `claude self-hosted-runner` inside agentOS | ⚠️ boots and tries to register; not tested against Anthropic's control plane | see [notes/claude.md](notes/claude.md) |
| Real git in the VM | ✅ clone/fetch/worktree/commit over HTTPS; shallow fetch fails | the registry `git` package (not the npm one) |

Details: [notes/codex.md](notes/codex.md), [notes/codex-latest.md](notes/codex-latest.md),
[notes/claude.md](notes/claude.md), [notes/git.md](notes/git.md),
**[notes/agentos-bugs.md](notes/agentos-bugs.md)** (agentOS bugs found along the way).

## agentOS bugs found

Each one has a repro in this repo. See [notes/agentos-bugs.md](notes/agentos-bugs.md):

- **Shell pipes:** no SIGPIPE/EPIPE. `yes | head` hangs forever, `seq 1 100000 | head -2` takes 20 s, and a JS guest's stdout into a pipe is lost.
- **Blocking stdin reads see host writes only every 10 s,** because a fixed wait slice is never woken. This made every Codex approval cost 10 s.
- **A guest shell waiting on a child busy-polls** (the sidecar ignores `wait_ms`), so anything run under `sh` is killed after ~2 min of CPU budget. The error also names the wrong limit.
- **The PTY leaks WASM child output,** including redirected output and env dumps, onto the terminal.
- **`/proc/self/fd/N/<child>` traversal is unsupported** (ENOENT/EROFS).
- **`process.exit()` throws,** so programs that catch it turn it into SIGKILL.
- Packaging: v1 `.aospkg` is rejected by 0.4.1; the npm `git@0.3.3` is a mini-git, while the registry `git@0.3.3` is real git 2.55; paths containing spaces break VM boot.

## Quick start

```bash
npm install                      # postinstall patches the agentOS path-with-spaces bug
```

**Codex, July build** (no build needed once `build/codex` exists; see [notes/codex.md](notes/codex.md)):

```bash
CODEX_AUTH_FILE=~/.codex/auth.json CODEX_MODEL=gpt-6-astra npx tsx codex-turn.ts "your prompt"
npx tsx codex-mock-turn.ts       # no credentials: scripted model, checks tool execution in the VM
```

**Latest Codex** (needs ~25 GB of disk for the Rust build):

```bash
scripts/codex-latest/build.sh    # newest stable tag -> build/codex-latest/dist-stable/package.aospkg
CODEX_PKG=build/codex-latest/dist-stable/package.aospkg CODEX_AUTH_FILE=~/.codex/auth.json \
  CODEX_MODEL=gpt-6-astra npx tsx codex-turn.ts "your prompt"
```

**Claude Code** (bring your own binary; see [notes/claude.md](notes/claude.md) for the extraction pipeline):

```bash
claude setup-token               # then save the token to a file only you can read
CLAUDE_CODE_OAUTH_TOKEN_FILE=~/.claude/agentos-demo-token npx tsx demo-claude.ts   # headless demo
CLAUDE_CODE_OAUTH_TOKEN_FILE=~/.claude/agentos-demo-token npx tsx tui.ts            # interactive TUI
python3 -I tui-smoke.py          # TUI smoke test against an in-VM mock (no credentials)
```

## Layout

| Path | What |
|---|---|
| `codex-turn.ts`, `codex-mock-turn.ts`, `mock-openai.ts` | drive Codex's `--session-turn` NDJSON protocol in a VM (real model or mock) |
| `scripts/codex-latest/` | reproducible build of upstream Codex for WASI: `build.sh`, Codex patches, std patches, WASI dep patches |
| `demo-claude.ts`, `tui.ts`, `claude-*.ts`, `claude-mock-api.mjs` | Claude Code harnesses and mocks |
| `scripts/claude-bunfs/` | Bun-executable extractor, esbuild rebundle, Bun/agentOS shims, `Bun.ant.CellSegmenter` reimplementation |
| `vm-tools.ts` | installs agentOS registry packages (e.g. ripgrep) into VMs from a verified local cache |
| `scripts/aospkg-v1-to-v2*.mjs`, `scripts/patch-*.mjs` | package repacking and the small agentOS/Codex fixes |
| `notes/` | write-ups with evidence and repro commands |

`build/`, `vendor/` and `node_modules/` are gitignored. That covers all downloaded packages,
build output, and anything extracted from third-party binaries.

## Caveats

- **Unofficial and experimental.** Not affiliated with or endorsed by Anthropic, OpenAI or Rivet.
- **Claude Code is proprietary.** This repo contains no Claude Code code. The extraction scripts
  work on a binary you obtain yourself, and the result is an unofficial repackage for personal
  experimentation. Running Claude Code this way is not supported by Anthropic.
- **Credentials.** The harnesses copy credentials *into* the VM (one-way) when you ask them to.
  Use short-lived or scoped tokens (e.g. `claude setup-token`) and never commit token files.
- **Codex in WASI disables "code mode",** whose host embeds V8 and can't target WASM, and runs
  only the headless `--session-turn` / `exec` paths, not the TUI.

## License

Apache-2.0 (see [LICENSE](LICENSE) and [NOTICE](NOTICE)). Patches to OpenAI Codex are derivative
of Apache-2.0 code.
