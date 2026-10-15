// Drive one full Claude Code agent turn inside agentOS against an in-VM mock Messages API
// (claude-mock-api.mjs): model asks for Bash -> Claude Code runs it in the VM -> result goes back.
// No credentials, no traffic leaves the VM (network policy allows only 127.0.0.1).
// Usage: npx tsx claude-agent-loop.ts <pkg.aospkg> [extra claude args...]
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { AgentOs } from "@rivet-dev/agentos-core";

const pkg = resolve(process.argv[2] ?? "build/claude/dist/package.aospkg");
const extra = process.argv.slice(3);
const agentEnv: Record<string, string> = JSON.parse(readFileSync("vendor/claude-code/agentos-package.json", "utf8")).agent.env;
const HOME = "/home/agentos";
const env: Record<string, string> = {
	...agentEnv, HOME, PATH: "/opt/agentos/bin:/usr/local/bin:/usr/bin:/bin", TERM: "dumb", NO_COLOR: "1", CI: "1",
	ANTHROPIC_API_KEY: "sk-ant-api03-dummy-not-a-real-key", ANTHROPIC_BASE_URL: "http://127.0.0.1:8788",
	DISABLE_AUTOUPDATER: "1", ...(process.env.LOOP_TMPDIR ? { CLAUDE_CODE_TMPDIR: process.env.LOOP_TMPDIR, TMPDIR: process.env.LOOP_TMPDIR } : {}), DISABLE_ERROR_REPORTING: "1", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
};
const vm = await AgentOs.create({
	...(process.env.LOOP_CPU_MS ? { limits: { jsRuntime: { cpuTimeLimitMs: Number(process.env.LOOP_CPU_MS) } } } : {}),
	permissions: { network: { default: "deny", rules: [{ mode: "allow", operations: ["*"], patterns: ["dns://127.0.0.1", "tcp://127.0.0.1:*", "dns://localhost", "tcp://localhost:*"] }] } },
});
try {
	const i = await vm.software.install({ type: "path", path: pkg });
	console.log(`installed ${i.packageName}@${i.version}`);
	await vm.filesystem.mkdir(`${HOME}/work`, { recursive: true });
	if (process.env.LOOP_TMPDIR) await vm.filesystem.mkdir(process.env.LOOP_TMPDIR, { recursive: true });
	await vm.filesystem.writeFile(`${HOME}/mock.mjs`, readFileSync("claude-mock-api.mjs", "utf8"));
	await vm.filesystem.writeFile(`${HOME}/work/README.md`, "agentOS probe workspace\n");
	const mockLog: string[] = [];
	const mock = await vm.process.spawn("node", [`${HOME}/mock.mjs`], { env, cwd: HOME, onStderr: (d) => mockLog.push(Buffer.from(d).toString()) });
	await new Promise((r) => setTimeout(r, 1500));
	const t = Date.now();
	// LOOP_STDIN_SECS=N: feed the prompt as stream-json on stdin and hold stdin open N seconds
	// (Rivet's patched 2.1.87 is driven this way by its ACP adapter; with stdin at EOF it stops early).
	const dbg = process.env.LOOP_DEBUG ? "--debug-file /tmp/claude-debug.log" : "";
	const cmd = process.env.LOOP_STDIN_SECS
		? `(echo '{"type":"user","message":{"role":"user","content":"run the probe"}}'; sleep ${process.env.LOOP_STDIN_SECS}) | claude -p --input-format stream-json --output-format stream-json --verbose --allowedTools Bash ${dbg} ${extra.join(" ")}; echo "exit=$?"`
		: `claude -p "run the probe" --output-format stream-json --verbose --allowedTools Bash ${dbg} ${extra.join(" ")} < /dev/null; echo "exit=$?"`;
	const r = await vm.process.exec(cmd, { env, cwd: `${HOME}/work`, timeoutMs: 240_000, output: { capture: "all" } });
	console.log(`$ ${cmd}  [outcome ${r.outcome} exit ${r.exitCode} in ${Date.now() - t}ms]`);
	for (const line of (r.stdout ?? "").split("\n")) {
		if (!line.trim()) continue;
		try {
			const j = JSON.parse(line);
			const c = j.message?.content?.map((x: any) => (x.type === "text" ? `text:${JSON.stringify(x.text)}` : x.type === "tool_use" ? `tool_use:${x.name}(${JSON.stringify(x.input)})` : x.type === "tool_result" ? `tool_result:${JSON.stringify(typeof x.content === "string" ? x.content : x.content?.map((y: any) => y.text).join(""))}` : x.type)).join(" | ");
			console.log(`  [${j.type}${j.subtype ? "/" + j.subtype : ""}] ${c ?? (j.result !== undefined ? `result=${JSON.stringify(j.result)} is_error=${j.is_error}` : j.tools ? `tools=${j.tools.length} version=${j.claude_code_version}` : "")}`.slice(0, 900));
		} catch {
			console.log("  " + line.slice(0, 300));
		}
	}
	if (r.stderr) console.log("stderr:", r.stderr.split("\n").filter((l) => !l.startsWith("[agentos-claude]")).join("\n").slice(0, 1500));
	console.log("mock log:\n" + mockLog.join("").trim());
	if (process.env.LOOP_DEBUG) {
		const d = await vm.process.exec("ls -la /bin/bash /bin/sh 2>&1; tail -25 /tmp/claude-debug.log", { output: { capture: "all" } });
		console.log("debug log tail:\n" + (d.stdout ?? ""));
	}
	await vm.process.kill(mock.pid).catch(() => {});
	await vm.process.wait(mock.pid).catch(() => {});
} catch (e) {
	console.error("FAILED:", e);
} finally {
	await vm.dispose();
}
