// Interactive Claude Code inside an agentOS VM: the real `claude` TUI (2.1.300 rebuild) runs in the
// VM, and this script bridges it to your terminal (raw keystrokes in, screen bytes out, resizes,
// cleanup). Every tool call (Bash, Edit, ...) executes inside the VM. See notes/claude.md,
// "Interactive TUI".
//
//   CLAUDE_CODE_OAUTH_TOKEN_FILE=~/.claude/agentos-demo-token npx tsx tui.ts [hostDir] [-- claude args]
//   CLAUDE_CODE_OAUTH_TOKEN=... | ANTHROPIC_API_KEY=... npx tsx tui.ts [hostDir]
//   TUI_MOCK=1 npx tsx tui.ts                     (no credentials: in-VM mock Messages API)
//
// hostDir (optional) is copied into the VM's /home/agentos/work (node_modules and .git skipped);
// without it you get an empty demo project. The VM is discarded on exit; set TUI_EXPORT_DIR=<new
// host dir> to copy /home/agentos/work back out when the session ends.
//
// Keys: everything goes to claude (Ctrl-C included). Ctrl-] quits the host bridge immediately.
// Knobs: TUI_TRANSPORT=pipe|pty (default pipe; see the transport comment below),
// TUI_PERMISSION_MODE (default bypassPermissions: the VM is the sandbox; "default" asks per tool),
// TUI_MODEL, TUI_PKG (.aospkg), TUI_HEAP_MB (guest V8 heap, default 4096), TUI_MAX_MINUTES
// (session watchdog, default 240), TUI_LOG=<file> (copy of the raw TUI bytes), TUI_SIDECAR_LOG,
// TUI_INCLUDE_GIT=1 (also copy .git).
import { readFileSync, readdirSync, lstatSync, writeFileSync, mkdirSync, existsSync, appendFileSync } from "node:fs";
import { resolve, join, relative, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { AgentOs } from "@rivet-dev/agentos-core";
import { installTools } from "./vm-tools.ts";

const HOME = "/home/agentos";
const WORK = `${HOME}/work`;
const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = resolve(process.env.TUI_PKG ?? join(HERE, "build/claude/cc-2.1.300/package.aospkg"));
const mock = !!process.env.TUI_MOCK;
const QUIT_KEY = 0x1d; // Ctrl-]

// ---- args: [hostDir] [-- extra claude args]
const argv = process.argv.slice(2);
const dd = argv.indexOf("--");
const own = dd === -1 ? argv : argv.slice(0, dd);
const extra = dd === -1 ? [] : argv.slice(dd + 1);
const hostDir = own[0] ? resolve(own[0]) : undefined;
if (hostDir && !existsSync(hostDir)) { console.error(`tui: no such directory: ${hostDir}`); process.exit(2); }
if (!process.stdin.isTTY || !process.stdout.isTTY) { console.error("tui: needs an interactive terminal (stdin and stdout must be a TTY)"); process.exit(2); }

const T0 = Date.now();
// The agentOS sidecar's stderr (V8 worker-pool chatter, Rust WARN lines) and agentos-core's
// console.error diagnostics are re-written to this process's stderr, which would scribble over
// the TUI. Send all of it to a log file instead; our own messages use the real stderr.
const realStderr = process.stderr.write.bind(process.stderr);
const sidecarLog = process.env.TUI_SIDECAR_LOG ?? join(tmpdir(), `agentos-tui-${process.pid}.log`);
process.stderr.write = ((chunk: any, enc?: any, cb?: any) => {
	try { appendFileSync(sidecarLog, typeof chunk === "string" ? chunk : Buffer.from(chunk)); } catch {}
	const done = typeof enc === "function" ? enc : cb;
	if (typeof done === "function") done();
	return true;
}) as typeof process.stderr.write;
const say = (s: string) => realStderr(`\x1b[2m[tui +${((Date.now() - T0) / 1000).toFixed(1)}s]\x1b[0m ${s}\n`);

// ---- environment for claude inside the VM (same preset as demo-claude.ts, but a real terminal)
const agentEnv: Record<string, string> = JSON.parse(readFileSync(join(HERE, "vendor/claude-code/agentos-package.json"), "utf8")).agent.env;
const env: Record<string, string> = {
	...agentEnv, HOME, PATH: "/opt/agentos/bin:/usr/local/bin:/usr/bin:/bin",
	TERM: "xterm-256color", COLORTERM: process.env.COLORTERM ?? "truecolor", LANG: "C.UTF-8",
	// The package injects CLAUDE_CODE_SIMPLE=1 (= --bare) VM-wide; bare mode disables OAuth and most
	// of the interactive surface, so turn it off explicitly (deleting it is not enough).
	CLAUDE_CODE_SIMPLE: "0",
	DISABLE_AUTOUPDATER: "1", DISABLE_ERROR_REPORTING: "1", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
};
delete env.NO_COLOR; delete env.CI;
let apiKeyForApproval: string | undefined;
if (mock) {
	env.ANTHROPIC_API_KEY = apiKeyForApproval = "sk-ant-api03-dummy-not-a-real-key";
	env.ANTHROPIC_BASE_URL = "http://127.0.0.1:8788";
} else if (process.env.CLAUDE_CODE_OAUTH_TOKEN) {
	env.CLAUDE_CODE_OAUTH_TOKEN = process.env.CLAUDE_CODE_OAUTH_TOKEN;
} else if (process.env.CLAUDE_CODE_OAUTH_TOKEN_FILE) {
	env.CLAUDE_CODE_OAUTH_TOKEN = readFileSync(process.env.CLAUDE_CODE_OAUTH_TOKEN_FILE.replace(/^~(?=\/)/, process.env.HOME ?? "~"), "utf8").trim();
} else if (process.env.ANTHROPIC_API_KEY) {
	env.ANTHROPIC_API_KEY = apiKeyForApproval = process.env.ANTHROPIC_API_KEY;
} else {
	console.error("tui: set CLAUDE_CODE_OAUTH_TOKEN_FILE / CLAUDE_CODE_OAUTH_TOKEN (from `claude setup-token`) or ANTHROPIC_API_KEY, or TUI_MOCK=1");
	process.exit(2);
}

// ---- first-run state, pre-seeded so the session opens straight at the prompt (keys from the
// 2.1.300 sources; see notes/claude.md):
//   hasCompletedOnboarding + lastOnboardingVersion  -> no welcome/theme/login onboarding
//   theme                                           -> no theme picker
//   projects[WORK].hasTrustDialogAccepted           -> no "do you trust this folder" dialog
//   customApiKeyResponses.approved = [last 20 chars] -> no "use this API key?" prompt (env key)
//   bypassPermissionsModeAccepted + settings.skipDangerousModePermissionPrompt -> no bypass disclaimer
const permissionMode = process.env.TUI_PERMISSION_MODE ?? "bypassPermissions";
const claudeJson = {
	numStartups: 1, hasCompletedOnboarding: true, lastOnboardingVersion: "2.1.300", theme: "dark",
	autoUpdates: false, bypassPermissionsModeAccepted: permissionMode === "bypassPermissions",
	...(apiKeyForApproval ? { customApiKeyResponses: { approved: [apiKeyForApproval.trim().slice(-20)], rejected: [] } } : {}),
	projects: { [WORK]: { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true, allowedTools: [] } },
};
const settings = { ...(permissionMode === "bypassPermissions" ? { skipDangerousModePermissionPrompt: true } : {}) };

// ---- network: Anthropic only (API + OAuth refresh hosts), or loopback for the mock
const hosts = mock ? ["127.0.0.1"] : ["api.anthropic.com", "console.anthropic.com", "platform.claude.com", "claude.ai"];

say(`booting agentOS VM; sidecar/diagnostic output goes to ${sidecarLog}`);
say(`network: ${mock ? "loopback only (mock model)" : hosts.join(", ")}`);
const vm = await AgentOs.create({
	// cpu limits 0: mandatory (the guest shell busy-polls, notes/claude.md). Heap: the default guest
	// V8 heap cap (~125 MiB) is too small for the interactive TUI; the first turn died with
	// "exceeded the V8 heap limit (limits.jsRuntime.v8HeapLimitMb)".
	limits: { jsRuntime: { cpuTimeLimitMs: 0, v8HeapLimitMb: Number(process.env.TUI_HEAP_MB ?? 4096) }, wasm: { runnerCpuTimeLimitMs: 0 } },
	permissions: { network: { default: "deny", rules: [{ mode: "allow", operations: ["*"], patterns: hosts.flatMap((h) => [`dns://${h}`, `tcp://${h}:*`]) }] } },
});

const exportDir = process.env.TUI_EXPORT_DIR ? resolve(process.env.TUI_EXPORT_DIR) : undefined;
let disposed = false;
let mockPid: number | undefined;
const dispose = async () => {
	if (disposed) return;
	disposed = true;
	if (mockPid !== undefined) { await vm.process.kill(mockPid).catch(() => {}); await vm.process.wait(mockPid).catch(() => {}); }
	await vm.dispose().catch(() => {});
};

// ---- host terminal state + restoration (normal exit, Ctrl-], signals, crashes)
let rawOn = false;
let altScreen = false;
const restoreTerminal = () => {
	if (rawOn) { try { process.stdin.setRawMode(false); } catch {} rawOn = false; }
	// Undo whatever modes the TUI may have left on if it died mid-frame: mouse/focus/paste
	// reporting, kitty keyboard, hidden cursor, alternate screen.
	process.stdout.write("\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?1004l\x1b[?2004l\x1b[<u\x1b[0m\x1b[?25h" + (altScreen ? "\x1b[?1049l" : ""));
};
let finishing: Promise<void> | undefined;
const finish = (code: number, why?: string) => {
	finishing ??= (async () => {
		restoreTerminal();
		process.stdin.pause();
		if (why) say(why);
		if (exportDir) await exportWork().catch((e) => say(`export failed: ${(e as Error).message}`));
		if (mock) await reportMockProof().catch(() => {});
		await dispose();
		process.exit(code);
	})();
	return finishing;
};
process.on("SIGTERM", () => void finish(143, "SIGTERM: shutting down the VM"));
process.on("SIGHUP", () => void finish(129, "SIGHUP: shutting down the VM"));
process.on("SIGINT", () => void finish(130, "SIGINT: shutting down the VM")); // raw mode sends ^C to claude; this only fires on an external kill -INT
process.on("uncaughtException", (e) => { void finish(1, `crashed: ${e?.stack ?? e}`); });
process.on("unhandledRejection", (e) => { void finish(1, `crashed: ${(e as Error)?.stack ?? e}`); });

async function exportWork() {
	if (!exportDir) return;
	if (existsSync(exportDir) && readdirSync(exportDir).length) throw new Error(`${exportDir} exists and is not empty; not overwriting`);
	const entries = (await vm.filesystem.readdirRecursive(WORK, { exclude: ["node_modules"] })).filter((e) => e.type === "file");
	const files = await vm.filesystem.readFiles(entries.map((e) => e.path));
	for (const f of files as any[]) {
		if (!f.content) continue;
		const dst = join(exportDir, relative(WORK, f.path));
		mkdirSync(dirname(dst), { recursive: true });
		writeFileSync(dst, f.content);
	}
	say(`exported ${files.length} files from ${WORK} to ${exportDir}`);
}
async function reportMockProof() {
	const p = `${WORK}/mock-proof.txt`;
	if (await vm.filesystem.exists(p)) say(`mock check: VM file ${p} = ${JSON.stringify(new TextDecoder().decode(await vm.filesystem.readFile(p)))}`);
	else say(`mock check: ${p} not created (the mock's Bash call did not run)`);
}

try {
	const pkg = await vm.software.install({ type: "path", path: PKG });
	say(`installed Claude Code ${pkg.version} (${relative(process.cwd(), PKG)})`);
	say(`tools: ${(await installTools(vm)).join(", ") || "(none)"}`);

	// ---- work dir
	await vm.filesystem.mkdir(WORK, { recursive: true });
	if (hostDir) {
		const skip = new Set(["node_modules", ...(process.env.TUI_INCLUDE_GIT ? [] : [".git"])]);
		const batch: { path: string; content: Uint8Array }[] = [];
		const dirs = new Set<string>();
		let bytes = 0, skipped = 0;
		const walk = (d: string) => {
			for (const name of readdirSync(d)) {
				const p = join(d, name), st = lstatSync(p);
				if (st.isDirectory()) { if (skip.has(name)) { skipped++; continue; } dirs.add(`${WORK}/${relative(hostDir, p)}`); walk(p); }
				else if (st.isFile()) { const c = readFileSync(p); bytes += c.length; batch.push({ path: `${WORK}/${relative(hostDir, p)}`, content: c }); }
				else skipped++; // symlinks, sockets, ...
			}
		};
		walk(hostDir);
		for (const d of [...dirs].sort()) await vm.filesystem.mkdir(d, { recursive: true });
		for (let i = 0; i < batch.length; i += 200) await vm.filesystem.writeFiles(batch.slice(i, i + 200));
		say(`copied ${batch.length} files (${(bytes / 1024).toFixed(0)} KiB) from ${hostDir} into ${WORK}${skipped ? `, skipped ${skipped} (node_modules/.git/symlinks)` : ""}`);
	} else {
		await vm.filesystem.writeFile(`${WORK}/README.md`, "# Demo project\n\nAn empty project inside an agentOS VM. Everything Claude runs here (Bash, Edit, ...) executes in the VM.\n");
		say(`empty demo project at ${WORK}`);
	}

	// ---- first-run config
	await vm.filesystem.mkdir(`${HOME}/.claude`, { recursive: true });
	await vm.filesystem.writeFile(`${HOME}/.claude.json`, JSON.stringify(claudeJson, null, 2));
	await vm.filesystem.writeFile(`${HOME}/.claude/settings.json`, JSON.stringify(settings, null, 2));

	// ---- mock model (TUI_MOCK=1): fake Messages API in the VM; its Bash call writes a proof file
	if (mock) {
		await vm.filesystem.writeFile(`${HOME}/mock.mjs`, readFileSync(join(HERE, "claude-mock-api.mjs"), "utf8"));
		const mlog: string[] = [];
		mockPid = (await vm.process.spawn("node", [`${HOME}/mock.mjs`], {
			env: { ...env, MOCK_BASH: `echo hello-from-vm > ${WORK}/mock-proof.txt && uname -a` }, cwd: HOME,
			onStderr: (d) => { mlog.push(new TextDecoder().decode(d)); if (process.env.TUI_LOG) appendFileSync(process.env.TUI_LOG + ".mock", mlog.at(-1)!); },
		})).pid;
		for (let k = 0; k < 50 && !mlog.join("").includes("listening"); k++) await new Promise((r) => setTimeout(r, 100));
		say("mock Messages API listening in the VM on 127.0.0.1:8788");
	}

	// ---- the TUI. Two transports (TUI_TRANSPORT):
	//   pipe (default): claude runs on plain stdio pipes and the package entry shim presents them
	//     as a terminal (AGENTOS_PIPE_TTY: isTTY, raw mode, size from a file we rewrite on resize).
	//   pty: a real agentOS PTY via terminal.open (isTTY, raw mode, SIGWINCH from the kernel).
	//     agentOS 0.4.1 copies everything WASM processes in a PTY session write (Bash tool output,
	//     the shell snapshot's env dump with credentials, ...) onto that PTY at the next keystroke,
	//     which garbles the screen, so it is opt-in. (vm.process.spawn's `pty` option is ignored for
	//     plain commands in 0.4.1; javascript.spawnFile's PTY leaks the same way.)
	const transport = process.env.TUI_TRANSPORT ?? "pipe";
	const args = ["--permission-mode", permissionMode, ...(process.env.TUI_MODEL ? ["--model", process.env.TUI_MODEL] : []), ...extra];
	say(`starting claude ${args.join(" ")} in ${WORK} over a ${transport === "pty" ? "VM PTY" : "pipe-backed TTY"}   (Ctrl-] quits the bridge)`);
	const logFile = process.env.TUI_LOG;
	const onOutput = (data: Uint8Array) => {
		const s = Buffer.from(data);
		// track the alternate screen so a crash can leave it
		const t = s.toString("latin1");
		if (t.includes("\x1b[?1049h")) altScreen = true;
		if (t.includes("\x1b[?1049l")) altScreen = false;
		process.stdout.write(s);
		if (logFile) appendFileSync(logFile, s);
	};
	const size = () => ({ cols: process.stdout.columns || 80, rows: process.stdout.rows || 24 });
	const maxMin = Number(process.env.TUI_MAX_MINUTES ?? 240);
	let send: (d: Uint8Array) => Promise<void>, resize: () => void, waitExit: () => Promise<number>;
	if (transport === "pty") {
		const { shellId } = vm.terminal.open({ command: "claude", args, env, cwd: WORK, ...size() });
		vm.onShellData(shellId, ({ data }) => onOutput(data));
		send = (d) => vm.terminal.write(shellId, d);
		resize = () => { try { const { cols, rows } = size(); vm.terminal.resize(shellId, cols, rows); } catch {} };
		waitExit = () => vm.terminal.wait(shellId);
	} else {
		const sizeFile = `${HOME}/.agentos-tty-size`;
		const writeSize = () => { const { cols, rows } = size(); return vm.filesystem.writeFile(sizeFile, `${cols}x${rows}`); };
		await writeSize();
		const proc = await vm.process.spawn("claude", args, {
			env: { ...env, AGENTOS_PIPE_TTY: sizeFile }, cwd: WORK, timeoutMs: maxMin * 60_000,
			onStdout: onOutput, onStderr: onOutput,
		});
		send = (d) => vm.process.writeStdin(proc.pid, d);
		resize = () => void writeSize().catch(() => {});
		waitExit = async () => { const r: any = await vm.process.wait(proc.pid); return r?.exitCode ?? (r?.signal ? 128 : 1); };
	}

	process.stdin.setRawMode(true); rawOn = true;
	process.stdin.resume();
	process.stdin.on("data", (d: Buffer) => {
		const q = d.indexOf(QUIT_KEY);
		if (q !== -1) {
			if (q > 0) void send(d.subarray(0, q)).catch(() => {});
			void finish(130, "Ctrl-]: quit; shutting down the VM");
			return;
		}
		void send(d).catch(() => {});
	});
	process.stdout.on("resize", resize);

	const watchdog = setTimeout(() => void finish(124, `session watchdog: ${maxMin} min reached (TUI_MAX_MINUTES)`), maxMin * 60_000);
	watchdog.unref();
	const code = await waitExit().catch((e) => { say(`claude ended without a confirmed exit: ${(e as Error).message}`); return 1; });
	await finish(code, `claude exited (${code}); shutting down the VM`);
} catch (e) {
	await finish(1, `error: ${(e as Error)?.stack ?? e}`);
}
