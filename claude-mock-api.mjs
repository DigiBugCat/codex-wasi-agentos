// Tiny fake Anthropic Messages API, run INSIDE the agentOS VM, so Claude Code's full
// agent loop (stream -> tool_use -> local tool execution -> tool_result -> answer) can be
// exercised with no real credentials and no traffic to Anthropic.
// Turn 1: asks for the Bash tool. Turn 2: echoes the tool result back as text.
import http from "node:http";

const PORT = Number(process.env.MOCK_PORT ?? 8788);
const CMD = process.env.MOCK_BASH ?? "echo hello-from-bash; uname -sm; ls / | head -5; git --version 2>&1 | head -1";
let n = 0;

function sse(res, events) {
	res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", "request-id": `req_mock_${n}` });
	for (const [type, data] of events) res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
	res.end();
}
const usage = { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };

http
	.createServer((req, res) => {
		let body = "";
		req.on("data", (d) => (body += d));
		req.on("end", () => {
			n++;
			let j = {};
			try { j = JSON.parse(body || "{}"); } catch {}
			console.error(`[mock] ${req.method} ${req.url} stream=${j.stream} model=${j.model} msgs=${j.messages?.length} tools=${j.tools?.length ?? 0}`);
			if (!req.url.startsWith("/v1/messages")) { res.writeHead(404, { "content-type": "application/json" }); res.end('{"type":"error","error":{"type":"not_found_error","message":"mock"}}'); return; }
			if (req.url.startsWith("/v1/messages/count_tokens")) { res.writeHead(200, { "content-type": "application/json" }); res.end('{"input_tokens":10}'); return; }
			// The tool_result is in a user message after the last assistant turn. Headless -p sends it
			// as the last message; the interactive TUI can append another user message (reminders)
			// after it, so look at every message since the last assistant one.
			const msgs = j.messages ?? [];
			let lastAssistant = -1;
			msgs.forEach((m, i) => { if (m.role === "assistant") lastAssistant = i; });
			const toolResult = msgs.slice(lastAssistant + 1).flatMap((m) => (Array.isArray(m.content) ? m.content : [])).find((c) => c.type === "tool_result");
			const hasBash = (j.tools ?? []).some((t) => t.name === "Bash");
			const id = `msg_mock_${n}`;
			let content;
			if (toolResult) {
				const text = typeof toolResult.content === "string" ? toolResult.content : (toolResult.content ?? []).map((c) => c.text ?? "").join("");
				content = [{ type: "text", text: `MOCK SAW TOOL RESULT:\n${text}` }];
			} else if (hasBash) {
				content = [{ type: "tool_use", id: `toolu_mock_${n}`, name: "Bash", input: { command: CMD, description: "probe" } }];
			} else {
				content = [{ type: "text", text: "mock reply (no Bash tool offered)" }];
			}
			const stop = content[0].type === "tool_use" ? "tool_use" : "end_turn";
			if (!j.stream) {
				res.writeHead(200, { "content-type": "application/json" });
				res.end(JSON.stringify({ id, type: "message", role: "assistant", model: j.model, content, stop_reason: stop, stop_sequence: null, usage }));
				return;
			}
			const ev = [["message_start", { message: { id, type: "message", role: "assistant", model: j.model, content: [], stop_reason: null, stop_sequence: null, usage } }]];
			content.forEach((c, i) => {
				if (c.type === "text") {
					ev.push(["content_block_start", { index: i, content_block: { type: "text", text: "" } }]);
					ev.push(["content_block_delta", { index: i, delta: { type: "text_delta", text: c.text } }]);
				} else {
					ev.push(["content_block_start", { index: i, content_block: { type: "tool_use", id: c.id, name: c.name, input: {} } }]);
					ev.push(["content_block_delta", { index: i, delta: { type: "input_json_delta", partial_json: JSON.stringify(c.input) } }]);
				}
				ev.push(["content_block_stop", { index: i }]);
			});
			ev.push(["message_delta", { delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 5 } }]);
			ev.push(["message_stop", {}]);
			sse(res, ev);
		});
	})
	.listen(PORT, "127.0.0.1", () => console.error(`[mock] listening on 127.0.0.1:${PORT}`));
