// Does the 0.4.1 registry `git` package clone over HTTPS inside a VM?
//   npx tsx git-probe.ts [repo-url]
import { AgentOs } from "@rivet-dev/agentos-core";

const repo = process.argv[2] ?? "https://github.com/octocat/Hello-World.git";
const base = "https://releases.rivet.dev/agent-os/latest/software/";
const manifest = (await (await fetch(`${base}manifest.json`)).json()) as { artifacts: { name: string; digest: string; path: string }[] };
const git = manifest.artifacts.find((a) => a.name === "git")!;

const vm = await AgentOs.create({
	permissions: { network: "allow" },
	limits: { jsRuntime: { cpuTimeLimitMs: 0 }, wasm: { runnerCpuTimeLimitMs: 0 } },
});
const run = async (cmd: string) => {
	const t = Date.now();
	const r = await vm.process.exec(cmd, { output: { capture: "all" } });
	console.log(`$ ${cmd}  [exit ${r.exitCode ?? r.status?.exitCode} ${Date.now() - t}ms]`);
	const out = `${r.stdout ?? ""}${r.stderr ?? ""}`.trim();
	if (out) console.log(out.slice(0, 1200));
};
try {
	const installed = await vm.software.install({ type: "url", url: new URL(git.path, base).href, expectedDigest: git.digest });
	console.log(`installed ${installed.packageName}@${installed.version}`, installed.commands);
	await run("git --version");
	// Full (non-shallow) clone, then the operations the self-hosted runner needs.
	await run("cd /home/agentos && git clone " + repo + " repo 2>&1 | tail -2; git -C repo log --oneline -2");
	await run("git -C /home/agentos/repo fetch --no-progress --no-tags origin 2>&1; echo fetch-exit=$?");
	await run("git -C /home/agentos/repo -c gc.autoDetach=false -c maintenance.autoDetach=false fetch --no-progress --no-tags origin 2>&1; echo fetch-nodetach-exit=$?");
	await run("git -C /home/agentos/repo worktree add -b wt-test ../wt HEAD 2>&1; echo worktree-exit=$?; ls ../wt 2>&1 || ls /home/agentos/wt");
	await run("cd /home/agentos/repo && git config user.email t@t && git config user.name t && echo hi > new.txt && git add new.txt && git commit -qm test && git log --oneline -1; echo commit-exit=$?");
	await run("cd /home/agentos && git clone --depth 1 " + repo + " shallow 2>&1 | tail -1; git -C shallow fetch --depth 1 origin 2>&1; echo shallow-fetch-exit=$?");
} finally {
	await vm.dispose();
}
