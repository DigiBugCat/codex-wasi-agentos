// Which named exports used by the extracted Claude Code 2.1.300 bundle are missing from
// agentOS 0.4.1's guest builtins (ESM namespace) — and which are present only via default/CJS?
// Usage: npx tsx claude-builtin-check.ts <names.json>
import { readFileSync } from "node:fs";
import { AgentOs } from "@rivet-dev/agentos-core";
const need = JSON.parse(readFileSync(process.argv[2], "utf8"));
const vm = await AgentOs.create();
try {
	const src = `const need=${JSON.stringify(need)};const out={};
for (const [mod, names] of Object.entries(need)) {
  let ns; try { ns = await import(mod); } catch (e) { out[mod] = "IMPORT FAILED: " + e.message; continue; }
  let cjs; try { cjs = (await import("node:module")).createRequire("/x.js")(mod); } catch {}
  const miss = names.filter((n) => !(n in ns));
  if (miss.length) out[mod] = miss.map((n) => n + (cjs && n in cjs ? "(cjs-only)" : ""));
}
console.log(JSON.stringify(out, null, 1));`;
	const r = await vm.javascript.execute(src, { timeoutMs: 60000, output: { capture: "all" } });
	console.log(r.stdout, r.stderr ?? "", r.error ? JSON.stringify(r.error) : "");
} finally { await vm.dispose(); }
