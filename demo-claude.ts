// Live demo: Claude Code 2.1.300 (rebuilt, see notes/claude.md) running inside an agentOS 0.4.1 VM
// against the real Anthropic API. It gets a small project with a failing test and has to fix it.
//
//   CLAUDE_CODE_OAUTH_TOKEN_FILE=~/.claude/agentos-demo-token timeout 600 npx tsx demo-claude.ts   (token from `claude setup-token`)
//   ANTHROPIC_API_KEY=sk-ant-... timeout 600 npx tsx demo-claude.ts
//   DEMO_MOCK=1 timeout 300 npx tsx demo-claude.ts                       (plumbing check, in-VM mock model)
//
// Optional: DEMO_MODEL=<model id>, DEMO_PROMPT="...".
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { AgentOs } from "@rivet-dev/agentos-core";
import { installTools } from "./vm-tools.ts";

const T0 = Date.now();
const log = (s: string) => console.log(`\x1b[2m[host +${((Date.now() - T0) / 1000).toFixed(1)}s]\x1b[0m ${s}`);
const HOME = "/home/agentos";
const CWD = `${HOME}/demo`;
const mock = !!process.env.DEMO_MOCK;
const prompt = process.env.DEMO_PROMPT ?? "The tests in this project fail. Find the bug, fix it, then run `node test.js` to confirm they pass. Keep the fix minimal.";

const files: Record<string, string> = {
	"stats.js": `// Small stats helpers.
function mean(xs) {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function median(xs) {
  const s = [...xs].sort();
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

module.exports = { mean, median };
`,
	"test.js": `const assert = require("node:assert");
const { mean, median } = require("./stats");

assert.strictEqual(mean([1, 2, 3, 4]), 2.5);
assert.strictEqual(median([3, 1, 2]), 2);
assert.strictEqual(median([10, 9, 2, 1]), 5.5);
assert.strictEqual(median([100, 25, 3]), 25);
console.log("all tests passed");
`,
};

const agentEnv: Record<string, string> = JSON.parse(readFileSync("vendor/claude-code/agentos-package.json", "utf8")).agent.env;
const env: Record<string, string> = {
	...agentEnv, HOME, PATH: "/opt/agentos/bin:/usr/local/bin:/usr/bin:/bin", TERM: "dumb", NO_COLOR: "1", CI: "1",
	DISABLE_AUTOUPDATER: "1", DISABLE_ERROR_REPORTING: "1", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
};
if (mock) {
	Object.assign(env, { ANTHROPIC_API_KEY: "sk-ant-api03-dummy-not-a-real-key", ANTHROPIC_BASE_URL: "http://127.0.0.1:8788", MOCK_BASH: `cd ${CWD} && node test.js; echo test-exit=$?` });
} else if (process.env.CLAUDE_CODE_OAUTH_TOKEN) {
	env.CLAUDE_CODE_OAUTH_TOKEN = process.env.CLAUDE_CODE_OAUTH_TOKEN;
} else if (process.env.CLAUDE_CODE_OAUTH_TOKEN_FILE) {
	// A file holding just the token printed by `claude setup-token` (keeps it out of shell history/chat).
	env.CLAUDE_CODE_OAUTH_TOKEN = readFileSync(process.env.CLAUDE_CODE_OAUTH_TOKEN_FILE, "utf8").trim();
} else if (process.env.ANTHROPIC_API_KEY) {
	env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
} else if (!process.env.CLAUDE_CREDENTIALS_FILE) {
	console.error("Set CLAUDE_CODE_OAUTH_TOKEN (from `claude setup-token`), ANTHROPIC_API_KEY or CLAUDE_CREDENTIALS_FILE, or DEMO_MOCK=1.");
	process.exit(2);
}
// Rivet's preset sets CLAUDE_CODE_SIMPLE=1 (= --bare), and bare mode only accepts ANTHROPIC_API_KEY /
// apiKeyHelper: "OAuth and keychain are never read". Subscription (OAuth) auth needs it off.
if (env.CLAUDE_CODE_OAUTH_TOKEN || process.env.CLAUDE_CREDENTIALS_FILE) env.CLAUDE_CODE_SIMPLE = "0"; // explicit: the package also injects =1 as a VM-wide default
// CLAUDE_CREDENTIALS_FILE=~/.claude/.credentials.json: copy only the claudeAiOauth block into the VM's
// ~/.claude/.credentials.json (one-way; refreshed tokens stay in the VM). Note refresh tokens can rotate.
const credentials = !mock && process.env.CLAUDE_CREDENTIALS_FILE
	? JSON.stringify({ claudeAiOauth: JSON.parse(readFileSync(process.env.CLAUDE_CREDENTIALS_FILE, "utf8")).claudeAiOauth })
	: undefined;

// Network: the VM may reach only Anthropic (API + OAuth token refresh), or its own loopback for the mock.
const hosts = mock ? ["127.0.0.1"] : ["api.anthropic.com", ...(credentials ? ["console.anthropic.com", "platform.claude.com", "claude.ai"] : [])];
const vm = await AgentOs.create({
	limits: { jsRuntime: { cpuTimeLimitMs: 0 }, wasm: { runnerCpuTimeLimitMs: 0 } }, // see notes/claude.md: shell busy-poll budget
	permissions: { network: { default: "deny", rules: [{ mode: "allow", operations: ["*"], patterns: hosts.flatMap((h) => [`dns://${h}`, `tcp://${h}:*`]) }] } },
});
const dec = new TextDecoder();
let ok = false;
let mockPid: number | undefined;
try {
	log("VM up");
	const pkg = await vm.software.install({ type: "path", path: resolve("build/claude/cc-2.1.300/package.aospkg") });
	log(`installed Claude Code ${pkg.version} into the VM`);
	log(`tools: ${(await installTools(vm)).join(", ") || "(none)"}`);
	await vm.filesystem.mkdir(CWD, { recursive: true });
	if (credentials) {
		await vm.filesystem.mkdir(`${HOME}/.claude`, { recursive: true });
		await vm.filesystem.writeFile(`${HOME}/.claude/.credentials.json`, credentials);
		log("copied Claude subscription OAuth credentials into the VM");
	}
	for (const [name, body] of Object.entries(files)) await vm.filesystem.writeFile(`${CWD}/${name}`, body);
	const before = await vm.process.exec("node test.js 2>&1", { cwd: CWD, output: { capture: "all" } });
	log(`before: \`node test.js\` -> ${(before.stdout ?? "").trim().split("\n")[0]}`);

	if (mock) {
		await vm.filesystem.writeFile(`${HOME}/mock.mjs`, readFileSync("claude-mock-api.mjs", "utf8"));
		const m: string[] = [];
		mockPid = (await vm.process.spawn("node", [`${HOME}/mock.mjs`], { env, cwd: HOME, onStderr: (d) => m.push(dec.decode(d)) })).pid;
		for (let k = 0; k < 50 && !m.join("").includes("listening"); k++) await new Promise((r) => setTimeout(r, 100));
	}

	const model = process.env.DEMO_MODEL ? `--model ${process.env.DEMO_MODEL}` : "";
	const shq = (x: string) => `'${x.replace(/'/g, `'\\''`)}'`; // single-quote for sh (backticks in the prompt stay literal)
	const cmd = `claude -p ${shq(prompt)} --output-format stream-json --verbose --permission-mode bypassPermissions ${model} < /dev/null`;
	console.log(`\n\x1b[1m> ${prompt}\x1b[0m\n`);
	let buf = "";
	let result: any;
	const show = (line: string) => {
		let j: any;
		try { j = JSON.parse(line); } catch { return; }
		if (j.type === "system" && j.subtype === "init") log(`claude ${j.claude_code_version} · model ${j.model} · tools ${j.tools?.join(", ")}`);
		for (const c of j.message?.content ?? []) {
			if (c.type === "text" && c.text.trim()) console.log(`\x1b[36m${c.text.trim()}\x1b[0m`);
			if (c.type === "tool_use") console.log(`\x1b[33m⏺ ${c.name}\x1b[0m ${JSON.stringify(c.input).slice(0, 220)}`);
			if (c.type === "tool_result") {
				const text = typeof c.content === "string" ? c.content : (c.content ?? []).map((x: any) => x.text ?? "").join("");
				console.log(`  ${c.is_error ? "\x1b[31m✗" : "\x1b[2m⎿"} ${text.trim().split("\n").slice(0, 6).join("\n    ")}\x1b[0m`);
			}
		}
		if (j.type === "result") result = j;
	};
	const t = Date.now();
	const r = await vm.process.exec(cmd, {
		env, cwd: CWD, timeoutMs: 540_000, output: { capture: "all" },
		onStdout: (d) => {
			buf += dec.decode(d, { stream: true });
			let nl: number;
			while ((nl = buf.indexOf("\n")) !== -1) { show(buf.slice(0, nl)); buf = buf.slice(nl + 1); }
		},
	});
	if (buf.trim()) show(buf);
	console.log();
	log(`claude finished: ${result?.subtype ?? r.outcome} · ${result?.num_turns ?? "?"} turns · ${((Date.now() - t) / 1000).toFixed(1)}s${result?.total_cost_usd != null ? ` · $${result.total_cost_usd.toFixed(4)}` : ""}`);
	const errs = (r.stderr ?? "").split("\n").filter((l: string) => l.trim() && !l.includes("STALE"));
	if (!result || result.is_error) console.log("stderr:\n" + errs.slice(-12).join("\n"));

	// Independent check from the host: rerun the tests ourselves and show what changed.
	const after = await vm.process.exec("node test.js 2>&1; echo exit=$?", { cwd: CWD, output: { capture: "all" } });
	const stats = dec.decode(await vm.filesystem.readFile(`${CWD}/stats.js`));
	const changed = stats.split("\n").filter((l, i) => l !== files["stats.js"].split("\n")[i]);
	log(`after: \`node test.js\` -> ${(after.stdout ?? "").trim().replace(/\n/g, " | ")}`);
	log(`changed lines in stats.js:\n    ${changed.join("\n    ") || "(none)"}`);
	ok = (after.stdout ?? "").includes("all tests passed");
} finally {
	if (mockPid !== undefined) { await vm.process.kill(mockPid).catch(() => {}); await vm.process.wait(mockPid).catch(() => {}); }
	await vm.dispose().catch(() => {});
}
console.log(ok ? "\n\x1b[32mDEMO PASS\x1b[0m" : "\n\x1b[31mDEMO FAIL\x1b[0m");
process.exit(ok ? 0 : 1);
