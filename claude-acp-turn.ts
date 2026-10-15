// One full agent turn through Rivet's July ACP adapter (`claude-sdk-acp`, Claude Code 2.1.87)
// inside agentOS 0.4.1, speaking ACP JSON-RPC over the process's stdio ourselves (the core
// session API that used to do this was removed upstream in a6c668c). The model is the in-VM
// mock (claude-mock-api.mjs), so no credentials are used and nothing leaves the VM.
// Usage: npx tsx claude-acp-turn.ts [pkg.aospkg]
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { AgentOs } from "@rivet-dev/agentos-core";

const pkg = resolve(process.argv[2] ?? "build/claude/dist/package.aospkg");
const agentEnv: Record<string, string> = JSON.parse(readFileSync("vendor/claude-code/agentos-package.json", "utf8")).agent.env;
const HOME = "/home/agentos";
const env: Record<string, string> = {
	...agentEnv, HOME, PATH: "/opt/agentos/bin:/usr/local/bin:/usr/bin:/bin", TERM: "dumb", NO_COLOR: "1",
	ANTHROPIC_API_KEY: "sk-ant-api03-dummy-not-a-real-key", ANTHROPIC_BASE_URL: "http://127.0.0.1:8788",
	DISABLE_AUTOUPDATER: "1", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
};
const vm = await AgentOs.create({
	permissions: { network: { default: "deny", rules: [{ mode: "allow", operations: ["*"], patterns: ["dns://127.0.0.1", "tcp://127.0.0.1:*", "dns://localhost", "tcp://localhost:*"] }] } },
});
const dec = new TextDecoder();
try {
	const i = await vm.software.install({ type: "path", path: pkg });
	console.log(`installed ${i.packageName}@${i.version}`);
	await vm.filesystem.mkdir(`${HOME}/work`, { recursive: true });
	await vm.filesystem.writeFile(`${HOME}/mock.mjs`, readFileSync("claude-mock-api.mjs", "utf8"));
	const mockLog: string[] = [];
	const mock = await vm.process.spawn("node", [`${HOME}/mock.mjs`], { env, cwd: HOME, onStderr: (d) => mockLog.push(dec.decode(d)) });
	await new Promise((r) => setTimeout(r, 1500));

	let buf = "";
	const pending = new Map<number, (v: any) => void>();
	let acp: { pid: number };
	const send = (msg: object) => vm.process.writeStdin(acp.pid, JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\n");
	let nextId = 1;
	const call = (method: string, params: object) => new Promise<any>((res) => { const id = nextId++; pending.set(id, res); send({ id, method, params }); });
	const onLine = (line: string) => {
		let m: any;
		try { m = JSON.parse(line); } catch { console.log("  (non-json)", line.slice(0, 200)); return; }
		if (m.id !== undefined && (m.result !== undefined || m.error !== undefined) && pending.has(m.id)) { pending.get(m.id)!(m); pending.delete(m.id); return; }
		if (m.method === "session/request_permission") {
			const opt = m.params.options?.find((o: any) => o.kind?.startsWith("allow")) ?? m.params.options?.[0];
			console.log(`  <- request_permission ${m.params.toolCall?.title ?? ""} -> ${opt?.optionId}`);
			send({ id: m.id, result: { outcome: { outcome: "selected", optionId: opt?.optionId } } });
			return;
		}
		if (m.method === "session/update") {
			const u = m.params.update;
			if (u.sessionUpdate === "agent_message_chunk") process.stdout.write(`  [text] ${u.content?.text ?? ""}\n`);
			else if (u.sessionUpdate === "tool_call" || u.sessionUpdate === "tool_call_update")
				console.log(`  [${u.sessionUpdate}] ${u.title ?? ""} status=${u.status ?? ""} ${JSON.stringify(u.rawInput ?? u.content ?? "").slice(0, 300)}`);
			else console.log(`  [${u.sessionUpdate}]`);
			return;
		}
		if (m.method) { console.log(`  <- ${m.method} (unhandled, replying null)`); if (m.id !== undefined) send({ id: m.id, result: null }); }
	};
	const stderr: string[] = [];
	acp = await vm.process.spawn("claude-sdk-acp", [], {
		env, cwd: `${HOME}/work`,
		onStdout: (d) => { buf += dec.decode(d); let k; while ((k = buf.indexOf("\n")) >= 0) { const l = buf.slice(0, k); buf = buf.slice(k + 1); if (l.trim()) onLine(l); } },
		onStderr: (d) => stderr.push(dec.decode(d)),
	});
	const t0 = Date.now();
	const withTimeout = <T>(p: Promise<T>, ms: number, what: string) => Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`timeout: ${what}`)), ms))]);
	const init = await withTimeout(call("initialize", { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } }), 60_000, "initialize");
	console.log("initialize ->", JSON.stringify(init.result ?? init.error).slice(0, 300));
	const ns = await withTimeout(call("session/new", { cwd: `${HOME}/work`, mcpServers: [] }), 60_000, "session/new");
	console.log("session/new ->", JSON.stringify(ns.result ?? ns.error).slice(0, 300));
	const sessionId = ns.result?.sessionId;
	const pr = await withTimeout(call("session/prompt", { sessionId, prompt: [{ type: "text", text: "run the probe" }] }), 150_000, "session/prompt");
	console.log(`session/prompt -> ${JSON.stringify(pr.result ?? pr.error)} after ${Date.now() - t0}ms`);
	console.log("adapter stderr (filtered):\n" + stderr.join("").split("\n").filter((l) => l.trim() && !l.includes("[agentos-claude]")).slice(-15).join("\n"));
	console.log("mock log:\n" + mockLog.join("").trim());
	await vm.process.kill(acp.pid).catch(() => {});
	await vm.process.kill(mock.pid).catch(() => {});
} catch (e) {
	console.error("FAILED:", (e as Error).message);
} finally {
	await vm.dispose().catch(() => {});
}
