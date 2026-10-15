// Tiny host-side mock of the OpenAI Responses API (POST /v1/responses, SSE when
// `stream: true`). Adapted from agent-os `packages/core/tests/helpers/
// openai-responses-mock.ts` at a6c668c^. Each request is answered by the first
// fixture whose predicate matches the request body.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

export type ResponsesBody = Record<string, any>;
export type Fixture = { name: string; when: (body: ResponsesBody) => boolean; output: Record<string, unknown>[] };
export type Mock = { url: string; port: number; requests: ResponsesBody[]; stop: () => Promise<void> };

async function readJson(req: IncomingMessage): Promise<ResponsesBody> {
	const chunks: Buffer[] = [];
	for await (const c of req) chunks.push(Buffer.from(c));
	return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function send(res: ServerResponse, status: number, type: string, payload: string) {
	res.writeHead(status, { "content-type": type, "content-length": Buffer.byteLength(payload) });
	res.end(payload);
}

function sse(id: string, output: Record<string, unknown>[]) {
	const usage = { input_tokens: 0, input_tokens_details: null, output_tokens: 0, output_tokens_details: null, total_tokens: 0 };
	const events = [
		{ type: "response.created", response: { id } },
		...output.map((item) => ({ type: "response.output_item.done", item })),
		{ type: "response.completed", response: { id, usage } },
	];
	return events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
}

export async function startMock(fixtures: Fixture[], log = (_: string) => {}): Promise<Mock> {
	const requests: ResponsesBody[] = [];
	const server = createServer(async (req, res) => {
		if (req.method !== "POST" || req.url !== "/v1/responses") {
			log(`${req.method} ${req.url} -> 404`);
			return send(res, 404, "application/json", JSON.stringify({ error: "not_found" }));
		}
		const body = await readJson(req);
		requests.push(body);
		const fx = fixtures.find((f) => f.when(body));
		log(`POST /v1/responses #${requests.length} model=${body.model} stream=${body.stream} tools=${toolNames(body).join(",")} -> ${fx?.name ?? "no fixture"}`);
		if (!fx) return send(res, 500, "application/json", JSON.stringify({ error: "no_matching_fixture" }));
		const id = `resp_${fx.name}`;
		if (body.stream === true) send(res, 200, "text/event-stream", sse(id, fx.output));
		else send(res, 200, "application/json", JSON.stringify({ id, output: fx.output }));
	});
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	const addr = server.address();
	if (!addr || typeof addr === "string") throw new Error("mock has no TCP port");
	return {
		url: `http://127.0.0.1:${addr.port}`,
		port: addr.port,
		requests,
		stop: () => new Promise((r) => server.close(() => r())),
	};
}

/** Tool names advertised in a Responses request: `tools`, plus the `additional_tools` input
 * items newer Codex sends (namespaces such as `functions` / `collaboration`, walked recursively). */
export const toolNames = (body: ResponsesBody): string[] => {
	const out: string[] = [];
	const walk = (tools: any[]) => {
		for (const t of tools ?? []) {
			if (t?.type === "namespace") walk(t.tools);
			else out.push(t?.name ?? t?.type);
		}
	};
	walk(body.tools ?? []);
	for (const item of body.input ?? []) if (item?.type === "additional_tools") walk(item.tools);
	return out;
};

// Tools that would make Codex spawn a helper binary agentOS does not have. Code mode's
// `exec`/`wait` run inside `codex-code-mode-host` (a V8 host, not buildable for WASI); a real
// gpt-6-astra session is code_mode_only in the bundled model catalog. MOCK_FORBID_TOOLS=""
// disables the check.
export const FORBIDDEN_TOOLS = (process.env.MOCK_FORBID_TOOLS ?? "exec,wait").split(",").filter(Boolean);
export const forbiddenToolsSeen = (requests: ResponsesBody[]): string[] =>
	[...new Set(requests.flatMap(toolNames).filter((n) => FORBIDDEN_TOOLS.includes(n)))];

/** Count tool results Codex has sent back so far (one per completed tool call). */
export const toolOutputs = (body: ResponsesBody) =>
	(body.input ?? []).filter((i: any) => i?.type === "function_call_output").length;

// Codex at this revision advertises `exec_command` (cmd string), not the
// legacy `shell` (argv array) tool. MOCK_TOOL=shell sends the legacy call; in
// this build it is routed but the exec fails with ENOENT (os error 44).
const shellCall = (callId: string, command: string[]) => ({
	type: "function_call",
	name: "shell",
	call_id: callId,
	arguments: JSON.stringify({ command }),
});
const execCommand = (callId: string, cmd: string) => ({
	type: "function_call",
	name: "exec_command",
	call_id: callId,
	arguments: JSON.stringify({ cmd }),
});
const call = (callId: string, cmd: string) =>
	process.env.MOCK_TOOL === "shell" ? shellCall(callId, ["sh", "-c", cmd]) : execCommand(callId, cmd);
const message = (text: string) => ({ type: "message", role: "assistant", content: [{ type: "output_text", text }] });

/** Scripted turn: run `ls`, then write a file with a shell command, then answer. */
export const toolScript = (outFile: string): Fixture[] => [
	{ name: "ls", when: (b) => toolOutputs(b) === 0, output: [call("call_ls", "ls -la")] },
	{
		name: "write",
		when: (b) => toolOutputs(b) === 1,
		output: [call("call_write", `echo codex-mock-ok > ${outFile} && cat ${outFile}`)],
	},
	{ name: "final", when: (b) => toolOutputs(b) >= 2, output: [message(`Listed the directory and wrote ${outFile}.`)] },
];
