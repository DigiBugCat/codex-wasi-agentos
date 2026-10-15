// Compare guest outbound fetch to api.openai.com under several network policies.
//   timeout 200 npx tsx nettest.ts
import { AgentOs } from "@rivet-dev/agentos-core";
const policies: Record<string, any> = {
	defaults: undefined,
	hostRules: { network: { default: "deny", rules: [{ mode: "allow", operations: ["*"], patterns: ["dns://api.openai.com", "tcp://api.openai.com:*"] }] } },
	allowAll: { network: "allow" },
};
const code = `
const net = require("node:net");
const dns = require("node:dns");
dns.lookup("api.openai.com", (e, a) => console.log("dns", e ? e.code + " " + e.message : a));
fetch("https://api.openai.com/v1/models").then(r => console.log("fetch HTTP", r.status)).catch(e => console.log("fetch ERR", e.cause?.code ?? "", e.cause?.message ?? e.message));
const s = net.connect(443, "api.openai.com", () => { console.log("tcp connected", s.remoteAddress); s.destroy(); });
s.on("error", e => console.log("tcp ERR", e.code, e.message));
`;
const only = process.argv[2];
for (const [name, permissions] of Object.entries(policies)) {
	if (only && name !== only) continue;
	const t = Date.now();
	const vm = await AgentOs.create(permissions ? { permissions } : {});
	const boot = Date.now() - t;
	await vm.filesystem.writeFile("/tmp/n.cjs", code);
	const r = await vm.process.exec("node /tmp/n.cjs", { output: { capture: "all" }, timeoutMs: 20000 } as any).catch((e: Error) => ({ stdout: "", stderr: "exec threw: " + e.message }));
	console.log(`== ${name} (boot ${boot}ms)\n${(r.stdout + r.stderr).trim()}`);
	await vm.dispose();
}
