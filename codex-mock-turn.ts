// One Codex `--session-turn` inside an agentOS 0.4.1 VM against a host-side
// mock OpenAI Responses API (mock-openai.ts). No credentials involved: the
// mock accepts the placeholder key "mock-key". The scripted model runs `ls`,
// then writes a file with a shell command, then answers; afterwards we read the
// file back out of the VM.
//
//   timeout 200 npx tsx codex-mock-turn.ts
//
// CODEX_PKG=<path> selects another package (e.g. build/codex-latest/dist/package.aospkg).
// Prereq: build/codex/dist/package.aospkg from scripts/aospkg-v1-to-v2.mjs +
// scripts/patch-codex-wasm.mjs.
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { AgentOs } from "@rivet-dev/agentos-core";
import { forbiddenToolsSeen, startMock, toolNames, toolScript } from "./mock-openai.ts";

const HOME = "/home/agentos";
const CWD = `${HOME}/work`;
const OUT = `${CWD}/codex-wrote-this.txt`;
const T0 = Date.now();
const log = (s: string) => console.error(`[host +${Date.now() - T0}ms] ${s}`);

const mock = await startMock(toolScript(OUT), (s) => log(`mock: ${s}`));
log(`mock Responses API on ${mock.url}`);

let t = Date.now();
// Newer Codex builds (CODEX_PKG) stream bigger responses; the default TLS plaintext buffer
// (1 MiB, limits.tls.maxBufferedBytes) was 81% full on a short real turn. Raise it to 16 MiB;
// the sidecar requires it to be <= limits.resources.maxSocketBufferedBytes (default 4 MiB).
const tlsBuf = Number(process.env.CODEX_TLS_BUF_BYTES ?? 16 * 1024 * 1024);
const tlsLimits = process.env.CODEX_PKG ? { limits: { tls: { maxBufferedBytes: tlsBuf }, resources: { maxSocketBufferedBytes: Math.max(tlsBuf, 4 * 1024 * 1024) } } } : {};
const vm = await AgentOs.create({
	...tlsLimits,
	// A custom network scope replaces the default one, so loopback to the mock
	// port has to be allowed explicitly next to the OpenAI hosts.
	permissions: {
		network: {
			default: "deny",
			rules: [{ mode: "allow", operations: ["*"], patterns: ["dns://api.openai.com", "tcp://api.openai.com:*", `tcp://127.0.0.1:${mock.port}`] }],
		},
	},
	// The guest's 127.0.0.1 is the VM's own loopback; this exempts the mock's
	// port so the connection goes out to the host's 127.0.0.1 instead.
	loopbackExemptPorts: [mock.port],
});
const bootMs = Date.now() - t;
log(`VM created in ${bootMs}ms`);

// A real session's model (gpt-6-astra is code_mode_only in Codex's bundled catalog), so the
// mock sees the tool set a real turn would offer. The July build keeps gpt-5.
const MOCK_MODEL = process.env.CODEX_MOCK_MODEL ?? (process.env.CODEX_PKG ? "gpt-6-astra" : "gpt-5");
let ok = false;
try {
	t = Date.now();
	await vm.software.install({ type: "path", path: resolve(process.env.CODEX_PKG ?? "build/codex/dist/package.aospkg") });
	log(`codex installed in ${Date.now() - t}ms`);

	await vm.filesystem.mkdir(`${HOME}/.codex`, { recursive: true });
	await vm.filesystem.mkdir(CWD, { recursive: true });
	await vm.filesystem.writeFile(`${CWD}/notes.md`, "# Notes\n\nThis VM is an agentOS sandbox. Codex is running as WebAssembly.\n");
	await vm.filesystem.writeFile(`${HOME}/.codex/config.toml`, "[features]\nshell_snapshot = false\n");

	// --session-turn ignores config.toml (patch 0001 loads built-in defaults), so
	// the built-in openai provider is redirected with OPENAI_BASE_URL.
	// spawn env replaces the VM default env, so PATH must be passed or Codex
	// tool execs fail with ENOENT (os error 44).
	const env = { ...(process.env.NO_PATH ? {} : { PATH: "/opt/agentos/bin:/usr/local/bin:/usr/bin:/bin" }), HOME, CODEX_HOME: `${HOME}/.codex`, OPENAI_API_KEY: "mock-key", OPENAI_BASE_URL: `${mock.url}/v1` };

	let buffer = "";
	let pid = -1;
	let firstEventAt = 0;
	const counts: Record<string, number> = {};
	const decoder = new TextDecoder();
	const onEvent = async (event: any) => {
		counts[event.type] = (counts[event.type] ?? 0) + 1;
		firstEventAt ||= Date.now();
		if (event.type === "text_delta") process.stdout.write(event.delta ?? "");
		else if (event.type === "permission_request") {
			console.error(`[permission_request] ${JSON.stringify(event).slice(0, 300)} -> allow`);
			await vm.process.writeStdin(pid, `${JSON.stringify({ type: "permission_response", request_id: event.request_id ?? event.tool_call_id, decision: "allow" })}\n`);
		} else if (event.type === "done" || event.type === "error") {
			console.error(`\n[${event.type}] ${JSON.stringify(event).slice(0, 400)}`);
			await vm.process.closeStdin(pid);
		} else console.error(`[${event.type}] ${JSON.stringify(event).slice(0, 500)}`);
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
				let event: unknown;
				try {
					event = JSON.parse(line);
				} catch {
					console.error(`[stdout] ${line}`);
					continue;
				}
				void onEvent(event);
			}
		},
		onStderr: (chunk) => process.stderr.write(`[codex stderr] ${decoder.decode(chunk)}`),
	});
	pid = proc.pid;
	await vm.process.writeStdin(pid, `${JSON.stringify({ type: "start", cwd: CWD, mode: "default", model: MOCK_MODEL, history: [], prompt: "List the files here, then write codex-wrote-this.txt.", reasoning_effort: "low" })}\n`);

	const exit = await vm.process.wait(pid);
	log(`codex-exec ${exit.outcome} code=${exit.exitCode}; first event ${firstEventAt ? firstEventAt - t : "-"}ms after spawn; turn ${Date.now() - t}ms`);
	log(`events ${JSON.stringify(counts)}; mock served ${mock.requests.length} requests`);
	if (process.env.CODEX_MOCK_DUMP) writeFileSync(process.env.CODEX_MOCK_DUMP, JSON.stringify(mock.requests, null, 2));
	for (const o of mock.requests.slice(-1).flatMap((b) => (b.input ?? []).filter((i: any) => i?.type === "function_call_output"))) log(`tool result ${o.call_id}: ${JSON.stringify(o.output).slice(0, 300)}`);

	const out = new TextDecoder().decode(await vm.filesystem.readFile(OUT));
	log(`VM file ${OUT} = ${JSON.stringify(out)}`);
	ok = out.trim() === "codex-mock-ok" && (counts.tool_call_update ?? 0) > 0 && (counts.done ?? 0) === 1;
	const forbidden = forbiddenToolsSeen(mock.requests);
	log(`model ${MOCK_MODEL}; tools offered: ${[...new Set(mock.requests.flatMap(toolNames))].join(",") || "-"}`);
	if (forbidden.length) log(`FORBIDDEN tools offered (need helper binaries agentOS lacks): ${forbidden.join(",")}`);
	ok &&= forbidden.length === 0 && mock.requests.length > 0;
} catch (e) {
	log(`FAILED: ${(e as Error).message}`);
} finally {
	await vm.dispose();
	await mock.stop();
}
log(ok ? "PASS" : "FAIL");
process.exit(ok ? 0 : 1);
