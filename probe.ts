// Probe: can agentOS 0.4.1 install the July-era .aospkg agent packages and run them?
// Usage: npx tsx probe.ts build/codex/dist/package.aospkg
import { resolve } from "node:path";
import { AgentOs } from "@rivet-dev/agentos-core";

const pkgPath = resolve(process.argv[2] ?? "build/codex/dist/package.aospkg");

const vm = await AgentOs.create();
const run = async (cmd: string) => {
	const t = Date.now();
	try {
		const r = await vm.process.exec(cmd, { output: { capture: "all" } });
		console.log(`$ ${cmd}  [exit ${r.exitCode ?? r.status?.exitCode} in ${Date.now() - t}ms]`);
		if (r.stdout) console.log(r.stdout.trimEnd());
		if (r.stderr) console.log("stderr:", r.stderr.trimEnd().slice(0, 2000));
	} catch (e) {
		console.log(`$ ${cmd}  THREW:`, (e as Error).message);
	}
};

try {
	const t = Date.now();
	const installed = await vm.software.install({ type: "path", path: pkgPath });
	console.log(`installed ${installed.packageName}@${installed.version} in ${Date.now() - t}ms`);
	console.log("commands:", installed.commands);

	await run("ls /opt/agentos/bin | head -50");
	for (const c of installed.commands ?? []) await run(`${c} --version`);
	for (const c of installed.commands ?? []) await run(`${c} --help | head -30`);
} catch (e) {
	console.error("FAILED:", e);
} finally {
	await vm.dispose();
}
