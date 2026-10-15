// Probe: run Rivet's July Claude Code package (repacked to v2) inside agentOS 0.4.1.
// Usage: npx tsx claude-probe.ts [pkg.aospkg] [-- extra commands...]
//   CLAUDE_PROBE_NET=1  allow DNS/TCP to api.anthropic.com (no key is set; expect auth error)
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { AgentOs } from "@rivet-dev/agentos-core";

const argv = process.argv.slice(2);
const dd = argv.indexOf("--");
const pkgPath = resolve(argv[0] && argv[0] !== "--" ? argv[0] : "build/claude/dist/package.aospkg");
const extra = dd >= 0 ? argv.slice(dd + 1) : [];

const agentEnv: Record<string, string> = JSON.parse(readFileSync("vendor/claude-code/agentos-package.json", "utf8")).agent.env;
const HOME = "/home/agentos";
const env: Record<string, string> = { ...agentEnv, HOME, PATH: "/opt/agentos/bin:/usr/local/bin:/usr/bin:/bin", TERM: "dumb", NO_COLOR: "1", CI: "1" };
// CLAUDE_PROBE_DUMMY_KEY=1 sets an obviously-fake key so the CLI gets as far as an HTTP 401.
if (process.env.CLAUDE_PROBE_DUMMY_KEY) env.ANTHROPIC_API_KEY = "sk-ant-api03-dummy-not-a-real-key";

const hosts = ["api.anthropic.com", "statsig.anthropic.com", "console.anthropic.com"];
const vm = await AgentOs.create(
	process.env.CLAUDE_PROBE_NET
		? {
				permissions: {
					network: {
						default: "deny",
						rules: [{ mode: "allow", operations: ["*"], patterns: hosts.flatMap((h) => [`dns://${h}`, `tcp://${h}:*`]) }],
					},
				},
			}
		: undefined,
);

const run = async (cmd: string, timeoutMs = 90_000) => {
	const t = Date.now();
	try {
		const r = await vm.process.exec(cmd, { env, cwd: HOME, timeoutMs, output: { capture: "all" } });
		console.log(`\n$ ${cmd}  [outcome ${r.outcome} exit ${r.exitCode} in ${Date.now() - t}ms]`);
		if (r.stdout) console.log(r.stdout.trimEnd().slice(0, 4000));
		if (r.stderr) console.log("stderr:", r.stderr.trimEnd().slice(0, 4000));
		if (r.error) console.log("error:", JSON.stringify(r.error).slice(0, 2000));
	} catch (e) {
		console.log(`\n$ ${cmd}  THREW after ${Date.now() - t}ms:`, (e as Error).message);
	}
};

try {
	const t = Date.now();
	const installed = await vm.software.install({ type: "path", path: pkgPath });
	console.log(`installed ${installed.packageName}@${installed.version} in ${Date.now() - t}ms; commands:`, installed.commands);
	await vm.filesystem.mkdir(HOME, { recursive: true });
	const cmds = extra.length
		? extra
		: ["ls -la /opt/agentos/bin | head", "node --version", "claude --version", "claude --help | head -40", 'claude -p "hi" < /dev/null'];
	for (const c of cmds) await run(c);
} catch (e) {
	console.error("FAILED:", e);
} finally {
	await vm.dispose();
}
