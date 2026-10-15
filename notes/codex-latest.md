# Latest upstream Codex in agentOS 0.4.1

Status as of 2026-10-15. **Two builds of upstream `openai/codex` run in the agentOS 0.4.1 VM.**

- **`dist-stable`, the one to use for real turns:** release tag `rust-v0.162.1` (2026-10-09). This
  is the newest stable tag and the version the user's host Codex runs (`codex-cli 0.162.1`). The
  output is `build/codex-latest/dist-stable/package.aospkg`.
- **`dist`:** a snapshot of `main` (`bb64b894fd`).

Both pass the unchanged `codex-mock-turn.ts`: the model request goes to the host mock, two
`exec_command` tool calls run in the VM, the file is written, and the turn ends with `done`. Both
also pass the `apply_patch` turn and the plain `codex exec --json` CLI (upstream's in-process
app-server). Without credentials, the network path reaches `api.openai.com` and gets an HTTP 401.

**Main vs stable:** the coordinator's real ChatGPT turn on the **main** build got past auth and
network, but the backend rejected it with `Unknown parameter:
'input[1].internal_chat_message_metadata_passthrough.content_item_metadata'`. Main sends request
fields that production does not accept yet. `content_item_metadata` does not exist anywhere in
the `rust-v0.162.1` source; on main it is defined in `protocol/src/models.rs:997` and set in
`core/src/{client,compact}.rs`, `core/src/session/mod.rs` and `context-fragments`. So **real turns
need a released revision**, and `build.sh` now defaults to the newest stable tag.

Both builds still send the older `internal_chat_message_metadata_passthrough` object (with
`content_item_kinds`, `turn_id`, `create_time`) on every message (18 times in the mock turn),
exactly like the released CLI. The mock run on main did not trigger `content_item_metadata`
itself; that field appears with real-model context. The real-turn check on `dist-stable` is still
to do (main session).

Furthest stage: **mock turn PASS** (session-turn, apply_patch, `codex exec`) on both builds. The
coordinator's real ChatGPT turn on `dist-stable` (gpt-6-astra) got past the API: the backend
accepted the request and the model answered. Its tool calls then failed on code mode (see "Code mode",
fixed in patch 0007; see "Code mode" below). The rebuilt `dist-stable` needs a real re-run.

## Code mode (found on the real run, fixed by disabling it on wasi)

Symptom (real turn, gpt-6-astra): `ERROR codex_core::tools::router: failed to spawn code-mode host
/opt/agentos/bin/codex-code-mode-host: No such file or directory (os error 44)`, twice. The model
then said the execution tool failed to start.

What code mode is in 0.162.1:

- **Tools.** The model gets one freeform `exec` tool ("Run JavaScript code to orchestrate tool
  calls … in a fresh V8 isolate") plus `wait`. The direct tools (`exec_command`, `apply_patch`,
  …) are reachable only as `await tools.exec_command(...)` inside that JavaScript.
- **Host.** The JavaScript runs in `codex-code-mode-host`, a separate executable
  (`code-mode-host/`: axum + tonic gRPC server). It embeds `codex-code-mode-runtime`, which
  depends on `v8` (`features = ["v8_enable_sandbox"]`) and `deno_core_icudata`. Core talks to it
  through `ProcessOwnedCodeModeSessionProvider`, which spawns
  `InstallContext::code_mode_host_program()`; on a package layout that is `<bin dir>/codex-code-mode-host`.
- **How it is offered.** The bundled `models-manager/models.json` sets `"tool_mode":
  "code_mode_only"` for gpt-6-astra, gpt-6-sol, gpt-6.1-sol, gpt-6-luna, gpt-5.6-* and
  gpt-daybreak-*. `effective_tool_mode()` downgrades `code_mode` to direct tools when the host is
  unavailable, but it keeps `code_mode_only`. Separately, feature `code_mode_host` (Stage::Stable,
  default on) selects the process host provider. Config `features.code_mode` /
  `code_mode_only` can also request code mode. The tools are sent as an `additional_tools` input
  item (namespaces `functions`, `clock`, `collaboration`), not in the request's `tools` array,
  which is why the mock's tool log showed nothing at first.

Options considered:

- **(a) Build the host for WASI: rejected.** It is a V8 embedder; V8 is C++ with a JIT, which
  rules it out. Delegating to the VM's `node` would mean reimplementing the host's gRPC session
  protocol, which includes nested tool callbacks into Codex, timers and yield/`wait` cells. That
  is a rewrite, not a shim.
- **(b) Chosen: never use code mode on wasi.** Patch 0007 does two things. `code_mode_host`
  defaults to off on wasi (`default_enabled: !cfg!(target_os = "wasi")`), so the in-session code
  mode service is the disabled provider and nothing ever tries to spawn the host.
  `effective_tool_mode()` returns `ToolMode::Direct` on wasi before considering model or config,
  so even `code_mode_only` models get the direct tools. Both are compile-time `cfg` choices, not
  runtime flags.

After the fix, the request a gpt-6-astra session sends (mock, `dist-stable`):
`exec_command, write_stdin, request_user_input, request_user_input_async, apply_patch (freeform),
view_image, curr_time, sleep, followup_task, interrupt_agent, list_agents, send_message,
spawn_agent, wait_agent` (plus `web.run` in `codex exec`). Before the fix it was `exec, wait,
request_user_input, request_user_input_async, sleep, followup_task, …`.

Other tools that could spawn helper binaries (audit):

| tool / path | helper | status on wasi |
|---|---|---|
| `exec` / `wait` (code mode) | `codex-code-mode-host` (V8) | never offered (0007) |
| `apply_patch` (freeform, or `apply_patch` inside `exec_command`) | self-exe `--codex-run-as-apply-patch` / in-process | works: tested both ways |
| filesystem sandbox helper | self-exe `--codex-run-as-fs-helper` | `wasi_main` now dispatches it (0007); sandboxed opens already fail before spawning on wasi |
| `exec_command` / `write_stdin` | `/opt/agentos/bin/bash -lc` via exec-server | works |
| arg0 exec helper, `codex-linux-sandbox`, Windows sandbox/MXC | various | not compiled for wasi |
| bundled zsh (`shell_zsh_fork`) | `codex-resources/zsh` | not used (default shell is bash; feature off) |
| `web.run` (exec mode), `view_image`, `curr_time`, `sleep`, collaboration | none (HTTP / in-process) | collaboration is not exercised by the mock |
| `request_user_input` | none; needs a client answer | returns "unavailable in Default mode" to the model. Patch 0008 also auto-answers `RequestUserInput`/`RequestPermissions` in the engine so a turn can never block on them |

The mock now reproduces this:

- `mock-openai.ts` lists tools from both `tools` and `additional_tools`.
- `codex-mock-turn.ts` uses the real model slug (`gpt-6-astra`) when `CODEX_PKG` is set; the July
  path keeps `gpt-5`.
- The harness FAILs if `exec` or `wait` is offered (`MOCK_FORBID_TOOLS` overrides the list).

On the pre-fix `dist-stable` this printed `FORBIDDEN tools offered (need helper binaries agentOS
lacks): exec,wait` and `FAIL`. After the fix it prints PASS.



Reproduce (cargo takes about 4 minutes per build; a cold clone needs about 25 GB free):

```sh
AGENTOS_DIR=<agent-os clone with history> scripts/codex-latest/build.sh            # newest stable tag -> dist-stable/
AGENTOS_DIR=... scripts/codex-latest/build.sh bb64b894fd                            # main snapshot -> dist/
CODEX_PKG=build/codex-latest/dist-stable/package.aospkg timeout 240 npx tsx codex-mock-turn.ts
CODEX_PKG=build/codex-latest/dist-stable/package.aospkg timeout 200 npx tsx codex-turn.ts "say hi"   # no creds -> 401
# real turn (main session):
CODEX_PKG=build/codex-latest/dist-stable/package.aospkg CODEX_AUTH_FILE=$HOME/.codex/auth.json CODEX_MODEL=gpt-6-astra npx tsx codex-turn.ts "..."
```

With `CODEX_PKG` set, both harnesses now create the VM with `limits.tls.maxBufferedBytes =
16 MiB` (override with `CODEX_TLS_BUF_BYTES`). The real main turn logged
`WARN_AGENTOS_RESOURCE_NEAR_LIMIT … tlsBytes used=847207 limit=1048576`. The sidecar rejects a TLS
buffer larger than `limits.resources.maxSocketBufferedBytes` (default 4 MiB), so that limit is
raised to match. Without `CODEX_PKG`, both harnesses use the July build with default limits; that
path was re-run and still prints PASS.

## The 10 s approval pause (root cause: agentOS stdin wake-up; fix in patch 0009)

**Symptom.** Every `apply_patch` took about 10 s longer than it should. The coordinator's real
turn took 42 s, partly because of this.

**Measured from the host.** `build/codex-latest/apply-patch-turn.ts` stamps each NDJSON event
with the host clock. Guest log timestamps are frozen inside the VM, so the engine also emits
guest-monotonic `timing` events when `CODEX_WASI_TIMING=1` is set (`Instant`-based).

The env var had to be renamed from `AGENTOS_CODEX_TIMING`: variables starting with `AGENTOS_`
never reached the guest, so agentOS appears to filter that prefix from spawn env.

```
[+3890ms] [timing] {"ms":230,"phase":"patch_approval_request"}
[+3890ms] [permission_request] … -> allow          (host writes the answer immediately)
[+13900ms] [timing] {"ms":10240,"phase":"patch_decision_read"}     <- 10,010 ms in read(0)
[+13900ms] [timing] {"ms":10240,"phase":"patch_approval_submitted"}
[+14051ms] [timing] {"ms":10382,"phase":"patch_apply_end"}         <- the patch itself: 141 ms
```

So all 10 s is spent in the engine's blocking `stdin.read_line()` waiting for the
`permission_response`, which the host had already written. `codex exec` with approvals bypassed
(no stdin read) applies the same patch in 0.18 s (`EXEC_FIXTURE=patch
build/codex-latest/exec-mode-turn.ts`).

A Codex fan-out over 0.162.1 (4 parallel read-only questions) found no 10 s timer on the
apply_patch path: it runs in-process via the environment's `LocalFileSystem`, there is no child
process, and the approval wait has no timeout. That ruled out codex-core as the cause.

**Isolated with a 40-line C probe**, built with wasi-sdk against the agentOS libc:
`build/codex-latest/stdin-probe/` and `stdin-probe.ts`. The host writes a line 500 ms after the
guest starts `read(0)`:

```
== block
[host +967ms]  host: writeStdin #0
[host +10477ms] guest: round 0: read 7 bytes after 10012 ms
[host +10978ms] host: writeStdin #1
[host +20490ms] guest: round 1: read 7 bytes after 10011 ms
== nonblock   (fcntl O_NONBLOCK + 10 ms poll)
[host +559ms]  host: writeStdin #0
[host +564ms]  guest: round 0: read 7 bytes after 505 ms (5 ms after the write)
```

**Root cause (agentOS 0.4.1).** The WASM runner services a blocking `fd_read(0)` with the sync
RPC `__kernel_stdin_read(len, KERNEL_WAIT_SLICE_MS)`, where `KERNEL_WAIT_SLICE_MS = 10_000`
(`crates/execution/assets/runners/wasm-runner.mjs:1403`). The sidecar parks that RPC until the
deadline (`native-sidecar/src/execution/child_process.rs` ~8315, deferred kernel wait). Bytes
written with `vm.process.writeStdin()` are queued but do **not** wake the parked read, so they
are only picked up when the 10 s slice expires and the runner loops. A non-blocking read
(`WASI_FDFLAGS_NONBLOCK` → timeout 0) sees the queued bytes immediately. This affects every
WASM guest that blocks on stdin while the host writes to it, not just Codex.

The proper fix is in the agentOS sidecar: when host stdin bytes are queued for a process,
re-evaluate any parked `__kernel_stdin_read`/`__kernel_poll` for it. That means rebuilding the
sidecar, which wasn't possible here.

**Fix (patch 0009, Codex side).** `session_turn_wasi.rs` replaces `stdin().read_line()` with
`StdinLines`. It sets `O_NONBLOCK` on fd 0 via `libc::fcntl`, reads with `libc::read`, and on
`EAGAIN` awaits `tokio::time::sleep` (2 ms, backing off to 25 ms), which also lets codex-core
tasks run while it waits. It is used for the start message and for both approval paths (exec
and patch). This is the same mechanism the probe verified (5 ms latency). Expected effect:
about 10 s less per approval, so the apply_patch mock turn should drop from 13.4 s to about 3.5 s.

**Not yet built or measured.** Disk fell to 2.7 GB free (from other work on the machine). On
the coordinator's instruction I stopped building and removed `target/debug`, `target/release`
and the incremental dirs. The current `dist-stable/package.aospkg` (built 01:41) is the verified
build plus the env-gated timing events, without the stdin fix. To verify, once at least 10 GB is
free:

```sh
STEPS="source wasm pack mock" scripts/codex-latest/build.sh            # rust-v0.162.1 -> dist-stable
CODEX_WASI_TIMING=1 CODEX_PKG=build/codex-latest/dist-stable/package.aospkg npx tsx build/codex-latest/apply-patch-turn.ts
AP_VIA=shell CODEX_PKG=… npx tsx build/codex-latest/apply-patch-turn.ts
CODEX_PKG=… npx tsx build/codex-latest/exec-mode-turn.ts
```

## 1. Drift assessment

### The fork is older than it looks

`rivet-dev/codex@8f4655a9` (branch `wasi-port-codex-core`) is **upstream from 2026-03-20**
(`4f28b64ab`) plus 10 commits. It is not a July rebase; the commits are dated June and July.
Upstream main is 7,560 commits ahead of the merge base.

| fork commit | what it touches |
|---|---|
| 8b8d4e3c9 skeleton | `exec/src/lib.rs` → `lib_native.rs` split; cfg gates in core/exec/pty `Cargo.toml` |
| 0c3f4eb73 core+exec compile | network-proxy: rama gated off, 6 `*_wasi.rs` stubs; otel: OTLP gated off; core `exec.rs` signal/exit-status arms; `config_loader`, `rmcp-client`, `utils/git` wasi arms; workspace drops `network-proxy`/`otel` members |
| b86a5dfc0 engine | new `exec/src/session_turn_wasi.rs` (NDJSON protocol over codex-core) |
| e0f603fd7 | `sqlite3_load_extension` stub |
| 4598db184 | rollout recorder: UTC fallback when `now_local()` fails |
| 167cdca91 / 58c4f0a86 / cc828fd32 | diagnostics; force the HTTP transport (`responses_websocket_enabled()` → false on wasi) |
| 9909c590c | wasi gates in `git_info.rs`, `shell_snapshot.rs`, `state_db.rs`, `rollout/recorder.rs`; `scripts/build-wasi-codex-exec.sh`; `docs/wasi-build.md` |
| 8f4655a9d | vendors `tokio-wasi` (tokio 1.52.3 plus WASI process/fs/net, 557 files) |

agentOS then applied **11** source patches on top, not 8: `toolchain/std-patches/codex/0001..0011`.
They are 0001 config isolation, 0002 tool events, 0003 approval ids, 0004 apply-patch child,
0005/0007 build-script sysroot and panic-runtime handling, 0006 workspace-write, 0008 disable
unified exec, 0009 reasoning effort, 0010 `ReasoningEffort::{Max,Ultra}`, and 0011 canonical
message events. The full pipeline was `toolchain/scripts/clone-and-build-codex-wasi.sh`
(at `a6c668c^` = `63ae3b2`). It ran a shallow clone at the pin, `patch -p1` of 0001–0011,
rewrote `[patch.crates-io]` to the toolchain stubs (reqwest-shim, portable-pty-wasi, ctrlc),
ran `cargo vendor` plus `patch-vendor.sh` crate patches, and finally ran the fork's build script
with the agentOS patched wasi-libc on the link line.

### Cherry-picking the 10 commits onto main

Applying the commits one by one to upstream main (`git cherry-pick`) gave this:

| commit | result |
|---|---|
| 8b8d4e3c9 | conflicts: `core/Cargo.toml` (4 hunks), `exec/src/lib.rs` (2), `exec/src/main.rs` (1), `utils/pty/Cargo.toml` (1) |
| 0c3f4eb73 | conflicts in 11 files; `core/src/config_loader/mod.rs` deleted upstream |
| b86a5dfc0, e0f603fd7, 167cdca91, 58c4f0a86 | "clean": they only add `session_turn_wasi.rs`, which no longer compiles against upstream APIs |
| 4598db184 | `core/src/rollout/recorder.rs` deleted upstream (moved to the `codex-rollout` crate) |
| cc828fd32 | `core/src/client.rs` conflict |
| 9909c590c | `Cargo.lock` (27 hunks), `shell_snapshot.rs`; `git_info.rs`/`state_db.rs` deleted upstream |
| 8f4655a9d | `shell_snapshot.rs` (3 hunks) |

Of the 31 non-vendor files the fork touched, 18 no longer exist at those paths. A rebase is not
meaningful, so I re-ported the intent of each change instead (see §2).

### What changed upstream that matters

- **Size.** The crate graph `codex-core` pulls in for wasm32-wasip1 went from 38 codex crates /
  208k LOC (March) to **91 crates / 625k LOC**. Platform `cfg` sites went from 374 to 1,250, and
  `std::os::unix`/`libc::` uses went from 134 to 836. That metric turned out pessimistic: most
  new code is portable or already cfg-correct.
- **`codex exec` is now an app-server client.** `codex-exec` depends on `codex-app-server-client`,
  which runs `codex-app-server` in-process. The fork's lib/lib_native split was written for the
  old direct-core exec.
- **Tool execution goes through `codex-exec-server`.** It uses `EnvironmentManager`, `LOCAL_FS`,
  no-follow fs operations, and fs-sandbox helper processes that pass fds over `SCM_RIGHTS`.
- **`ThreadManager::new` takes 15 arguments.** Upstream ships `thread-manager-sample` and a
  `codex-core-api` facade, which became the template for the new engine.
- **New network stacks in the wasi graph:** rama (network proxy → socket2 → libc sockets),
  `codex-http-client` (reqwest with a route-aware pool, native-tls plus rustls), aws-sdk
  (Bedrock), tonic (remote thread config, OTLP), axum (exec-server, rmcp OAuth callback),
  rmcp with reqwest 0.13, gix, and sqlx. v8 (code mode) is **not** in the wasi graph.
- **No WASI support upstream.** There are zero `target_os = "wasi"` / `wasm32` cfgs in
  `codex-rs`.
- **Environment variables.** `OPENAI_API_KEY` is no longer a model-auth source (only
  `CODEX_API_KEY`), and `OPENAI_BASE_URL` is replaced by the `openai_base_url` config key.

## 2. What I ported, and how

The patch series is `scripts/codex-latest/patches/codex/0001..0009`, applied with `git am`.
It applies to `bb64b894fd` (main) and to `e89b7c442c`. On `rust-v0.162.1` the only conflict is
`Cargo.lock`, which `build.sh` resolves automatically (see below). Excluding `Cargo.lock`, it is
about 600 changed lines, most of them the new engine (`session_turn_wasi.rs`, 478 lines).

Restructured for stable: the first series split `exec/src/lib.rs` into `lib.rs` plus a full copy
in `lib_native.rs`. That copy conflicted as soon as `lib.rs` differed (on the release branch).
Since the full `codex exec` CLI now compiles for wasi anyway, `lib.rs` stays upstream's, with a
gated `ctrl_c` and an appended wasi block (`mod session_turn_wasi`, `wasi_main`,
`wasi_native_main`; +75 lines). `main.rs` gets a 5-line early `return codex_exec::wasi_main()`.

| patch | content |
|---|---|
| 0001 build plumbing | `[patch.crates-io]` pointing at `wasi-deps/` (tokio-wasi, reqwest shim, portable-pty, ctrlc, plus 12 patched crates.io crates, including `gix-fs` 0.19 for the release branch); `zip` without bzip2/lzma/zstd C deps; `native-tls` native-only in `codex-http-client`; `wxc_common` Windows-only in `codex-mxc-sandbox` |
| 0002 exec | `exec/src/session_turn_wasi.rs` rewritten on `codex-core-api` (ThreadManager, EnvironmentManager, thread store, `start_turn_if_idle`); wasi `main` → `wasi_main()`; the full `codex exec` CLI on wasi (`wasi_native_main`: current-thread runtime, no arg0 thread); app-server shutdown signal; `lmstudio` paths; no `ctrl_c` in exec |
| 0003 | `codex-rollout`: UTC fallback when `now_local()` fails (fork 4598db184) |
| 0004 | `core/guardian/decision.rs`: approval review runs as a tokio task instead of a new OS thread (`apply_patch` failed with "automatic approval review could not complete", os error 6) |
| 0005 | `core/client.rs`: `responses_websocket_enabled()` is false on wasi (fork cc828fd32) |
| 0007 | code mode never used on wasi (`code_mode_host` default off; `effective_tool_mode()` → Direct); `--codex-run-as-fs-helper` dispatch (see "Code mode") |
| 0008 | session-turn engine auto-answers `RequestUserInput` (no answers) and `RequestPermissions` (nothing granted) |
| 0009 | session-turn engine reads stdin non-blocking with a polling loop (fixes the 10 s pause per approval), plus `CODEX_WASI_TIMING=1` guest-monotonic `timing` events |
| 0006 WASI arms | `path-uri` (OsStrExt via `std::os::wasi`; `Platform::native()` = Linux), `path-utils`, `uds` (Unsupported platform module), `git-utils` (`symlink_path`, fork intent), `state` (file id from dev/ino), `config` (`/etc/codex/*.toml`), `arg0`, `rmcp-client` (fork intent), `exec-server` (`no_follow/wasi.rs` on std::fs, `FileExt` read_at/write_at, sandboxed open → error), `core/exec.rs` (fork's `wait_ctrl_c` and `synthetic_exit_status*` arms) |

Fork and agentOS patches that I did not port, and why:

- **0001 config isolation:** kept (`Config::load_default_with_cli_overrides`).
- **0011 canonical message events, 0009 reasoning effort, 0003 approval ids:** kept in the
  engine.
- **0010 Max/Ultra:** now upstream.
- **0004 apply-patch child:** replaced by resolving `codex_self_exe` (from `CODEX_SELF_EXE`,
  then `PATH`, then `/opt/agentos/bin`) plus the apply-patch argv handler. `apply_patch` is
  tested, see §4.
- **0008 disable unified exec:** dropped. Upstream unified exec (`exec_command`) works in the
  VM, and the mock's `exec_command` calls rely on it.
- **9909c590c `shell_snapshot`/`git_info`/`state_db` gates:** not needed. The shell snapshot is
  disabled by the feature override, the engine passes no state DB, and git info was not on the
  turn path.
- **Rollout "don't persist" gate:** not needed once tokio's mandatory blocking ran inline (see
  below).

`--session-turn` protocol: the events are the same as the July engine (`start`, `text_delta`,
`reasoning_delta`, `tool_call_update`, `permission_request`, `done`, `error`), and the stdin
messages are the same. Differences:

- `tool_call_update` for a finished exec puts upstream's `aggregated_output` in `stdout`, and
  `stderr` is `""`. Upstream dropped the separate fields.
- A fatal setup error now emits `{"type":"error"}` before exiting non-zero. Previously it only
  printed to stderr.
- `TurnAborted` maps to `error`.
- For compatibility, the engine maps `OPENAI_API_KEY` → `CODEX_API_KEY` and `OPENAI_BASE_URL` →
  `-c openai_base_url`. It also sets `ephemeral = true` and disables websockets.
- The workspace version is stamped from the newest stable tag (`0.162.1`). Upstream main is
  `0.0.0`, and the ChatGPT backend gates models on `client_version`.

## 3. Build blockers and how each was handled

Third-party crates. All are patched copies under `wasi-deps/patched/`; the diff is in
`patches/wasi-deps.patch`, and `stage-wasi-deps.sh` reproduces the tree exactly (verified).

| blocker | crate | fix |
|---|---|---|
| `openssl-sys` build script | native-tls via codex-http-client | native-only dependency (0001) |
| `lzma-sys` C build | zip default features | zip with `deflate`, `time` only |
| socket2 0.6: "doesn't support the compile target" | rama-net, hyper-util | **libc**: expose the wasip2 BSD socket declarations on p1 (agentOS wasi-libc implements them over host_net); **socket2**: treat p1 like p2 |
| missing socket options on wasi | rama-net `opts.rs` (15 errors) | wasi-gate the options; unsupported enum arms panic |
| `bind_socket` / `tokio_util::udp` | rama-tcp, rama-udp | add wasi to unix/windows cfg lists; drop `UdpFramed` export |
| `tokio::net::{UdpSocket,TcpSocket}` missing on p1 | hickory-proto (via rama-dns) | inert stand-ins in tokio-wasi `net/wasip1_stubs.rs` |
| socket2 in HTTP connector | hyper-util (aws-sdk, tonic, axum, reqwest 0.13) | socket2 non-wasi; `connect()` returns Unsupported on wasi |
| `tokio::net::UnixStream` | tonic uds connector | reuse the Windows dummy type on wasi |
| `default_signal` | tokio-graceful | pending future on wasi |
| no platform module | rustls-native-certs, gethostname | agentOS empty-certs patch; `$HOSTNAME`/"agentos" |
| `reqwest::blocking`, cookies, Proxy, `Request` accessors, `http_body::Body` | reqwest shim (agentOS July scaffold) | shim rewritten to reqwest 0.12 fidelity for `codex-http-client`: streaming `Body` over `RawBodyReader`, `Client::execute`, inert proxy/cookie/TLS config, `http::Response` conversions, a blocking client |
| `HttpClient for reqwest::blocking::Client` cfg'd off wasm32 | opentelemetry-http | allow on wasi |
| `aws-lc-sys`, `ring`, `zstd-sys`, `libsqlite3-sys`, `tree-sitter` | C deps | **no change needed**; all build with wasi-sdk 25 clang |
| `std::os::unix` in `symlink.rs`, no `Capabilities::default` (stable only) | gix-fs 0.19.2 (`rust-v0.162.1` pins gix 0.81; main uses gix 0.89 / gix-fs 0.24, which build) | WASI `symlink_path` and the unix default; the `[patch]` entry is unused on main |
| ref's own `Cargo.lock` (stable) | socket2 0.6.3 and gix versions without WASI patches | on a `Cargo.lock` conflict, `build.sh` takes the patch's lock (the tested third-party versions) and lets cargo fix up workspace members |

Rust std. These run after agentOS's 14 std patches, from `patches/std/`:

- **0001:** wasip1 `TcpListener::accept` no longer imports `wasi_snapshot_preview1.sock_accept`.
  The 0.4.1 runtime does not provide it, and instantiation failed with "LinkError … sock_accept:
  function import requires a callable". tiny_http/mio pulled it in.
- **0002:** `File::lock` and friends are no-ops on wasi. Upstream locks the installation-id file
  and others; this was failing with "lock() not supported".
- **0003:** `env::current_exe()` on wasi resolves `argv[0]` (absolute, then `$PATH`, then
  `/opt/agentos/bin`). The packaged-defaults config layer needs it for `codex exec`.

tokio-wasi: `spawn_mandatory_blocking` now runs inline, like `spawn_blocking`. tokio::fs::File
writes go through it, and the rollout writer was failing with "background task failed".

Linking uses agentOS's patched wasi-libc: 45 patches plus 22 overrides at `a6c668c^`, built by
`build-wasi-libc.sh` without the libc++ rebuild, with wasi-sdk 25. The new wasm imports 26 host
functions the July binary did not (`host_fs.*`, `host_net.net_bind/listen/poll/validate_socket`,
`host_process.fd_*`, `host_user.isatty`, and a few `wasi_snapshot_preview1` calls). All of them
except `sock_accept` exist in the 0.4.1 sidecar.

Sizes: `dist-stable` is 83.2 MB per wasm (166 MB `.aospkg`). Profile history: the first link was 124 MB, of which 54.5 MB was the wasm `name` section. The
default profile is now `strip=symbols`, `lto=thin`, `opt-level=z`. That gives **59.5 MB** for
`--session-turn` only and **85.0 MB** with the full `codex exec` CLI (the `dist/` main package). The `dist/` package was built from the
earlier 7-patch form of the series (the `lib_native.rs` split); the code is the same, and it was left as is. No
`wasm-opt` is installed. A clean build takes about 4 minutes on 14 cores.

## 4. Results (exact runs)

Stable (`rust-v0.162.1`, `dist-stable`):

```
CODEX_PKG=build/codex-latest/dist-stable/package.aospkg timeout 240 npx tsx codex-mock-turn.ts
[host +1083ms] codex installed in 864ms
mock: POST /v1/responses #1 ... -> ls / #2 -> write / #3 -> final
codex-exec exited code=0; first event 1071ms after spawn; turn 3915ms
events {"start":1,"tool_call_update":6,"text_delta":1,"done":1}; mock served 3 requests
VM file /home/agentos/work/codex-wrote-this.txt = "codex-mock-ok\n"
PASS
```

The other stable runs:

- **apply_patch** (`CODEX_PKG=…dist-stable… npx tsx build/codex-latest/apply-patch-turn.ts`,
  model gpt-6-astra): a direct freeform `apply_patch` call (`AP_VIA=shell` uses the
  `exec_command` heredoc form instead). `permission_request` → allow → "Success. Updated the
  following files". Then a `request_user_input` call returns an error to the model without
  hanging, and the final message arrives. PASS both ways (turn 13.3–13.5 s, including the 10 s
  pause in §5).
- **`codex exec --json`** (gpt-6-astra): PASS (turn 5.2 s). It logs one warning item, "Code Mode
  is unavailable because code-mode host is disabled. Falling back to direct tools".
- **No credentials** (`codex-turn.ts`, with the 16 MiB TLS limit): `401 … api.openai.com/v1/responses`.

Main (`bb64b894fd`, `dist`) runs follow.

`CODEX_PKG=build/codex-latest/dist/package.aospkg timeout 240 npx tsx codex-mock-turn.ts` (85 MB build):

```
[host +927ms] codex installed in 705ms
[start] {"type":"start"}
mock: POST /v1/responses #1 ... tools=exec_command,write_stdin,request_user_input,view_image,multi_agent_v1,web_search -> ls
[tool_call_update] {"command":"/opt/agentos/bin/bash -lc ls -la","kind":"execute","status":"in_progress",...}
mock: POST /v1/responses #2 ... -> write
mock: POST /v1/responses #3 ... -> final
Listed the directory and wrote /home/agentos/work/codex-wrote-this.txt.
[done] {"type":"done"}
codex-exec exited code=0; first event 1579ms after spawn; turn 4427ms
events {"start":1,"tool_call_update":6,"text_delta":1,"done":1}; mock served 3 requests
VM file /home/agentos/work/codex-wrote-this.txt = "codex-mock-ok\n"
PASS
```

Other runs:

- **`apply_patch`** (`build/codex-latest/apply-patch-turn.ts`, via `exec_command "apply_patch <<'EOF'"`):
  `permission_request` (kind `edit`) → allow → `"Success. Updated the following files: A …"`.
  The file was written. PASS.
- **`codex exec --json`** (`build/codex-latest/exec-mode-turn.ts`, argv `--json
  --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox -m gpt-5 -c openai_base_url=…`,
  `CODEX_API_KEY=mock-key`): `thread.started`, `turn.started`, two `command_execution` items, and
  `turn.completed`. Turn 5.5 s. PASS.
- **No credentials** (`codex-turn.ts "say hi"`): `unexpected status 401 Unauthorized: Missing
  bearer … url: https://api.openai.com/v1/responses` after 10.5 s. This is the same as July, and
  confirms the AF_INET=1 ABI fix is carried in source, by wasi-http and libc.
- **Fake ChatGPT `auth.json`** (made-up JWT, written to the scratchpad): `GET
  https://chatgpt.com/backend-api/codex/models?client_version=0.162.1` → 401, then a token
  refresh to `auth.openai.com` → 401 `token_expired`. ChatGPT-mode auth loading and its hosts
  are wired.

| step | July build | this build |
|---|---|---|
| install .aospkg | ~0.27 s (60 MB pkg) | 0.50 s session-turn-only / 0.72 s full (2 × 85 MB) |
| spawn → first event | ~0.6 s | ~1.0 s / ~1.5 s |
| mock turn (3 requests, 2 execs) | 2.5–3.0 s | 3.8 s / 4.3 s |

## 5. Remaining work

1. **Real authenticated turn on `dist-stable`** (main session, about 10 minutes). Run `CODEX_PKG=build/codex-latest/dist-stable/package.aospkg CODEX_AUTH_FILE=… CODEX_MODEL=gpt-6-astra
   npx tsx codex-turn.ts "…"`. The things to watch are model gating by `client_version=0.162.1`
   and an `rmcp` worker that connects to the ChatGPT apps MCP server at startup (it logged a
   fatal 401 with fake creds; this is not on the turn path).
2. **10 s pause after every approval.** Root cause found and fixed in source (patch 0009);
   the rebuilt binary is **not verified yet** because the disk ran out (see "The 10 s
   approval pause" above).
3. **Non-fatal noise:** `Could not create otel exporter: Resource temporarily unavailable (os
   error 6)` in `codex exec` (the otel provider spawns a thread). Gate it, or use the tokio task
   pattern from 0005 (under 1 hour).
4. **Package size:** 2 × 85 MB. Ship `codex` as a wrapper or alias instead of a second copy,
   gate the CLI path behind a feature for a session-turn-only build (59.5 MB), and try `wasm-opt
   -Oz` once binaryen is available (half a day).
5. **Keeping up:** for each new stable release, run `scripts/codex-latest/build.sh` (it picks the
   newest `rust-vX.Y.Z` tag). Building main (`build.sh <sha>`) is only useful for previewing,
   because the production backend may reject main's request shape. Conflicts
   will mostly land in `session_turn_wasi.rs` (ThreadManager/Config API churn) and in new
   unix/windows-only cfgs. Use `check-round.sh` plus `widen.py` for those. Expect under an hour
   per week of drift, judging by how fast the frontier fell here: 12 check rounds took codex-core
   from 12 failing crates to 0.
6. **Upstreaming:** most of 0003–0006 are small, target-agnostic fixes (UTC fallback, thread-less
   approval review, a cfg for wasi in path/uds/fs code). The engine and the shims are agentOS-specific.
7. **Not done:** the TUI (`codex` interactive) was not attempted.

## Files

- `scripts/codex-latest/build.sh [REF]`: the whole pipeline: clone, tools, std, libc, source
  (`git am` + stage wasi-deps), wasm, pack, mock. REF defaults to the newest stable tag. Tags build
  into `src-stable/`, `out-stable/` and `dist-stable/`; other refs into `src/`, `out/` and `dist/`
  (`BUILD_SUFFIX` overrides). Steps are selectable via `STEPS=`; `CODEX_VERSION` stamps main.
- `scripts/codex-latest/{env.sh,build-wasi-libc.sh,build-wasm.sh,stage-wasi-deps.sh,pack.sh}`:
  the steps.
- `scripts/codex-latest/{check-round.sh,widen.py}`: iteration helpers. `cargo check` for wasm32
  with an error summary, and widening `cfg(unix)` to wasi.
- `scripts/codex-latest/patches/codex/*.patch` (9), `patches/std/*.patch` (3),
  `patches/wasi-deps.patch` (tokio-wasi, reqwest shim, wasi crates, 11 crates.io crates).
- `codex-turn.ts`, `codex-mock-turn.ts`: added a `CODEX_PKG` env override and, only when it is
  set, the larger TLS and socket buffer limits. `codex-mock-turn.ts` also uses model
  `gpt-6-astra` and checks for forbidden tools when `CODEX_PKG` is set (`CODEX_MOCK_MODEL`
  overrides the model). The July defaults are unchanged.
- `mock-openai.ts`: `toolNames()` (walks `tools` and `additional_tools`), `FORBIDDEN_TOOLS`,
  `forbiddenToolsSeen()`.
- `build/codex-latest/` (gitignored): clones (`upstream`, `fork` with worktrees `src`, `pin`,
  `march`), `agentos-toolchain/`, `wasi-libc/`, `sysroot/`, `target/`, `out/`,
  `dist/package.aospkg`, logs, and scratch harnesses `apply-patch-turn.ts` and
  `exec-mode-turn.ts`. `target/` is 18 GB (check plus release profiles); the disk is at 97%.
  `rm -rf build/codex-latest/target/wasm32-wasip1/debug` frees the check artifacts.
- Toolchain: rustup was not installed before; I installed it with `--no-modify-path` plus
  `nightly-2026-03-01` (rust-src, wasm32-wasip1). rustup made that nightly the default because
  no default existed. Its rust-src is patched in place (agentOS 14 + 3 patches).

## Verified after rebuilding with 0009 (2026-10-15, main session)

`STEPS="clone source wasm pack mock" scripts/codex-latest/build.sh` (rust-v0.162.1, 9 patches) recompiled in 4m42s.

| Check | Before 0009 | After 0009 |
|---|---|---|
| apply_patch turn (`apply-patch-turn.ts`, direct) | 13.4 s | **3.2 s** |
| apply_patch turn (`AP_VIA=shell`) | ~13.5 s | **3.3 s** |
| `codex exec` mock turn | 5.2 s | 5.6 s, PASS |
| Real turn, gpt-6-astra (write primes.js via apply_patch, run with node) | 42 s | **26.5 s**, correct output |

The real turn also used `rg`, which `vm-tools.ts` now installs from the agentOS registry.
