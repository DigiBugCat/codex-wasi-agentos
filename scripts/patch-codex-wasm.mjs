// Fix the host_net socket-family ABI mismatch in the July codex wasm, then
// rebuild build/codex/dist/package.aospkg.
//
// The codex-cli 0.3.4 wasm was compiled when agentOS's wasi-http crate called
// `net_socket(AF_INET=2, SOCK_STREAM=1, 0, &fd)` (Linux numbering). On
// 2026-07-09 (agent-os 4d6fa10) the runner switched host_net to the wasi-libc
// ABI: AF_INET=1, AF_INET6=2, AF_UNIX=3. Under the 0.4.1 runner the old `2` is
// read as AF_INET6, so net_connect asks the sidecar for an IPv6 connection to
// "api.openai.com:443". On a host without IPv6 egress that fails with
// EHOSTUNREACH (WASI errno 23), whatever the network policy says.
//
// The wasm has exactly one net_socket call site (wasi-http HttpClient::connect):
//   i32.const 2; i32.const 1; i32.const 0; local.get 2; i32.const 48; i32.add; call $net_socket
// We flip the first immediate 2 -> 1. Same length, so no re-encoding is needed.
//
// Usage: node scripts/patch-codex-wasm.mjs [build/codex]
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.argv[2] ?? "build/codex";
// call 9 = host_net.net_socket (import index 9 in this build); verified with wasmparser.
const before = Buffer.from("410241014100200241306a1009", "hex");
const after = Buffer.from("410141014100200241306a1009", "hex");

for (const cmd of ["codex", "codex-exec"]) {
	const file = join(dir, "bin", cmd);
	const buf = readFileSync(file);
	const at = buf.indexOf(before);
	if (at === -1) {
		if (buf.indexOf(after) !== -1) {
			console.log(`${file}: already patched`);
			continue;
		}
		throw new Error(`${file}: net_socket call site not found; different build?`);
	}
	if (buf.indexOf(before, at + 1) !== -1) throw new Error(`${file}: call site pattern is not unique`);
	buf[at + 1] = 0x01;
	writeFileSync(file, buf);
	console.log(`${file}: patched net_socket domain 2 -> 1 at byte ${at + 1}`);
}
execFileSync("npx", ["agentos-toolchain", "build", dir], { stdio: "inherit" });
