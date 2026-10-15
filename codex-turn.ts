// Run one Codex turn inside an agentOS 0.4.1 VM, driving Rivet's WASI Codex
// build directly over its `--session-turn` NDJSON protocol (the ACP adapter
// that used to wrap it was removed upstream in a6c668c).
//
//   npx tsx codex-turn.ts "what files are here?"
//
// Auth (pick one):
//   OPENAI_API_KEY=sk-... npx tsx codex-turn.ts ...
//   CODEX_AUTH_FILE=~/.codex/auth.json npx tsx codex-turn.ts ...   (copies it into the VM)
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { AgentOs } from "@rivet-dev/agentos-core";
import { installTools } from "./vm-tools.ts";

const prompt = process.argv[2] ?? "List the files in the current directory and summarize what notes.md says.";
const model = process.env.CODEX_MODEL ?? "gpt-5.6-sol";
const HOME = "/home/agentos";
const CWD = `${HOME}/work`;

// CODEX_PKG=<path> selects another package (e.g. build/codex-latest/dist/package.aospkg).
// Requires build/codex/dist/package.aospkg rebuilt by scripts/patch-codex-wasm.mjs,
// otherwise every connect fails with errno 23 (EHOSTUNREACH) whatever the policy.
// Hostname patterns do match: this wasm passes "host:port" to host_net
// net_connect and the sidecar resolves it, so the rule sees the hostname.
// api.openai.com = API-key mode; chatgpt.com/backend-api/codex = ChatGPT mode;
// auth.openai.com/oauth/token = ChatGPT token refresh.
// CODEX_NET=allow (allow-all) and CODEX_NET=deny (deny-all) are for diagnostics.
const allowHosts = process.env.CODEX_ALLOW_HOSTS?.split(",") ?? ["api.openai.com", "chatgpt.com", "auth.openai.com"];
let t = Date.now();
// Newer Codex builds (CODEX_PKG) stream bigger responses; the default TLS plaintext buffer
// (1 MiB, limits.tls.maxBufferedBytes) was 81% full on a short real turn. Raise it to 16 MiB;
// the sidecar requires it to be <= limits.resources.maxSocketBufferedBytes (default 4 MiB).
const tlsBuf = Number(process.env.CODEX_TLS_BUF_BYTES ?? 16 * 1024 * 1024);
const tlsLimits = process.env.CODEX_PKG ? { limits: { tls: { maxBufferedBytes: tlsBuf }, resources: { maxSocketBufferedBytes: Math.max(tlsBuf, 4 * 1024 * 1024) } } } : {};
const vm = await AgentOs.create({
	...tlsLimits,
	permissions: process.env.CODEX_NET === "allow" ? { network: "allow" } : process.env.CODEX_NET === "deny" ? { network: "deny" } : {
		network: {
			default: "deny",
			rules: [
				{
					mode: "allow",
					operations: ["*"],
					patterns: allowHosts.flatMap((h) => [`dns://${h}`, `tcp://${h}:*`]),
				},
			],
		},
	},
});

console.error(`[host] VM created in ${Date.now() - t}ms`);

try {
	t = Date.now();
	await vm.software.install({ type: "path", path: resolve(process.env.CODEX_PKG ?? "build/codex/dist/package.aospkg") });
	console.error(`[host] codex installed in ${Date.now() - t}ms`);
	t = Date.now();
	console.error(`[host] tools: ${(await installTools(vm)).join(", ") || "(none)"} in ${Date.now() - t}ms`);

	await vm.filesystem.mkdir(CWD, { recursive: true });
	await vm.filesystem.writeFile(`${CWD}/notes.md`, "# Notes\n\nThis VM is an agentOS sandbox. Codex is running as WebAssembly.\n");

	// spawn's env replaces the VM default env; PATH is passed so Codex tool execs resolve.
	const env: Record<string, string> = { PATH: "/opt/agentos/bin:/usr/local/bin:/usr/bin:/bin", HOME, CODEX_HOME: `${HOME}/.codex` };
	if (process.env.OPENAI_API_KEY) env.OPENAI_API_KEY = process.env.OPENAI_API_KEY;
	await vm.filesystem.mkdir(`${HOME}/.codex`, { recursive: true });
	if (process.env.CODEX_AUTH_FILE) {
		await vm.filesystem.writeFile(`${HOME}/.codex/auth.json`, readFileSync(process.env.CODEX_AUTH_FILE, "utf8"));
		console.error("[host] copied auth file into VM");
	}

	let buffer = "";
	let pid = -1;
	let firstEventAt = 0;
	const decoder = new TextDecoder();
	const onEvent = async (event: any) => {
		firstEventAt ||= Date.now();
		switch (event.type) {
			case "text_delta":
				process.stdout.write(event.delta ?? event.text ?? "");
				break;
			case "reasoning_delta":
				break;
			case "tool_call_update":
				console.error(`\n[tool_call_update] ${JSON.stringify(event).slice(0, 300)}`);
				break;
			case "permission_request":
				// The VM is the sandbox, so approve everything the agent asks for.
				console.error(`\n[permission] auto-allow: ${event.command ?? event.title}`);
				await vm.process.writeStdin(pid, `${JSON.stringify({ type: "permission_response", request_id: event.request_id ?? event.tool_call_id, decision: "allow" })}\n`);
				break;
			case "done":
				console.error(`\n[done] stop_reason=${event.stop_reason}`);
				await vm.process.closeStdin(pid);
				break;
			case "error":
				console.error(`\n[codex error] ${event.message}`);
				await vm.process.closeStdin(pid);
				break;
			default:
				console.error(`[event] ${JSON.stringify(event).slice(0, 300)}`);
		}
	};

	t = Date.now();
	const proc = await vm.process.spawn("codex-exec", ["--session-turn"], {
		cwd: CWD,
		env,
		onStdout: (chunk) => {
			buffer += decoder.decode(chunk, { stream: true });
			let nl: number;
			while ((nl = buffer.indexOf("\n")) !== -1) {
				const line = buffer.slice(0, nl).trim();
				buffer = buffer.slice(nl + 1);
				if (!line) continue;
				try {
					void onEvent(JSON.parse(line));
				} catch {
					console.error(`[stdout] ${line}`);
				}
			}
		},
		onStderr: (chunk) => process.stderr.write(`[codex stderr] ${decoder.decode(chunk)}`),
	});
	pid = proc.pid;
	await vm.process.writeStdin(pid, `${JSON.stringify({ type: "start", cwd: CWD, mode: "default", model, history: [], prompt, reasoning_effort: "low" })}\n`);

	const exit = await vm.process.wait(pid);
	console.error(`[host] codex-exec ${exit.outcome} code=${exit.exitCode}; first event ${firstEventAt ? firstEventAt - t : "-"}ms after spawn; turn ${Date.now() - t}ms`);
} finally {
	await vm.dispose();
}
