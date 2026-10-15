# Git in agentOS 0.4.1

**Real git works.** The registry `git` package (`https://releases.rivet.dev/agent-os/latest/software/manifest.json`, ~18 MB) is upstream **git 2.55.0** built for WASI with mbedTLS libcurl. That came from rivet-dev/agentos#1733 (merged 2026-07-16).

It is *not* the same as the npm `@agentos-software/git@0.3.3`, which is a small Rust mini-git that answers `GitSubcommandUnsupported`. Both report version 0.3.3, which is why we first concluded git was blocked.

Repro: `timeout 240 npx tsx git-probe.ts [https-repo-url]` (allow-all network, both CPU budgets disabled).

| Operation | Result |
|---|---|
| `git --version` | `git version 2.55.0` |
| `git clone https://github.com/octocat/Hello-World.git` | OK, ~3 s |
| `git fetch --no-progress --no-tags origin` (+ `-c http.proxyAuthMethod=basic`) | OK, ~1.8 s |
| `git worktree add -b wt-test ../wt HEAD` | OK |
| `git add` + `git commit` | OK |
| `git clone --depth 1` then `git fetch --depth 1` | **FAIL**: `fatal: shallow file has changed since we read it` |

## Known gaps

- **`fatal: fork failed: Function not implemented`** after fetch/commit. This is git's detached auto-gc/maintenance calling `fork()`, which WASI lacks. The command itself succeeds. Silence it with `-c gc.autoDetach=false -c maintenance.autoDetach=false`, or set `gc.auto=0`.
- **Shallow fetch fails.** git compares the stat data of `.git/shallow` before and after reading it (`stat_validity_check`). Likely cause: agentOS VFS stat returns unstable fields (mtime/ino/size) for that file. Not yet investigated. This is a candidate upstream issue/PR, and it matters if a runner clones shallow.
- `warning: templates not found in /home/runner/share/git-core/templates` is harmless; it's a build-time prefix baked into the binary.
- rivet-dev/agentos#1920 (open since 2026-08-29, no replies) reports `errno 21` on HTTPS clone with npm `@agentos-software/git@0.3.3`. The registry git in 0.4.1 doesn't have that problem.
