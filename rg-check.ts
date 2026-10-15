// Quick check: ripgrep from the registry installs and runs in a VM.
import { AgentOs } from "@rivet-dev/agentos-core";
import { installTools } from "./vm-tools.ts";
const vm = await AgentOs.create({ limits: { jsRuntime: { cpuTimeLimitMs: 0 }, wasm: { runnerCpuTimeLimitMs: 0 } } });
try {
	const t = Date.now();
	console.log("installed", await installTools(vm), `${Date.now() - t}ms`);
	await vm.filesystem.mkdir("/home/agentos/w", { recursive: true });
	await vm.filesystem.writeFile("/home/agentos/w/a.js", "const needle = 42;\n");
	for (const cmd of ["rg --version", "cd /home/agentos/w && rg -n needle", "cd /home/agentos/w && rg --files"]) {
		const r = await vm.process.exec(cmd, { output: { capture: "all" } });
		console.log(`$ ${cmd} -> exit ${r.exitCode ?? r.status?.exitCode}\n${(r.stdout ?? "").trim()}${r.stderr ? `\n[stderr] ${r.stderr.trim()}` : ""}`);
	}
} finally { await vm.dispose(); }
