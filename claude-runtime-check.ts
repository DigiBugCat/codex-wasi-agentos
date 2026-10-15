// Probe the agentOS 0.4.1 primitives `claude self-hosted-runner` depends on:
// child-process spawning of `claude` with piped stdio + signals, git over HTTPS,
// and SSE (long-lived streamed HTTP) — all from guest JavaScript.
// Usage: npx tsx claude-runtime-check.ts   (expects build/claude/cc-2.1.300 and build/claude/git built)
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { AgentOs } from "@rivet-dev/agentos-core";

const agentEnv: Record<string, string> = JSON.parse(readFileSync("vendor/claude-code/agentos-package.json", "utf8")).agent.env;
const HOME = "/home/agentos";
const env: Record<string, string> = { ...agentEnv, HOME, PATH: "/opt/agentos/bin:/usr/local/bin:/usr/bin:/bin", TERM: "dumb", NO_COLOR: "1", CI: "1", ANTHROPIC_API_KEY: "sk-ant-api03-dummy-not-a-real-key" };
const hosts = ["api.anthropic.com", "github.com", "127.0.0.1", "localhost"];
// CHECK_NET_ALLOW=1: allow all egress (to rule out policy as the cause of git clone failures)
const vm = await AgentOs.create({
	permissions: { network: process.env.CHECK_NET_ALLOW ? "allow" : { default: "deny", rules: [{ mode: "allow", operations: ["*"], patterns: hosts.flatMap((h) => [`dns://${h}`, `tcp://${h}:*`]) }] } } as any,
});

const run = async (label: string, cmd: string, timeoutMs = 120_000) => {
	const t = Date.now();
	try {
		const r = await vm.process.exec(cmd, { env, cwd: HOME, timeoutMs, output: { capture: "all" } });
		console.log(`\n### ${label}\n$ ${cmd.length > 200 ? cmd.slice(0, 200) + "..." : cmd}  [outcome ${r.outcome} exit ${r.exitCode} in ${Date.now() - t}ms]`);
		if (r.stdout) console.log(r.stdout.trimEnd().slice(0, 3000));
		if (r.stderr) console.log("stderr:", r.stderr.trimEnd().slice(0, 2000));
		if (r.error) console.log("error:", JSON.stringify(r.error).slice(0, 1000));
	} catch (e) {
		console.log(`\n### ${label}\n$ ${cmd}  THREW after ${Date.now() - t}ms:`, (e as Error).message);
	}
};

const spawnTest = `
import { spawn } from "node:child_process";
const t0 = Date.now();
function runChild(cmd, args, { killAfterMs } = {}) {
  return new Promise((res) => {
    const c = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"], env: process.env });
    let out = "", err = "", firstByteMs;
    c.stdout.on("data", (d) => { firstByteMs ??= Date.now() - t; out += d; });
    c.stderr.on("data", (d) => { err += d; });
    const t = Date.now();
    if (killAfterMs) setTimeout(() => c.kill("SIGTERM"), killAfterMs);
    c.on("close", (code, signal) => res({ cmd: [cmd, ...args].join(" "), pid: c.pid, code, signal, ms: Date.now() - t, firstByteMs, outLen: out.length, out: cmd === "claude" && args[0] === "-p" ? out : out.slice(0, 600), err: err.slice(0, 300) }));
    c.on("error", (e) => res({ cmd, error: e.message }));
    c.stdin.end();
  });
}
const r1 = await runChild("claude", ["--version"]);
console.log("child claude --version:", JSON.stringify(r1));
const r2 = await runChild("claude", ["-p", "hi", "--output-format", "stream-json", "--verbose"]);
const lines = r2.out.split("\\n").filter(Boolean);
console.log("child stream-json: code", r2.code, "signal", r2.signal, "outLen", r2.outLen, "lines", lines.length, "types", lines.map((l) => { try { return JSON.parse(l).type } catch { return "partial" } }).join(","));
const r3 = await runChild("sleep", ["30"], { killAfterMs: 500 });
console.log("kill sleep after 500ms:", JSON.stringify({ code: r3.code, signal: r3.signal, ms: r3.ms }));
const r4 = await runChild("node", ["-e", "process.on('SIGTERM',()=>{console.log('got SIGTERM, cleaning up');process.exit(0)});setInterval(()=>{},1000)"], { killAfterMs: 500 });
console.log("node child SIGTERM handler:", JSON.stringify({ code: r4.code, signal: r4.signal, out: r4.out.trim(), ms: r4.ms }));
const r5 = await runChild("sh", ["-c", "for i in 1 2 3; do echo tick $i; sleep 0.3; done"]);
console.log("sh streaming child: firstByteMs", r5.firstByteMs, "totalMs", r5.ms, JSON.stringify(r5.out));
`;

const sseTest = `
import http from "node:http";
const srv = http.createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  let i = 0;
  const iv = setInterval(() => { res.write("event: tick\\ndata: " + JSON.stringify({ i, t: Date.now() }) + "\\n\\n"); if (++i === 5) { clearInterval(iv); res.end(); } }, 300);
});
await new Promise((r) => srv.listen(8787, "127.0.0.1", r));
const t0 = Date.now();
const resp = await fetch("http://127.0.0.1:8787/events", { headers: { accept: "text/event-stream" } });
const reader = resp.body.getReader(); const dec = new TextDecoder(); const arrivals = [];
for (;;) { const { done, value } = await reader.read(); if (done) break; for (const ev of dec.decode(value).split("\\n\\n").filter(Boolean)) arrivals.push(Date.now() - t0); }
console.log("SSE fetch status", resp.status, "event arrival ms:", arrivals.join(","));
srv.close();
`;

try {
	for (const p of ["build/claude/cc-2.1.300/package.aospkg", "build/claude/git/dist/package.aospkg"]) {
		const i = await vm.software.install({ type: "path", path: resolve(p) });
		console.log(`installed ${i.packageName}@${i.version}:`, i.commands);
	}
	await vm.filesystem.mkdir(HOME, { recursive: true });
	await vm.filesystem.writeFile(`${HOME}/spawn-test.mjs`, spawnTest);
	await vm.filesystem.writeFile(`${HOME}/sse-test.mjs`, sseTest);
	if (process.env.CHECK_ONLY_GIT) { await run("git clone https", "git clone https://github.com/octocat/Hello-World.git /tmp/hw 2>&1; ls -la /tmp/hw"); await run("child processes", "node spawn-test.mjs"); throw new Error("done (CHECK_ONLY_GIT)"); }
	await run("which", "which git claude node sh bwrap socat sandbox-exec 2>&1; uname -a");
	await run("git version", "git --version; git help 2>&1 | head -5");
	await run("git clone https", "git clone https://github.com/octocat/Hello-World.git /tmp/hw 2>&1; ls -la /tmp/hw; cd /tmp/hw && git log --oneline -3 2>&1; git status 2>&1 | head -3; git rev-parse HEAD 2>&1");
	await run("git local ops", "mkdir -p /tmp/r && cd /tmp/r && git init 2>&1 && echo hi > a && git add a 2>&1 && git commit -m x 2>&1; git worktree list 2>&1; git fetch 2>&1 | head -2");
	await run("child processes", "node spawn-test.mjs");
	await run("SSE", "node sse-test.mjs", 60_000);
} catch (e) {
	console.error("FAILED:", e);
} finally {
	await vm.dispose();
}
