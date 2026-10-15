# Claude Code on agentOS 0.4.1 — findings (2026-10-14)

Short version:

| Question | Answer |
| --- | --- |
| 1. Does Rivet's July package (`@agentos-software/claude-code@0.2.7`) run on 0.4.1? | **Yes.** Repacked to v2, it reports **`2.1.87 (Claude Code)`**. `--help` works. `-p` reaches a real 401 from api.anthropic.com. Driven through its ACP adapter against an in-VM mock model, it runs a **full turn, including the Bash tool executing inside the VM**. |
| 2. Can a current Claude Code (2.1.300) run? | **Yes, as an unofficial rebuild, including the Bash tool.** npm has had no pure-JS build since **2.1.112 (2026-04-16)**. The JS source is still embedded in the Bun executable, and I extracted it. After rebundling, shimming and patching, 2.1.300 runs `--version`, `--help` and `self-hosted-runner --help`, and `-p` reaches a real 401. A full mock turn with the Bash tool now **PASSes**: the tool writes `out.txt` in the VM and the host reads it back (see "2.1.300 Bash tool"). |
| 3. Could `claude self-hosted-runner` work? | **Not today.** The runner process itself boots in the VM: it parses flags, sets up its watchdog and dials RegisterRunner. Child spawn, signals, piped streaming, HTTPS, loopback SSE and (now) the Bash tool all work. Two things block it. (a) ~~git~~ **Corrected:** the npm `@agentos-software/git@0.3.3` is a mini-git, but the 0.4.1 *registry* git is real git 2.55.0. Clone, fetch, worktree and commit all work over HTTPS; only shallow fetch fails (see `notes/git.md`). (b) **Any process waited on by a guest WASM shell is killed after ~2 min of wall time.** The shell busy-polls while waiting, which burns its own 30 s CPU budget (`limits.wasm.runnerCpuTimeLimitMs`); set that limit to 0. There are further risks: no bwrap/socat sandbox, and an unofficial rebundled build that has to track every release. |

All VM runs used `timeout`. No real credentials were used: the only key was `sk-ant-api03-dummy-not-a-real-key`. No runner was pointed at Anthropic's control plane; the runner test dialed `http://127.0.0.1:9`.

---

## 1. July Rivet package (Claude Code 2.1.87)

### Repack (v1 → v2)

The v1 payload (chunk3 tar) is already a JS closure:

- `bin/claude` → `../node_modules/@agentos-software/claude-code/dist/claude-cli.mjs` (symlink)
- `bin/claude-sdk-acp` → `…/dist/adapter.js`
- a root `package.json` with a `bin` map
- a hoisted `node_modules/` tree (5,602 entries)

`agentos-toolchain build` keeps only `bin/` + `share/`, so it would drop `node_modules`. `pack` would re-run npm. Instead, `scripts/aospkg-v1-to-v2-closure.mjs` extracts chunk3, writes a v2 `agentos-package.json` (name, version, and `provides.env` taken from Rivet's `agent.env`), and re-encodes the tree with the toolchain's exported `packAospkgFromTar`. `--prune-native` drops 7 vendored native files (rg, audio-capture, sharp/libvips). The result is 65 MB, against 100 MB for v1.

```sh
node scripts/aospkg-v1-to-v2-closure.mjs vendor/claude-code/dist/package.aospkg build/claude \
     vendor/claude-code/agentos-package.json --prune-native
# packed: { name: 'claude', version: '0.2.7', commands: [ 'claude', 'claude-sdk-acp' ] }
```

### Runs (`claude-probe.ts`: installs, then runs commands with Rivet's env vars + HOME/PATH)

```sh
timeout 300 npx tsx claude-probe.ts                       # --version, --help, -p "hi" (no key)
CLAUDE_PROBE_NET=1 CLAUDE_PROBE_DUMMY_KEY=1 timeout 300 npx tsx claude-probe.ts build/claude/dist/package.aospkg -- '<cmd>' ...
```

Evidence (`build/claude/run1.log`, `run2.log`, `run3.log`, `run5-debug.log`):

```
installed claude@0.2.7 in 348ms; commands: [ 'claude', 'claude-sdk-acp' ]
$ node --version           -> v22.0.0
$ claude --version         -> 2.1.87 (Claude Code)
$ claude --help            -> Usage: claude [options] [command] [prompt] ... (full help)
$ claude -p "hi" (no key)  -> Not logged in · Please run /login
$ claude -p "hi" (dummy key, net allowed to api.anthropic.com)
   -> Invalid API key · Fix external API key
   debug: [API REQUEST] /v1/messages ... 
          API error (attempt 1/11): 401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"},"request_id":"req_011Cg3NAmftb3PMvaQ22rTm3"}
$ claude -p hi --output-format stream-json --verbose
   -> {"type":"system","subtype":"init",...,"claude_code_version":"2.1.87","tools":["Bash","Edit","Read"],"model":"claude-sonnet-4-6",...}
```

### Full agent turn (no credentials): `claude-acp-turn.ts`

`claude-mock-api.mjs` is a ~90-line fake Messages API. It runs **inside** the VM on 127.0.0.1:8788. On the first call it returns a streamed `tool_use: Bash`; on the next call it echoes back the `tool_result` it receives. The network policy allows only 127.0.0.1.

0.4.1 dropped the core ACP session API (a6c668c), so `claude-acp-turn.ts` spawns `claude-sdk-acp` and speaks ACP JSON-RPC over its stdio directly: `initialize` → `session/new` → `session/prompt`, auto-allowing `session/request_permission`.

```
$ timeout 280 npx tsx claude-acp-turn.ts            # build/claude/acp-turn-2.1.87.log
initialize -> {"protocolVersion":1,"agentInfo":{"name":"claude-sdk-acp",...}}
session/new -> {"sessionId":"88d3611f-...","modes":{"currentModeId":"default",...}}
  [tool_call] Bash status=pending {"command":"echo hello-from-bash; uname -sm; ls / | head -5; git --version 2>&1 | head -1",...}
  <- request_permission Bash -> allow_once
  [text] MOCK SAW TOOL RESULT:
hello-from-bash
Linux wasm32
bin boot dev etc home
error: command not found: git
  [tool_call_update]  status=completed
session/prompt -> {"stopReason":"end_turn"} after 2069ms
```

### Quirks seen with 2.1.87

- **Exit code 137 on every `-p` exit.** agentOS implements `process.exit()` by *throwing* `ProcessExitError`. I verified this: `node -e "try{process.exit(3)}catch(e){console.log(e.name)}"` prints `ProcessExitError`. Claude Code does `try{process.exit(n)}catch{process.kill(process.pid,"SIGKILL")}`, so the throw turns into a self-SIGKILL. The 2.1.300 build is patched for this (see below); the 2.1.87 package is not.
- **Plain `claude -p` with the patched 2.1.87 CLI never executes tools.** It emits the `tool_use`, then exits 0 during shell-snapshot creation. That bundle is meant to be driven by Rivet's ACP adapter, which works.
- The patched CLI prints `[agentos-claude] …` trace lines to stderr. There is also intermittent `INFO_AGENTOS_STALE_BRIDGE_COMPLETION` sidecar noise.
- `claude --help | head` (a pipe through the WASM `sh`) and `claude --help > file` produced **no output**, while directly captured stdout was fine. I saw this on both versions and did not investigate it.
- **Network is open by default.** Without a `permissions.network` option, `AgentOs.create()` reached api.anthropic.com and got a real 401 (`run4-nonet.log` and a re-check). The docs say network is "denied until granted". **Corrected:** this is expected. With no `permissions.network`, the sidecar's built-in default allowlist applies (`crates/native-sidecar-core/src/permissions.rs:72-119`), and it includes api.anthropic.com, api.openai.com, generativelanguage.googleapis.com and openrouter.ai. Pass an explicit `{default:"deny", rules:[…]}` to lock it down further.

## 2. Current Claude Code (2.1.300)

### What npm ships

The registry packuments show the pure-JS line ended on 2026-04-16:

- `@anthropic-ai/claude-code`: last pure-JS release **2.1.112**, 49 MB `cli.js`. From 2.1.113 (2026-04-17) it is a ~130 KB wrapper (`bin/claude.exe`) plus 8 per-platform optionalDependencies.
- `@anthropic-ai/claude-agent-sdk`: last pure-JS release **0.2.112**. From 0.2.113 it uses native per-platform packages too.

Neither ships a pure-JS build for any version ≥2.1.113, which includes everything with `self-hosted-runner` (≥2.1.224).

`extractFromBunfs.js` in SDK 0.3.300 is not a CLI extractor. It copies a file out of a Bun app's own `$bunfs` so the app can spawn it.

### Extracting the JS from the Bun executable

I downloaded `@anthropic-ai/claude-code-linux-arm64@2.1.300` (120 MB tgz; one 266 MB ELF `claude`) into its own directory. The binary has a `.bun` ELF section (file offset 96,468,992; 169,703,125 bytes) laid out as `u64 len | data | Offsets(32 B) | "\n---- Bun! ----\n"`. The module table holds 2,651 records of 52 bytes each: name, contents, sourcemap, bytecode, module_info and origin-path pointers, plus encoding/loader/format/side bytes. Entry is module 6, `/$bunfs/root/cli`.

**Every JS module ships its full source next to its JSC bytecode** (`// @bun @bytecode` header), so the JS is fully recoverable:

- 2,401 `.js` files
- 139 zstd assets
- 79 `.md` files
- 2 `.node` addons (clipboard, audio-capture)

`scripts/claude-bunfs/bunfs_list.py <claude> <outdir>` lists and extracts them. The entry begins `// Version: 2.1.300`.

### Bun-isms, and the fix for each

All of these were found by running, not just by grepping.

| Problem | Evidence | Fix (in `scripts/claude-bunfs/`) |
| --- | --- | --- |
| Absolute `"/$bunfs/root/chunk-*.js"` specifiers | every import | rewrite to `./` |
| `import.meta.require(...)` (494 sites), including **synchronous require of ESM chunks that are in a cycle** | Node: `ERR_REQUIRE_CYCLE_MODULE` | replace with `require`, then **re-bundle the whole graph with esbuild** (`rebundle.mjs`, splitting ESM). esbuild's lazy `__esm` init reproduces Bun's semantics. 1,742 output files, 65 MB. |
| `using` / `await using` (44 chunks) | V8 12 (Node 22) can't parse them | esbuild `supported:{using:false}` |
| Bun text/file loaders: `require("./x.md")` returns a string | `SyntaxError: Unexpected token '<'` | custom `require` wrapper in the banner. It is named `__bunRequire` because agentOS injects its own lexical `require` into ESM: `Identifier 'require' has already been declared`. |
| zstd-compressed embedded assets read via `Bun.zstdDecompressSync` | `Bun is not defined` | decompress at build time; the reader falls back to raw bytes |
| `globalThis.Bun.*` with no `typeof Bun` guard: hash, which, spawn, file, semver, deepEquals, YAML, TOML, JSONL, stringWidth, sliceAnsi, wrapAnsi, stripANSI, sleepSync, stdin, unsafe, … (~35 APIs) | | `bun-shim.js` built on npm `yaml`, `smol-toml`, `semver`, `string-width`, `slice-ansi`, `wrap-ansi`, `strip-ansi`. Bare `ws` (a Bun builtin) is installed from npm. |
| **`Bun.ant.*`**: Anthropic's internal Bun fork (`CellSegmenter`, `getPeerPid/Uid`, `memoryPressureLevel`, `windowsSandboxDeniesArg`) | `"This runtime has no Bun.ant.CellSegmenter. Run Claude Code on the @anthropic-ai/bun-internal version pinned in package.json."` | `CellSegmenter` (the TUI renderer's segmenter/painter) is reimplemented in JS in `bun-ant.js` and exposed as `Bun.ant` by `bun-shim.js`; see "Interactive TUI". The rest stay undefined: every call site feature-tests them or wraps them in try/catch. |
| `bun:jsc`, `bun:ffi` | dynamic imports only | left external |

### agentOS 0.4.1 Node-compat gaps it hit

`agentos-fixups.mjs` patches each of these. `claude-builtin-check.ts` produced the export list in `build/claude/builtin-gaps.txt`.

- **Missing ESM named exports from builtins.** All of these exist through CJS `require`, but not as ESM named exports:
  - `buffer.constants`
  - `fs.fchmod`, `fs.fchmodSync`, `fs.fchown`, `fs.fsync`, `fs.ftruncateSync`
  - `os.devNull`, `os.getPriority`, `os.setPriority`, `os.uptime`

  These are missing entirely: `crypto.X509Certificate`, `crypto.randomInt`, `util.getSystemErrorName`, `zlib.createZstdDecompress`, `perf_hooks.monitorEventLoopDelay`. These pass an `in` check but are `undefined`: `util.isDeepStrictEqual`, `crypto.timingSafeEqual`, `url.domainToASCII` (`build/claude/tui/builtin-undef-check.ts`). `agentos-fixups.mjs` supplies JS fallbacks for `randomInt`, `getSystemErrorName`, `isDeepStrictEqual`, `timingSafeEqual` and `domainToASCII`; the TUI hit the first and third.

  Fix: rewrite every `import {a as b} from "<builtin>"` as a namespace import with a `?? ns.default?.a` fallback (458 files).
- **No `import.meta.dirname` / `import.meta.filename`** (152 sites). Polyfilled from `import.meta.url`.
- **`async_hooks.AsyncResource.bind(fn)()` calls the class without `new`**: `TypeError: Class constructor AsyncResource cannot be invoked without 'new'`. Patched to identity in the shim.
- **`process.exit` throws**, which triggers Claude Code's SIGKILL fallback (exit 137). Patched so the exit propagates. After the patch, `-p` with a bad key exits `1`.
- **`/proc/self/fd/N` resolves, but paths through it don't.** `readlink`, `stat` and `readdir` of `/proc/self/fd/13` work. `open /proc/self/fd/13/f` gives ENOENT, and `mkdir` or `write` there gives `EROFS` (`build/claude/fsprobe3.mjs`). Claude Code ≥ some version uses `/proc/self/fd/<dirfd>/<name>` for TOCTOU-safe file ops on Linux (62 sites). This is what broke the Bash tool: `Shell exec error: EROFS … /proc/self/fd/77/-home-agentos-work`. It is now fixed at runtime by `agentos-entry.mjs`; root cause, the CPU-budget "spin", and the fix are in **"2.1.300 Bash tool"** below.

### Build and run

The scratch paths are session-local; re-run `bunfs_list.py` to regenerate them.

```sh
python3 -I scripts/claude-bunfs/bunfs_list.py <dl>/package/claude <S>/extract-cc-2.1.300
npm install --prefix <S>/node-cc-2.1.300 ws@8 yaml@2 smol-toml@1 semver@7 string-width@7 slice-ansi@7 wrap-ansi@9 strip-ansi@7 --ignore-scripts
scripts/claude-bunfs/pipeline.sh <S> "$PWD" [name] # -> build/claude/<name>/package.aospkg (default cc-2.1.300, 78 MB)
```

`<S>` is only read; the rebundled intermediate goes to `build/claude/<name>/rb`. `repack-cc.sh`, which `pipeline.sh` calls, assembles the tree. `bin/claude` points to `lib/entry.mjs` (`agentos-entry.mjs`: the procfs and TTY shims, then `cli.js`). `lib/trace-entry.mjs` is a diagnostic entry. `agentos-package.json` carries Rivet's env vars.

Results (`run6`–`run12` logs, `agent-loop-2.1.300*.log`):

```
installed claude2@2.1.300 in 337ms; commands: [ 'claude' ]
$ claude --version   -> 2.1.300 (Claude Code)
$ claude --help      -> Usage: claude [options] [command] [prompt] ...
$ claude self-hosted-runner --help -> Usage: claude self-hosted-runner [options] ... (also in the VM when stdout is captured directly; empty when piped)
$ claude -p "hi" (dummy key) -> Invalid API key · Fix external API key   exit=1
   debug: API error (attempt 1/11): 401 {... "invalid x-api-key"},"request_id":"req_011Cg3PKSxcjHMsPaJTEpehr"}
agent loop vs in-VM mock (claude-agent-loop.ts ... --permission-mode bypassPermissions):
  [system/init] tools=3 version=2.1.300
  [assistant] tool_use:Bash({"command":"echo hello-from-bash; ..."})
  [user] tool_result:"EROFS: EROFS: read-only filesystem: /tmp/claude-1000/-home-agentos-work"   (before the procfs fix)
  -> now: PASS, see "2.1.300 Bash tool"
```

In the default "auto" permission mode, 2.1.300 also sends ~10 non-streaming classifier calls (`claude-sonnet-5`) before running a tool. Against the mock those calls fail, so the tool is blocked.

### Is it plausible?

Technically yes: 2.1.300's JS is on V8 and talks HTTPS from inside agentOS. But this is an unofficial, heavily patched rebuild:

- esbuild rebundle
- Bun shim
- 8 classes of agentOS-compat fixups
- features that need Anthropic's Bun fork (`Bun.ant`) disabled

Every release would need re-extraction. Realistic paths:

- **Option 1:** agentOS fixes `/proc/self/fd/N/<child>` traversal, the missing builtin exports, `import.meta.dirname`, `AsyncResource.bind`, and the `process.exit` semantics.
- **Option 2:** pin the last pure-JS release, **2.1.112**. It is too old for `self-hosted-runner`.

## 2.1.300 Bash tool (root causes, fix, PASS)

### Result

`claude-bash-turn.ts` runs the following loop entirely inside one VM:

1. The mock Messages API asks for `Bash: echo hello-from-bash > /home/agentos/work/out.txt && uname -a`.
2. Claude Code runs the command.
3. The `tool_result` goes back to the mock.
4. The mock answers, and the turn ends with `end_turn`.
5. The host reads `out.txt` out of the VM filesystem.

The network policy allows only the VM's loopback, and the API key is a dummy.

```
$ timeout 300 npx tsx claude-bash-turn.ts            # build/claude/bash-turn-pass.log
[host +2076ms] VM created in 2070ms
[host +2766ms] installed claude2@2.1.300 in 690ms
[host +8596ms] claude -p finished: outcome=succeeded in 4225ms
  [system/init] claude_code_version=2.1.300 tools=Bash,Edit,Read
  [assistant] tool_use Bash {"command":"echo hello-from-bash > /home/agentos/work/out.txt && uname -a","description":"probe"}
  [user] tool_result is_error=false "Linux agentos 0.0.1-agentos #1 AgentOS Linux-in-WASM wasm32 GNU/Linux"
  [assistant] text "MOCK SAW TOOL RESULT:\nLinux agentos 0.0.1-agentos #1 AgentOS Linux-in-WASM wasm32 GNU/Linux"
  [result/success] is_error=false num_turns=2 duration_ms=1731 stop_reason=end_turn
  exit=0
[host +8812ms] host read /home/agentos/work/out.txt: "hello-from-bash\n"
PASS
```

**Timings.** VM create takes 0.1–2 s, and install takes 0.3–0.7 s. The `claude -p` turn takes 3.0–4.8 s, with 0.9 s of that spent in the Bash tool dispatch (`[Stall] tool_dispatch_end … durationMs=863`). The whole script takes 4–9 s; it was faster on an idle machine.

**Harness knobs:**

- `TURN_DEBUG=1`: write and tail the `--debug-file`.
- `TURN_PROCFD_LOG=1`: print the shim's path translations.
- `TURN_TRACE=1`: route through `lib/trace-entry.mjs`, which logs fs and child_process calls with stacks.
- `TURN_CPU_MS` / `TURN_WASM_CPU_MS`: set the VM limits.
- `TURN_PS=1`: dump the guest process table.
- `TURN_WATCHDOG_MS`: fail fast (default 15 s) if no `tool_result` reaches the mock after it served the `tool_use`. When it fires, it dumps `ls`, the process table, and debug/trace tails.

### Variant matrix

`./claude-bash-matrix.sh` runs 4 VMs in parallel and takes about 22 s. The variants come from `scripts/claude-bunfs/make-variants.sh`.

| variant | result | evidence |
| --- | --- | --- |
| `main`: procfs entry shim (`agentos-entry.mjs`) | **PASS** | `tool_result is_error=false "Linux agentos …"`, host read `"hello-from-bash\n"`, turn 4.8 s |
| `noshim`: `bin/claude` → `cli.js` directly | FAIL | `tool_result is_error=true "EROFS: EROFS: read-only filesystem: /tmp/claude-1000/-home-agentos-work"` |
| `rewrite`: blind template rewrite, with `__bunPfd` defined outside the rewritten files | PASS | same as main, 4.8 s |
| `rewrite-self`: my first workaround exactly | FAIL | `WATCHDOG: no tool_result reached the mock within 15000ms`. Without the watchdog it ran until `…CPU-time budget…` |

### Root cause 1: EROFS, because agentOS procfs can't traverse `/proc/self/fd/N`

**What Claude Code does.** `pinWriteTarget` (`TS`/`Ii` in the rebundle; Codex trace verified by the trace log) creates the Bash tool's output file `/tmp/claude-<uid>/<cwd-slug>/<session>/tasks/<id>.output` "openat-style" and race-safe:

1. Open the nearest existing ancestor with `O_PATH|O_DIRECTORY` (flags 0x290000).
2. For each missing component, `mkdir("/proc/self/fd/<dirfd>/<name>")`, then `open(…, O_PATH|O_DIRECTORY|O_NOFOLLOW)`.
3. Verify every step with `readlink("/proc/self/fd/<fd>")` (the `ZNr` helper).

Evidence from the trace log (`TURN_TRACE`):

```
fs.openSync /tmp/claude-1000/-home-agentos-work/<session>/tasks fd2686976 -> THROW ENOENT
      at D3 (chunk-7EWKNPRR.js:702) at Ii (…:1037) at TS (…:964)
...  (walks up)  ...
fs.openSync /tmp/claude-1000 fd2686976 -> fd36
```

Then, with no shim, `mkdir /proc/self/fd/36/-home-agentos-work` fails with EROFS.

**What agentOS procfs supports** (`fsprobe3.mjs`, plus a Codex trace of `crates/kernel/src/kernel.rs`):

- An *exact* `/proc/self/fd/N` is followed for readlink, stat, readdir, realpath and read-only open. Readlink returns the real path; it is not self-referential.
- Anything with components after N fails. `resolve_proc_node` has no 4-component fd case and returns ENOENT (kernel.rs ~7551).
- Pathname writes (mkdir, write_file) hit the blanket `is_proc_path` read-only guard and return **EROFS** (kernel.rs 6562–6566, `is_proc_path` 9374).

Linux treats `/proc/self/fd/N` as a magic link that path walk *traverses*. agentOS doesn't.

**Fix (in the bundle; reproducible).** `scripts/claude-bunfs/agentos-entry.mjs` becomes `lib/entry.mjs`, the package's `claude` bin. Before `cli.js` and its chunks evaluate, it wraps every path-taking function on the guest's `fs` and `fs/promises` objects. This works because agentOS's ESM builtin namespaces are live views of those objects, which I verified. The wrapper rewrites `/proc/self/fd/N/<tail>` (non-empty tail only) to `readlink("/proc/self/fd/N") + "/" + tail`, which is exactly the directory the kernel would traverse to. An exact `/proc/self/fd/N` is left alone, so readlink of the link itself stays native and correct.

Translations seen in the PASS run (`TURN_PROCFD_LOG=1`):

```
/proc/self/fd/36/-home-agentos-work -> /tmp/claude-1000/-home-agentos-work
/proc/self/fd/37/82c33fcb-… -> /tmp/claude-1000/-home-agentos-work/82c33fcb-…
/proc/self/fd/38/tasks -> /tmp/claude-1000/-home-agentos-work/82c33fcb-…/tasks
/proc/self/fd/39/bnzw82ams.output -> …/tasks/bnzw82ams.output
```

The cost is weaker race protection: the fd → path lookup and the operation happen in two steps. That's acceptable inside a VM.

**Where the real fix belongs: agentOS, as a procfs gap.** It needs the sidecar rebuilt, so I did not do it. The change (from the Codex trace, checked against the probe behavior) goes in `crates/kernel/src/kernel.rs`:

- Add `resolve_proc_fd_descendant(pid, path)`. It maps `/proc/<self|pid>/fd/<N>/<tail…>` (tail non-empty) to `entry.description.path()` + `/` + tail. It must use `path()`, not the display path that may end in " (deleted)". It returns ENOTDIR for non-directory fds.
- Call it before proc parsing, DAC checks and the read-only guard: in `fd_open` (~4828, before `validate_fd_open_flags`), `write_file_for_process` (~1528), `mkdir_for_process` (~1616), and the other process pathname APIs (stat/lstat/readlink/readdir/realpath/rename/unlink/rmdir).

### Root cause 2: the "CPU-budget spin" was a bug in my workaround, and the kill came from the WASM shell's budget

**The spin.** My first workaround was a regex in `agentos-fixups.mjs` that rewrote every `/proc/self/fd/${x}` template literal in the output to `${globalThis.__bunPfd(x)}`. `__bunPfd` itself was defined in `bun-shim.js`, which esbuild inlines into `cli.js`, so the regex **also rewrote `__bunPfd`'s own body**. `scripts/claude-bunfs/semdiff.cjs` (spinning build vs passing build) shows it:

```
old: globalThis.__bunPfd = (fd) => { try { return readlinkSync(`${globalThis.__bunPfd(fd)}`); }
                                     catch { return `${globalThis.__bunPfd(fd)}`; } };
```

That is unbounded mutual recursion inside try/catch. Each stack overflow is caught and immediately recursed again, so it spins on pure JS forever and makes no further fs calls. That matches the trace exactly: the last call is the open of `/tmp/claude-1000`, the trace's 3 s dump timer never fires again, and nothing more reaches the mock. Neither Claude Code nor agentOS had a recursion of their own. Codex (agentOS repo) confirmed that stack overflows produce no per-occurrence side effects.

The `rewrite` variant keeps the same blind rewrite but defines `__bunPfd` outside the rewritten files, and it **PASSes**. The `rewrite-self` variant reproduces the spin. The final fix (the entry shim) translates paths at call time and doesn't rewrite the bundle at all; `agentos-fixups.mjs` no longer touches `/proc` paths.

**Why raising `cpuTimeLimitMs` "didn't reach" the process.** It did. The guard that killed the turn was a *different* one: the **WASM `sh`** running `claude …; echo` had its own budget.

How the budget is configured (Codex trace, then verified at runtime):

| What | Detail |
| --- | --- |
| Fields | `limits.jsRuntime.cpuTimeLimitMs` for guest node processes; `limits.wasm.runnerCpuTimeLimitMs` for WASM commands (sh, coreutils). Both are per VM, set in `AgentOs.create({limits})`. |
| Defaults | 30,000 ms each (`native-sidecar-core/src/limits.rs:58`). `0` disables a budget (`v8-runtime/src/session.rs:941`). |
| Scope | One budget per process execution. It measures that execution thread's CPU over the process's whole life; it is not reset per callback, so a long-lived process eventually exhausts it. |
| Children | Spawned children inherit the VM values. I verified node direct, shebang scripts, package commands, `child_process.spawn` children, `sh -c` compounds, callbacks and dynamic imports (`build/claude/cpu-limit-check*.ts`). |
| Error text | The WASM runner reuses the same V8 guard and error string, so its kills **misleadingly name `limits.jsRuntime.cpuTimeLimitMs`** (session.rs:3139). |

Evidence:

- Spin build with `TURN_CPU_MS=120000`: two guards are visible, `observed=96004 capacity=120000` (claude's JS budget, as configured) and `bounded limit exhausted … capacity=30000`, and the second one kills the turn.
- With `TURN_WASM_CPU_MS=5000`, it dies at `capacity=5000` after 23 s.
- With both limits set to 0, it ran past the 200 s harness timeout.

Why a waiting shell burns CPU (Codex, `crates/execution/assets/runners/wasm-runner.mjs:7391/7439`, `native-sidecar/src/execution/child_process.rs:7360/8661`): `proc_waitpid` loops on `child_process.poll(wait_ms=10)`, but the sidecar ignores `wait_ms` and returns immediately, so the wait is a busy poll. I verified it with idle children (`build/claude/shell-wait-budget.ts`):

```
idle node via sh (wasm default)  -> failed after 115978ms | Error: Script execution exceeded the CPU-time budget (limits.jsRuntime.cpuTimeLimitMs)
sleep 150 via sh (wasm default)  -> failed after 125916ms | (same)
idle node via execFile (no sh)   -> succeeded after 150552ms
idle node via sh (wasm 0)        -> succeeded after 150991ms
```

So **any command that runs under a guest shell for more than ~2 minutes is killed by default**, regardless of what the child does. That includes `vm.process.exec`, a Bash-tool command such as a long build, and a runner started via a shell. The same pipe/shell plumbing also explains a separate quirk: `node … | cat` fails with `cat: -: Resource temporarily unavailable`, which is why `claude --help | head` printed nothing.

Remedies, in order:

1. Pass `limits: { jsRuntime: { cpuTimeLimitMs: 0 }, wasm: { runnerCpuTimeLimitMs: 0 } }` (or large values) for long-lived workloads.
2. Use `execFile`, not a shell, for the top-level process.
3. agentOS should honor `wait_ms` in `child_process.poll` (or use the existing `pumpSpawnedChildrenOrWait`), and name the right limit in the error.

### Repro commands

```sh
# build (pipeline.sh -> repack-cc.sh installs agentos-entry.mjs as lib/entry.mjs)
scripts/claude-bunfs/pipeline.sh <S> "$PWD"
scripts/claude-bunfs/make-variants.sh "$PWD"                # noshim / rewrite / rewrite-self variants
timeout 300 npx tsx claude-bash-turn.ts                      # PASS
TURN_PROCFD_LOG=1 TURN_DEBUG=1 timeout 300 npx tsx claude-bash-turn.ts
./claude-bash-matrix.sh                                      # 4 variants in parallel, ~22 s
# the spin + which guard kills it (watchdog disabled so the budget fires; dies at capacity=5000 after ~23 s)
TURN_WATCHDOG_MS=600000 TURN_CPU_MS=0 TURN_WASM_CPU_MS=5000 timeout 200 npx tsx claude-bash-turn.ts build/claude/cc-2.1.300-rewrite-self/package.aospkg
timeout 250 npx tsx build/claude/shell-wait-budget.ts        # shell busy-wait budget, ~2.5 min
node scripts/claude-bunfs/semdiff.cjs <spinning lib> <passing lib>
```

## 3. `claude self-hosted-runner` in agentOS

Probed in 2.1.300 with `claude-runtime-check.ts`; logs in `build/claude/runtime-check*.log` and `run12.log`.

- **The runner boots.** This was against a dead local URL, not Anthropic:

  ```
  claude self-hosted-runner --environment-secret-file /tmp/secret --api-url http://127.0.0.1:9 --base-dir /tmp/rw --capacity 1
  [runner] watchdog config: ... startup-timeout=15m (default) ...
  Connecting to http://127.0.0.1:9 (capacity=1, baseDir=/tmp/rw, execPath=/usr/bin/node /opt/agentos/pkgs/claude2/2.1.300/lib/cli.js)
  RegisterRunner attempt 1 transient failure (EACCES: ... tcp://127.0.0.1:9: blocked by network.http policy) — retrying
  [runner:fatal] RegisterRunner failed ...
  ```

  It also logged `A write to this process's stdout and stderr failed (ENOENT)`.
- **Process spawning works.** This is from guest Node `child_process.spawn` in `spawn-test.mjs`:

  ```
  child claude --version: {"code":0,"ms":54,"out":"2.1.300 (Claude Code)\n"}
  child stream-json: signal SIGKILL outLen 4247 lines 3 types system,assistant,result   (before the exit patch)
  kill sleep after 500ms: {"signal":"SIGTERM","ms":506}
  node child SIGTERM handler: {"code":0,"out":"got SIGTERM, cleaning up"}
  sh streaming child: firstByteMs 51 totalMs 1098 "tick 1\ntick 2\ntick 3\n"   (incremental, not buffered)
  ```

  Without the exit patch, every child `claude` reports SIGKILL/137. The runner treats abnormal exits as session failures (`startup_failure_reason`, "exits abnormally").
- **Networking and SSE work.** HTTPS to api.anthropic.com gets a real 401 with a request_id. Loopback SSE through guest `http` server + `fetch` streams incrementally: `event arrival ms: 319,616,918,1219,1523`, at 300 ms intervals. The network policy is per-host. I did not test long-held TLS SSE to Anthropic or the runner's real control-plane protocol.
- **git is a blocker.** The registry `@agentos-software/git@0.3.3` (v1; repacked into `build/claude/git`) is a 220 KB Rust *mini-git*:

  ```
  git --version  -> fatal: GitSubcommandUnsupported: git --version is not implemented in the secure-exec VM git command
  git status|fetch|worktree|help -> GitSubcommandUnsupported
  git clone https://github.com/octocat/Hello-World.git -> fatal: fetch info/refs failed: socket error: connect(github.com:443) failed: errno 21   (also with network "allow")
  git init (cwd /tmp/r) -> "Initialized empty Git repository in //.git/"   (ignores cwd)
  ```

  The runner shells out to full git, e.g. `git -C <dir> -c http.proxyAuthMethod=basic fetch --no-progress --no-tags --end-of-options origin <ref>`, plus worktree mode, `config` (12 sites), `checkout` and `push`. Upstream git built to WASM, with HTTPS smart-HTTP through mbedTLS libcurl and a real `git-remote-http`, exists in the agentOS **source** (7e971e9, 2026-07-08; `toolchain/c/scripts/build-git-upstream.sh` plus patches). I found no published package for it, so it would have to be built with the wasi C toolchain. The runner's `--hooks-dir` `checkout` hook could stand in for the built-in clone.
- **The shell tool inside sessions now works** in the 2.1.300 rebuild, with the procfs entry shim (see "2.1.300 Bash tool").
- **Claude Code's sandbox isn't available.** `which bwrap socat sandbox-exec` finds nothing. `uname -a` reports `Linux agentos 0.0.1-agentos #1 AgentOS Linux-in-WASM wasm32`. With `CLAUDE_CODE_SKIP_SANDBOX_INIT=1` sessions run unsandboxed, so the agentOS VM is the sandbox. Any managed policy that requires `sandbox.enabled` / fail-if-unavailable would refuse; not tested. The runner code itself has no bwrap/Seatbelt references; it only audits repo `sandbox.*` settings.
- **Long-lived process limits.** There are two CPU budgets, both 30,000 ms by default, both counted per process over its whole life, and both reported with the same error text.
  - `limits.jsRuntime.cpuTimeLimitMs` covers guest node processes.
  - `limits.wasm.runnerCpuTimeLimitMs` covers WASM commands such as `sh`.

  A WASM `sh` that is merely *waiting* on a child busy-polls, so it dies after ~115–125 s of wall time even when the child is idle. A long-lived runner needs **both set to 0**. Details in "2.1.300 Bash tool" → root cause 2.

The other blockers and risks:

- an unofficial rebuild with no `Bun.ant`
- the runner's server-side minimum-version floor ("runner version <X> is below minimum <Y>"), which means rebuilding for every release
- `--use-anthropic-git-proxy` and the proxy-authorization forward proxy assume real git and loopback listeners (untested)

## Files

- `scripts/aospkg-v1-to-v2-closure.mjs`: v1 → v2 repack that keeps the JS closure
- `scripts/claude-pack-tree.mjs`: pack a prepared tree into v2 `.aospkg`
- `scripts/claude-bunfs/`:
  - `bunfs_list.py`: Bun `.bun`-section extractor
  - `rebundle.mjs`: esbuild rebundle
  - `bun-shim.js`
  - `agentos-fixups.mjs`
  - `pipeline.sh`, `repack-cc.sh`
  - `agentos-entry.mjs`: the package entry with the procfs and TTY shims
  - `bun-ant.js`: JS `Bun.ant.CellSegmenter` for the TUI renderer
  - `trace-entry.mjs`: diagnostic entry with fs/child_process tracing
  - `make-variants.sh`: diagnostic package variants
  - `semdiff.cjs`: semantic diff of two rebundled lib dirs
- `tui.ts`, `tui-smoke.py`: interactive TUI bridge and its PTY-driven smoke test (see "Interactive TUI")
- `claude-bash-turn.ts`: 2.1.300 Bash-tool mock turn with the PASS check, watchdog and knobs
- `claude-bash-matrix.sh`: parallel variant runs
- `build/claude/cpu-limit-check*.ts`, `shell-wait-budget.ts`, `recursion-spin.ts`, `opath-check.ts`: limit and procfs experiments
- `claude-probe.ts`: install a package and run commands
- `claude-agent-loop.ts`: `-p` turn against the mock
- `claude-acp-turn.ts`: ACP turn through `claude-sdk-acp`
- `claude-mock-api.mjs`
- `claude-runtime-check.ts`: spawn/signals/git/SSE
- `claude-builtin-check.ts`: missing builtin exports
- `build/claude/`:
  - `dist/package.aospkg`: 2.1.87, v2
  - `cc-2.1.300/package.aospkg`: 2.1.300 rebuild
  - `git/dist/package.aospkg`: mini-git, v2
  - all run logs

Downloads went into their own scratchpad directories: the claude-code-linux-arm64 2.1.300 tgz, claude-agent-sdk 0.3.300 and @agentos-software/git 0.3.3. The scratchpad also holds the extracted bunfs tree and intermediate builds.

## Live demo on a real model (2026-10-14)

`demo-claude.ts` runs the 2.1.300 rebuild inside a VM, on the user's Max subscription, with a small JS project whose test fails (`median` uses lexicographic `.sort()`):

```sh
CLAUDE_CODE_OAUTH_TOKEN_FILE=~/.claude/agentos-demo-token timeout 600 npx tsx demo-claude.ts   # token from `claude setup-token`
DEMO_MOCK=1 timeout 300 npx tsx demo-claude.ts                                                  # plumbing only
```

**Result: DEMO PASS** (`build/claude/demo-live.log`)

- Model: claude-sonnet-5-5.
- Steps: 5 turns in 11.3 s, $0.028. Claude ran Bash (`ls`, `cat`, `node test.js`), then Edit (`.sort()` → `.sort((a, b) => a - b)`), then Bash (`node test.js` → "all tests passed").
- The host re-ran the tests independently and they passed.
- The VM network allowed only api.anthropic.com plus the OAuth refresh hosts. Both CPU budgets were 0.

### Gotchas found

- **Rivet's preset sets `CLAUDE_CODE_SIMPLE=1` (= `--bare`).** In bare mode, "Anthropic auth is strictly ANTHROPIC_API_KEY or apiKeyHelper (OAuth and keychain are never read)". The package also injects it as a VM-wide `provides.env` default, so deleting it from the exec env isn't enough; set it explicitly to `"0"` for subscription auth. With bare mode off, the full tool set loads: Task, Bash, Edit, Write, Read, NotebookEdit, WebSearch, Skill, Workflow, worktrees, cron, …
- **`~/.claude/.credentials.json` on macOS can be a stale leftover**; live creds are in the Keychain. Copying it gave "OAuth session expired and could not be refreshed". Use `claude setup-token` instead.
- **Quote the prompt with single quotes for the guest `sh`.** Backticks inside double quotes are command substitution and silently disappear.

## Interactive TUI (2026-10-15)

`tui.ts` runs the real interactive `claude` TUI (2.1.300 rebuild) inside an agentOS VM and bridges it to your terminal. Every tool call executes in the VM. **Track A works, so there is no host-side REPL (Track B).**

```sh
CLAUDE_CODE_OAUTH_TOKEN_FILE=~/.claude/agentos-demo-token npx tsx tui.ts [hostDir] [-- extra claude args]   # token from `claude setup-token`
ANTHROPIC_API_KEY=sk-ant-... npx tsx tui.ts [hostDir]
TUI_MOCK=1 npx tsx tui.ts                                  # no credentials: in-VM mock Messages API
python3 -I tui-smoke.py [--keep] [--transport pty]         # automated PTY-driven check, ~45 s, prints PASS/FAIL
```

- `hostDir` is copied into `/home/agentos/work`; `node_modules` and `.git` are skipped (`TUI_INCLUDE_GIT=1` copies `.git`). Without it, the work dir is an empty demo project. The VM is discarded on exit; `TUI_EXPORT_DIR=<new dir>` copies the work dir back out.
- Keys: everything goes to claude, Ctrl-C included (claude shows "Press Ctrl-C again to exit"). **Ctrl-] quits the bridge** at once, disposes the VM, and restores the terminal.
- The bridge puts the host tty in raw mode, forwards bytes both ways, and propagates resizes. On every exit path (`/exit`, Ctrl-], SIGTERM/SIGHUP/SIGINT from outside, uncaught errors) it leaves raw mode, resets mouse/focus/paste/kitty-keyboard modes, shows the cursor and leaves the alternate screen.
- Auth and network follow the demo. The token or key goes into the VM env with `CLAUDE_CODE_SIMPLE=0` set explicitly. The network allows api.anthropic.com, console.anthropic.com, platform.claude.com and claude.ai, or only loopback in mock mode. Both CPU budgets are 0.
- Knobs:
  - `TUI_PERMISSION_MODE` (default `bypassPermissions`: the VM is the sandbox; `default` prompts per tool, `auto` needs a real model for its classifier)
  - `TUI_MODEL`, `TUI_PKG`, `TUI_HEAP_MB` (default 4096)
  - `TUI_MAX_MINUTES` (session watchdog, default 240)
  - `TUI_LOG=<file>` (raw TUI bytes)
  - `TUI_SIDECAR_LOG` (default `$TMPDIR/agentos-tui-<pid>.log`)
  - `TUI_TRANSPORT=pipe|pty`

### Smoke test (mock, 110x34 pty driven from Python)

```
$ python3 -I tui-smoke.py
tui-smoke: driving `npx tsx tui.ts` (TUI_MOCK=1, TUI_TRANSPORT=pipe) on a 110x34 pty
  [ok] TUI renders (welcome + input box) - 5.3s after launch
  [ok] prompt round-trips to the in-VM mock
  [ok] mock's Bash tool ran inside the VM (uname: Linux agentos ... wasm32) - Linux agentos 0.0.1-agentos #1 AgentOS Linux-in-WASM wasm32 GNU/Linux
  [ok] Bash tool call is shown in the transcript - Ran 1 shell command
  [ok] resize propagates (box re-laid out from 110 to 130 cols) - rule width 110 -> 130
  [ok] Ctrl-C reaches claude and the host keeps running - Press Ctrl-C again to exit, host exit_status=None
  [ok] tui.ts exits 0 after /exit - exit=0
  [ok] VM shut down by tui.ts
  [ok] tui.ts read the Bash tool's file back from the VM - VM file /home/agentos/work/mock-proof.txt = "hello-from-vm\n"
  [ok] no in-VM child output leaked onto the terminal (env dumps, shell errors)
  [ok] host tty restored (cooked mode, echo, cursor visible, main screen) - {'icanon': True, 'echo': True} cursor_visible=True
  [ok] Ctrl-] quits the host bridge (exit 130, VM shut down, tty restored) - exit=130 ...
PASS (12/12 checks)
```

The test renders the byte stream with its own small VT100 emulator. Screen after the mock turn (`build/claude/tui/smoke-3-after-turn.txt`, blank rows trimmed):

```
 ▐▛███▛█   Claude Code v2.1.300
▝▜██████▀  Opus 5.5 · API Usage Billing
 ▝▝   ▝▝   ~/work

❯ run uname in the vm

  Ran 1 shell command

● MOCK SAW TOOL RESULT:
  Linux agentos 0.0.1-agentos #1 AgentOS Linux-in-WASM wasm32 GNU/Linux

✻ Sautéed for 1s · done 06:45:49
                                                                                          ◐ medium · /effort
──────────────────────────────────────────────────────────────────────────────────────────────────────────────
❯
──────────────────────────────────────────────────────────────────────────────────────────────────────────────
  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents
```

To render a capture yourself: `python3 -I build/claude/tui/render.py <TUI_LOG file> <cols> <rows>`. Read the file as bytes or with `newline=""`; Python's default text mode turns the renderer's `\r` into `\n` and makes a correct frame look garbled.

### What had to change, in the order the TUI hit it

Each step was found by running the TUI and instrumenting the bundle (`build/claude/tui/term-probe.ts` and debug copies of the package).

1. **`Bun.ant.CellSegmenter`** (`bun-ant.js`, exposed as `Bun.ant` from `bun-shim.js`). The 2.1.300 Ink renderer segments every line through this native class from Anthropic's Bun fork and paints the cells straight into the packed screen buffer. The API was reverse-engineered from the rebundle (the `rf` line-cells wrapper and the `sC`/`ag`/`Qx` callers):
   - `new CellSegmenter({ambiguousIsNarrow, substitute, screen})`.
   - Intern tables that grow in place: `graphemes`, `sgrKeys`/`sgrCloseKeys` (`\0`-joined SGR open and close codes, index 0 = none), and `uris` (index 0 = none).
   - `segment(text, cells, runs, reorder)` returns a count, or `-needed` if the buffers are too small. `cells[2i]` is the grapheme index and `cells[2i+1]` is `width | 256·tab | run<<10`. `runs[2r]` is the SGR key and `runs[2r+1]` the URI.
   - `paint(screenCells, w, x, y, cells, n, _, charIdx, words)` and `setCell(...)` return `endX + dmgStart·2^20 + dmgEnd·2^36`. The screen config is `widthMask 3, narrow 0, wide 1, spacerTail 2, spacerHead 3, emptyChar 0, spacerChar 1, tabWidth 8`.

   The semantics copy the last pure-JS renderer (2.1.87's `writeLineToScreen` and `setCellAt`, read from Rivet's 0.2.7 bundle):
   - SGR and OSC-8 parsing with ansi-tokenize's reduce rules
   - other escape sequences and C0 controls dropped
   - TAB to the next tab stop
   - zero-width graphemes dropped
   - a wide grapheme at the right edge becomes a spacer-head blank
   - overwriting half of a wide char blanks the other half
   - bidi controls replaced with U+FFFD

   Graphemes come from `Intl.Segmenter` and widths from `string-width` (`ambiguousIsNarrow`), which match the layout's own `Bun.stringWidth`. **Not implemented:** bidi reordering (`reorder`, only used on Windows Terminal and VS Code). A host unit check is in `build/claude/tui/seg-test.mjs`.
2. **`crypto.randomInt`** is missing ("eC is not a function" when the image-id allocator is constructed). **`util.isDeepStrictEqual`** is present but `undefined` ("OCt is not a function" in the plugin-theme store; this also broke `Bun.deepEquals`). Both now have fallbacks in `agentos-fixups.mjs`, along with `getSystemErrorName`, `timingSafeEqual` and `domainToASCII`.
3. **Guest `process.stdin` is not a stream.** On an agentOS TTY it is a minimal object: `on/off/once/emit/pause/resume/read/setEncoding/setRawMode`, with input delivered only as flowing `data` events. It has no `readable` event, `addListener`, `ref`/`unref`, `listeners`, `readableLength` or `unshift` (`build/claude/tui/tty-api-probe.ts`). Ink calls `stdin.ref()`, `addListener("readable")` and a `read()` loop. The first raw-mode mount threw `u.ref is not a function`.
   - **This build's React root error callbacks are lodash `noop`** (`createContainer(..., MJe, MJe, MJe, MJe)`), so the UI just silently unmounted: a blank alt screen, and the process idling forever.
   - Found by patching a debug copy's `createContainer` callbacks to log. That is the first thing to try if the TUI ever goes blank again.
   - Fix: `agentos-entry.mjs` adds the missing members and emulates paused-mode `readable`/`read()` on top of `data`. It is only installed when `addListener` is missing.
4. **Resize:** an agentOS PTY delivers SIGWINCH and updates `columns`/`rows` but never emits the tty `resize` event. The entry shim emits it once per size change.
5. **Heap:** the default guest V8 heap cap (~125 MiB) killed the TUI on its first turn ("exceeded the V8 heap limit (limits.jsRuntime.v8HeapLimitMb)"). `tui.ts` sets `v8HeapLimitMb: 4096`.
6. **Sidecar stderr:** agentos-core re-writes the sidecar's stderr (V8 worker-pool chatter, Rust WARN lines) and its own `console.error` diagnostics to the host's stderr, which scribbled over the TUI. `tui.ts` sends them to a log file.
7. **The PTY leak, which is an agentOS bug and the reason the default transport is pipes.** Everything a **WASM** process in a PTY session writes is also copied onto that PTY. That covers `sh`, coreutils and git, the Bash tool's output, and the shell snapshot's env dump with the API key or OAuth token. It happens even when the output is piped to the parent or redirected to a file (`echo x > f` leaks `x`). The copy is held until the next input write to the PTY, so it splashes over the TUI on your next keystroke.
   - Node children don't leak. Without a PTY nothing leaks. `terminal.open` and `javascript.spawnFile({pty})` behave the same.
   - Repro: `build/claude/tui/pty-leak-probe.ts [raw|cooked] [pty|js|pipe]`.
   - So `tui.ts` defaults to `TUI_TRANSPORT=pipe`. claude runs on plain stdio pipes via `vm.process.spawn`. The entry shim, enabled by `AGENTOS_PIPE_TTY=<size file>`, presents those pipes as a TTY: `isTTY`, raw mode as a no-op (pipes have no line discipline, so bytes already arrive raw), and `columns`/`rows` read from a size file. The host rewrites that file on resize and the shim polls it every 200 ms.
   - `TUI_TRANSPORT=pty` keeps the kernel PTY. `tui-smoke.py --transport pty` passes everything except the leak check, which finds `ANTHROPIC_API_KEY=`, `SHLVL=` and `command not found` in the stream.
   - The real fix is in the agentOS kernel/WASM runner. (The agentOS source wasn't available locally to trace it this time.)
8. **Mock** (`claude-mock-api.mjs`): the interactive client can append a user message after the `tool_result`, so the mock now looks at every message since the last assistant turn. The old last-message check looped tool_use forever. Headless behavior is unchanged.
9. **First-run state** is pre-seeded so the session opens at the prompt. These keys come from the 2.1.300 sources:
   - `~/.claude.json`: `hasCompletedOnboarding` and `lastOnboardingVersion: "2.1.300"` (no onboarding or login)
   - `theme: "dark"` (no theme picker)
   - `projects["/home/agentos/work"].hasTrustDialogAccepted` (no trust dialog)
   - `customApiKeyResponses.approved = [last 20 chars of the key]` (no "use this API key?" prompt; `jfe = key.trim().slice(-20)`)
   - `bypassPermissionsModeAccepted`, plus `~/.claude/settings.json` `skipDangerousModePermissionPrompt: true` (no bypass disclaimer)

### Regression check after the switch-over

The TUI changes were first built to `build/claude/cc-2.1.300-tui` and checked there. Then the main package was rebuilt with the same scripts. `tui.ts` uses the main package, and the pre-TUI package is kept at `build/claude/tui/cc-2.1.300-before-tui.aospkg`.

| check | result |
| --- | --- |
| `claude-bash-turn.ts` | PASS |
| `./claude-bash-matrix.sh` | unchanged: main PASS, noshim FAIL (EROFS), rewrite PASS, rewrite-self FAIL (watchdog) |
| `DEMO_MOCK=1 demo-claude.ts` | identical to the pre-TUI package: claude succeeds in 2 turns, and the mock's `node test.js` runs in the VM |

`DEMO_MOCK=1 demo-claude.ts` still prints `DEMO FAIL` with both packages, because the mock never edits `stats.js`. That run checks plumbing only.

### Known limitations

- The PTY transport leaks WASM child output (above). The pipe transport has no kernel tty, so anything inside the VM that needs a real tty (e.g. an interactive `vim` launched from claude) won't get one.
- No `rg` in the VM ("ripgrep not found on PATH"), so search tools that need it fail. There is no git unless you install the registry git package (`notes/git.md`). WebFetch/WebSearch, the MCP registry, the plugin marketplace and changelog fetches are blocked by the network policy; that is expected. `uds-messaging` can't listen (policy) and the failure is harmless.
- Bidi reordering is not implemented in `CellSegmenter`; only Windows Terminal and VS Code use it.
- The work dir lives in the VM and is lost on exit unless you set `TUI_EXPORT_DIR`.
- Verified in mock mode only (no real credentials were used here). Real-model and OAuth verification is still to do.
