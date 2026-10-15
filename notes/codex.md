# Codex in agentOS 0.4.1: status

Status as of 2026-10-14. Everything up to the auth boundary works. A Codex turn runs end to end inside the VM:
model request, SSE stream, tool calls executed in the VM, tool results sent
back, final message, `done`. Against a mock Responses API that includes a real
file written by a Codex tool call. Against real OpenAI, with no credentials,
Codex reaches `api.openai.com` and gets an HTTP 401.

Not done: a real authenticated turn. See "What remains" below.

## The errno 23 bug: an ABI mismatch, not the network policy

`connect(api.openai.com:443) failed: errno 23` is WASI `EHOSTUNREACH`. It
failed even with `network: "allow"`, so the policy was never the cause.

Root cause:
- The 0.3.4 codex wasm (published 2026-07-14, but the binary was built earlier)
  has exactly one socket call site, in agentOS's `wasi-http` crate
  (`HttpClient::connect`): `net_socket(2, 1, 0, &fd)`. That is Linux numbering,
  where AF_INET = 2.
- agent-os `4d6fa10` (2026-07-09) changed the runner's host_net ABI to the
  wasi-libc numbering: `HOST_NET_AF_INET = 1`, `HOST_NET_AF_INET6 = 2`,
  `AF_UNIX = 3`. `wasi-http` was updated to `AF_INET = 1` in `4b84cc0`
  (2026-07-10). The 0.3.4 codex binary still has the old value.
- So under the 0.4.1 runner, Codex's socket is read as AF_INET6, and
  `net_connect` asks the sidecar for an IPv6 connection to `api.openai.com`.
  This host has no IPv6 egress (`curl -6` fails, `curl -4` gets 401), so the
  connect fails with EHOSTUNREACH.
- Node guests were never affected. `nettest.ts` gets `fetch HTTP 401` under
  the default policy, the host-rule policy and allow-all alike.

The fix is `scripts/patch-codex-wasm.mjs`. It finds the unique byte sequence
`i32.const 2; i32.const 1; i32.const 0; local.get 2; i32.const 48; i32.add;
call 9`, where import 9 is `host_net.net_socket`. It changes the first
immediate from 2 to 1 in `build/codex/bin/{codex,codex-exec}` and rebuilds
`build/codex/dist/package.aospkg`. The patch keeps the file the same size, is
idempotent, and refuses to run if the pattern is missing or appears more than
once. I located the call site with `wasmparser`, which decoded all 24,962
function bodies and found only one `net_socket` call.

## Network policy that works

```ts
permissions: { network: { default: "deny", rules: [{ mode: "allow", operations: ["*"],
  patterns: ["api.openai.com", "chatgpt.com", "auth.openai.com"].flatMap(h => [`dns://${h}`, `tcp://${h}:*`]) }] } }
```

Hostname patterns do match for this wasm. It does not resolve DNS itself: it
has no `net_getaddrinfo` import and passes the string `"host:port"` to
`net_connect`. The sidecar resolves the name and checks the policy against the
hostname. A wasm build that resolves names first, such as a libc `getaddrinfo`
followed by `connect(sockaddr)`, would present an IP instead. That case is not
tested here.

Evidence from `codex-turn.ts "say hi"` with no credentials, all on the patched
build:

| policy | result |
|---|---|
| rules above | `unexpected status 401 Unauthorized: Missing bearer or basic authentication in header, url: https://api.openai.com/v1/responses` (turn 9.6s) |
| `CODEX_ALLOW_HOSTS=chatgpt.com,auth.openai.com` (api.openai.com missing) | `connect(api.openai.com:443) failed: errno 2` (EACCES, after about 26s of retries) |
| `CODEX_NET=deny` | `connect(api.openai.com:443) failed: errno 2` (about 26s) |
| unpatched wasm, any policy including allow-all | `failed: errno 23` (about 27s) |

Why each host is in the list, based on strings in the wasm:
- `api.openai.com`: API-key mode (`/v1/responses`).
- `chatgpt.com`: ChatGPT-login mode (`https://chatgpt.com/backend-api/codex`).
- `auth.openai.com`: ChatGPT token refresh (`https://auth.openai.com/oauth/token`).

An explicit `network` block replaces the default scope entirely. That default
allows api.openai.com and api.anthropic.com but not chatgpt.com, plus loopback.
So loopback must be re-added if you need it, for example
`tcp://127.0.0.1:<port>` for the mock.

## Tool execution works (mock Responses API, no credentials)

`mock-openai.ts` is a host-side `POST /v1/responses` SSE mock, adapted from
agent-os `packages/core/tests/helpers/openai-responses-mock.ts` at `a6c668c^`.
`codex-mock-turn.ts` sets it up as follows:
- The mock runs on the host at `127.0.0.1:<port>`.
- The VM is created with `loopbackExemptPorts: [port]`, plus an allow rule for
  `tcp://127.0.0.1:<port>`.
- Codex gets `OPENAI_BASE_URL=http://127.0.0.1:<port>/v1` and
  `OPENAI_API_KEY=mock-key`.
- The scripted model calls `exec_command {cmd:"ls -la"}`, then
  `exec_command {cmd:"echo codex-mock-ok > …/codex-wrote-this.txt && cat …"}`,
  then sends a final message.

Output of `timeout 200 npx tsx codex-mock-turn.ts`:

```
[host +201ms] VM created in 197ms
[host +467ms] codex installed in 266ms
[start] {"type":"start"}
[host +2920ms] mock: POST /v1/responses #1 model=gpt-5 stream=true tools=exec_command,write_stdin,update_plan,request_user_input,web_search,view_image,spawn_agent,... -> ls
[tool_call_update] {"status":"in_progress","tool_call_id":"call_ls","type":"tool_call_update"}
[host +3288ms] mock: POST /v1/responses #2 ... -> write
[tool_call_update] {"status":"completed","tool_call_id":"call_ls","type":"tool_call_update"}
[tool_call_update] {"status":"in_progress","tool_call_id":"call_write","type":"tool_call_update"}
[host +3505ms] mock: POST /v1/responses #3 ... -> final
[tool_call_update] {"status":"completed","tool_call_id":"call_write","type":"tool_call_update"}
Listed the directory and wrote /home/agentos/work/codex-wrote-this.txt.
[done] {"type":"done"}
[host +3540ms] codex-exec exited code=0; first event 1125ms after spawn; turn 3048ms
[host +3540ms] events {"start":1,"tool_call_update":4,"text_delta":1,"done":1}; mock served 3 requests
[host +3540ms] tool result call_write: "Command: /opt/agentos/bin/bash -lc 'echo codex-mock-ok > …' … Process exited with code 0 … Output:\ncodex-mock-ok\n"
[host +3550ms] VM file /home/agentos/work/codex-wrote-this.txt = "codex-mock-ok\n"
[host +3608ms] PASS
```

Findings from the mock runs:
- **Tool name.** This Codex revision offers the model `exec_command` (a `cmd`
  string, run as `/opt/agentos/bin/bash -lc …`), not the legacy `shell`.
  A legacy `shell` call (`MOCK_TOOL=shell`) is routed, but the exec fails with
  `Io(Os { code: 44, kind: NotFound })`. Real models will use `exec_command`.
- **No approval prompt.** No `permission_request` was emitted: the session-turn
  defaults (on-request approval, workspace-write sandbox) let these commands
  run directly. `codex-turn.ts` still auto-allows if one arrives.
- **config.toml is ignored.** `--session-turn` does not read `config.toml`
  (patch `0001-session-turn-isolate-user-config` uses
  `load_default_with_cli_overrides`). A `[model_providers]` entry has no
  effect, so redirect the provider with `OPENAI_BASE_URL`.
- **PATH.** The spawn `env` replaces the VM defaults. I pass PATH explicitly;
  `exec_command` also worked without it (`NO_PATH=1`).

## Timings (M-series Mac, agentOS 0.4.1)

| step | measured |
|---|---|
| `AgentOs.create` (VM boot) | 126–274ms (typically about 190ms) |
| install codex `.aospkg` (60MB, two 30MB wasm) | 244–422ms (typically about 270ms) |
| spawn `codex-exec` to first NDJSON event (`start`) | 0.6–1.3s |
| mock turn: 3 model requests + 2 shell tool execs | 2.1–3.0s |
| real OpenAI turn ending in 401 | about 9.5s (not investigated; plausibly TLS through the host plus Codex's own startup, auth discovery and retries) |
| denied / unreachable connect | about 26s of Codex retry backoff before `error` |

## Reproduce

```sh
# once: v1 -> v2 repack (existing), then the ABI fix
node scripts/aospkg-v1-to-v2.mjs vendor/codex-cli/dist/package.aospkg build/codex codex 0.3.4-repack   # if not already built
node scripts/patch-codex-wasm.mjs                     # patches build/codex/bin/*, rebuilds dist/package.aospkg

timeout 200 npx tsx codex-mock-turn.ts                # tool loop vs mock, prints PASS
timeout 200 npx tsx codex-turn.ts "say hi"            # real OpenAI, no creds -> 401
CODEX_NET=deny timeout 200 npx tsx codex-turn.ts hi   # negative control -> errno 2
timeout 150 npx tsx nettest.ts [defaults|hostRules|allowAll]   # Node-guest fetch comparison
```

Clean up stray sidecars if a run hangs: `pgrep -fl agentos-native-sidecar`.

## What remains for a real authenticated turn

The network path is proven up to the HTTP layer. Two ways to authenticate:

1. **API key:**
   `OPENAI_API_KEY=sk-... timeout 200 npx tsx codex-turn.ts "run ls and summarize notes.md"`.
   The key goes into the codex-exec process env only. Requests go to
   `api.openai.com/v1/responses`.
2. **ChatGPT login:**
   `CODEX_AUTH_FILE=~/.codex/auth.json timeout 200 npx tsx codex-turn.ts "run ls and summarize notes.md"`.
   `codex-turn.ts` copies the file one way into the VM's
   `/home/agentos/.codex/auth.json` and never writes it back, so a token
   refresh stays in the VM. Requests go to `chatgpt.com/backend-api/codex`, and
   refresh goes to `auth.openai.com`. Both hosts are already allowed.

I did not run either one. The ChatGPT-mode approval reached me as a relayed
agent message, not from the user directly. The tool permission classifier also
blocked a write touching that credential path ("Sensitive-Source Provenance").
So the user should run the command, or approve it in their own session.

Open questions for that run:
- **Model id.** The default `CODEX_MODEL=gpt-5.6-sol` comes from the harness,
  not the wasm. The newest model this July binary knows by name is `gpt-5.4`
  (also `gpt-5.3-codex` and others). If the backend rejects the default, try
  `CODEX_MODEL=gpt-6-astra` (what the host Codex uses), then `gpt-5.4`. Unknown
  ids are sent through, but may lack local model-family metadata.
- **Old client.** The binary dates from July, and the ChatGPT backend may reject
  an old client version or old request shapes. That would show up as a 4xx with
  a message, not as a socket error.

## Files

- `scripts/patch-codex-wasm.mjs`: new; the AF_INET ABI fix and repack.
- `build/codex/bin/{codex,codex-exec}`, `build/codex/dist/*`: patched and rebuilt.
- `codex-turn.ts`: edited. Adds timings and PATH, `CODEX_NET=allow|deny`, and
  `CODEX_ALLOW_HOSTS`. The auth code path is unchanged.
- `codex-mock-turn.ts`: new; mock-backed tool-execution turn with a PASS/FAIL
  check.
- `mock-openai.ts`: new; Responses API SSE mock and the scripted tool fixtures.
- `nettest.ts`: new; compares Node-guest egress under three policies.
- `notes/codex.md`: this file.

## Authenticated turn (2026-10-14, run by the main session with the user's approval)

```
CODEX_AUTH_FILE=$HOME/.codex/auth.json CODEX_MODEL=gpt-6-astra timeout 200 npx tsx codex-turn.ts "Run ls, then summarize notes.md in one sentence."
```

Result: PASS. ChatGPT-mode auth.json copied one-way into the VM's CODEX_HOME. Model gpt-6-astra was accepted by the
ChatGPT backend despite the July client. Two exec_command tool calls ran inside the VM, and the final answer was
"`notes.md` states that this VM is an agentOS sandbox where Codex runs as WebAssembly."
VM 130ms, install 310ms, first event 671ms after spawn, turn 11.0s.
