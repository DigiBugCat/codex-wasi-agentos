// One Claude Code 2.1.300 turn inside agentOS 0.4.1 that must use the Bash tool:
// in-VM mock Messages API (claude-mock-api.mjs) asks for Bash -> Claude Code runs it in the VM
// -> tool_result goes back -> mock answers -> turn ends; then the host reads out.txt from the VM.
// No credentials (dummy key), network policy allows only the VM's own loopback.
//
//   timeout 300 npx tsx claude-bash-turn.ts [pkg.aospkg]
//
// Knobs: TURN_DEBUG=1 (claude --debug-file, prints tail), TURN_CPU_MS=<n> (limits.jsRuntime.cpuTimeLimitMs),
//        TURN_TRACE=1 (guest fs/child_process call counters from bun-shim, if built with tracing)
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { AgentOs } from "@rivet-dev/agentos-core";

const T0 = Date.now();
const log = (s: string) => console.log(`[host +${Date.now() - T0}ms] ${s}`);
const pkg = resolve(process.argv[2] ?? "build/claude/cc-2.1.300/package.aospkg");
const HOME = "/home/agentos";
const CWD = `${HOME}/work`;
const OUT = `${CWD}/out.txt`;
const agentEnv: Record<string, string> = JSON.parse(readFileSync("vendor/claude-code/agentos-package.json", "utf8")).agent.env;
const env: Record<string, string> = {
	...agentEnv, HOME, PATH: "/opt/agentos/bin:/usr/local/bin:/usr/bin:/bin", TERM: "dumb", NO_COLOR: "1", CI: "1",
	ANTHROPIC_API_KEY: "sk-ant-api03-dummy-not-a-real-key", ANTHROPIC_BASE_URL: "http://127.0.0.1:8788",
	DISABLE_AUTOUPDATER: "1", DISABLE_ERROR_REPORTING: "1", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
	MOCK_BASH: `echo hello-from-bash > ${OUT} && uname -a`,
	...(process.env.TURN_PROCFD_LOG ? { AGENTOS_PROCFD_LOG: "/tmp/claude-procfd.log" } : {}),
};

let t = Date.now();
const vm = await AgentOs.create({
	// TURN_CPU_MS -> limits.jsRuntime.cpuTimeLimitMs (guest node processes)
	// TURN_WASM_CPU_MS -> limits.wasm.runnerCpuTimeLimitMs (WASM commands: sh, coreutils, ...); 0 disables
	limits: {
		...(process.env.TURN_CPU_MS ? { jsRuntime: { cpuTimeLimitMs: Number(process.env.TURN_CPU_MS) } } : {}),
		...(process.env.TURN_WASM_CPU_MS ? { wasm: { runnerCpuTimeLimitMs: Number(process.env.TURN_WASM_CPU_MS) } } : {}),
	},
	permissions: { network: { default: "deny", rules: [{ mode: "allow", operations: ["*"], patterns: ["dns://127.0.0.1", "tcp://127.0.0.1:*"] }] } },
});
log(`VM created in ${Date.now() - t}ms`);
const dec = new TextDecoder();
let pass = false;
try {
	t = Date.now();
	const i = await vm.software.install({ type: "path", path: pkg });
	log(`installed ${i.packageName}@${i.version} in ${Date.now() - t}ms`);
	await vm.filesystem.mkdir(CWD, { recursive: true });
	await vm.filesystem.writeFile(`${HOME}/mock.mjs`, readFileSync("claude-mock-api.mjs", "utf8"));
	const mockLog: string[] = [];
	const mock = await vm.process.spawn("node", [`${HOME}/mock.mjs`], { env, cwd: HOME, onStderr: (d) => mockLog.push(dec.decode(d)) });
	for (let k = 0; k < 50 && !mockLog.join("").includes("listening"); k++) await new Promise((r) => setTimeout(r, 100));
	log("mock listening in VM on 127.0.0.1:8788");

	const dbg = process.env.TURN_DEBUG ? "--debug-file /tmp/claude-debug.log" : "";
	const claudeBin = process.env.TURN_TRACE === "entry" ? "CLAUDE_TRACE_STACK=1 claude" : process.env.TURN_TRACE ? "CLAUDE_TRACE_STACK=1 node /opt/agentos/pkgs/claude2/2.1.300/lib/trace-entry.mjs" : "claude";
	const cmd = `${claudeBin} -p "write the probe file" --output-format stream-json --verbose --permission-mode bypassPermissions --allowedTools Bash ${dbg} < /dev/null; echo "exit=$?"`;
	t = Date.now();
	// TURN_PS=1: log the VM process table every 10 s while the turn runs
	const ps = process.env.TURN_PS ? setInterval(async () => {
		try {
			const r = await vm.process.exec("for p in /proc/[0-9]*; do printf '%s:%s ' ${p#/proc/} \"$(tr '\\0' ' ' < $p/cmdline 2>/dev/null | cut -c1-70)\"; done", { timeoutMs: 8000, output: { capture: "all" } });
			log("ps: " + (r.stdout ?? "").trim() + (r.stderr ? ` [${r.stderr.trim().slice(0, 100)}]` : ""));
		} catch (e) { log(`ps failed: ${(e as Error).message}`); }
	}, 10_000) : undefined;
	// Fail-fast watchdog: once the mock has served the tool_use (first POST), the tool_result (second
	// POST) must arrive within TURN_WATCHDOG_MS (default 15 s) or the turn is aborted and diagnosed.
	const wdMs = Number(process.env.TURN_WATCHDOG_MS ?? 15_000);
	const ac = new AbortController();
	let watchdogFired = "";
	const outBuf: string[] = [], errBuf: string[] = [];
	const posts = () => (mockLog.join("").match(/POST \/v1\/messages/g) ?? []).length;
	const wd = setInterval(async () => {
		if (watchdogFired || posts() !== 1) return;
		const since = (wd as any).firstPostAt ??= Date.now();
		if (Date.now() - since < wdMs) return;
		watchdogFired = `no tool_result reached the mock within ${wdMs}ms of serving tool_use`;
		log(`WATCHDOG: ${watchdogFired}; collecting diagnostics`);
		try {
			const d = await vm.process.exec("ls -la /home/agentos/work; for p in /proc/[0-9]*; do printf '%s:%s\\n' ${p#/proc/} \"$(tr '\\0' ' ' < $p/cmdline 2>/dev/null | cut -c1-80)\"; done; tail -5 /tmp/claude-debug.log 2>/dev/null; tail -15 /tmp/claude-trace.log 2>/dev/null", { timeoutMs: 8000, output: { capture: "all" } });
			console.log("watchdog diagnostics:\n" + (d.stdout ?? "") + (d.stderr ?? ""));
		} catch (e) { console.log("diagnostics failed:", (e as Error).message); }
		console.log("last claude stderr lines:\n" + errBuf.join("").split("\n").filter((l) => l.trim() && !l.includes("STALE")).slice(-8).join("\n"));
		ac.abort();
	}, 500);
	let r: any;
	try {
		r = await vm.process.exec(cmd, { env, cwd: CWD, timeoutMs: 240_000, signal: ac.signal, onStdout: (d) => outBuf.push(dec.decode(d)), onStderr: (d) => errBuf.push(dec.decode(d)), output: { capture: "all" } });
	} catch (e) {
		r = { outcome: watchdogFired ? "watchdog_abort" : "threw", stdout: outBuf.join(""), stderr: errBuf.join("") + `\n${(e as Error).message}` };
	}
	clearInterval(wd);
	if (ps) clearInterval(ps);
	const turnMs = Date.now() - t;
	log(`claude -p finished: outcome=${r.outcome} in ${turnMs}ms`);
	let result: any;
	let toolResult = "";
	for (const line of (r.stdout ?? "").split("\n")) {
		if (!line.trim()) continue;
		let j: any;
		try { j = JSON.parse(line); } catch { console.log("  " + line.slice(0, 300)); continue; }
		for (const c of j.message?.content ?? []) {
			if (c.type === "tool_use") console.log(`  [assistant] tool_use ${c.name} ${JSON.stringify(c.input)}`);
			if (c.type === "text") console.log(`  [assistant] text ${JSON.stringify(c.text).slice(0, 300)}`);
			if (c.type === "tool_result") { toolResult = typeof c.content === "string" ? c.content : (c.content ?? []).map((x: any) => x.text).join(""); console.log(`  [user] tool_result is_error=${c.is_error ?? false} ${JSON.stringify(toolResult).slice(0, 300)}`); }
		}
		if (j.type === "system" && j.subtype === "init") console.log(`  [system/init] claude_code_version=${j.claude_code_version} tools=${j.tools?.join(",")}`);
		if (j.type === "result") { result = j; console.log(`  [result/${j.subtype}] is_error=${j.is_error} num_turns=${j.num_turns} duration_ms=${j.duration_ms} stop_reason=${j.stop_reason}`); }
	}
	const errLines = (r.stderr ?? "").split("\n").filter((l) => l.trim() && !l.includes("INFO_AGENTOS_STALE"));
	if (errLines.length) console.log("stderr:\n" + errLines.slice(-15).join("\n"));
	if (process.env.TURN_DEBUG) {
		const d = await vm.process.exec("tail -40 /tmp/claude-debug.log", { output: { capture: "all" } });
		console.log("debug log tail:\n" + (d.stdout ?? ""));
	}
	if (process.env.TURN_TRACE) {
		const d = await vm.process.exec("cat /tmp/claude-trace.log", { output: { capture: "all" } });
		console.log("trace:\n" + (d.stdout ?? "").split("\n").slice(-140).join("\n"));
	}
	if (process.env.TURN_PROCFD_LOG) {
		const d = await vm.process.exec("cat /tmp/claude-procfd.log", { output: { capture: "all" } });
		console.log("procfs translations (agentos-entry.mjs):\n" + (d.stdout ?? "(none)"));
	}
	console.log("mock log:\n" + mockLog.join("").trim());
	let out = "";
	try { out = dec.decode(await vm.filesystem.readFile(OUT)); } catch (e) { out = `<unreadable: ${(e as Error).message}>`; }
	log(`host read ${OUT}: ${JSON.stringify(out)}`);
	pass = !watchdogFired && out.trim() === "hello-from-bash" && result?.subtype === "success" && result?.is_error === false && toolResult.includes("Linux") && (r.stdout ?? "").includes("exit=0");
	await vm.process.kill(mock.pid).catch(() => {});
	await vm.process.wait(mock.pid).catch(() => {});
} catch (e) {
	console.error("FAILED:", e);
} finally {
	await vm.dispose().catch(() => {});
}
log(`total ${Date.now() - T0}ms`);
console.log(pass ? "PASS" : "FAIL");
process.exit(pass ? 0 : 1);
