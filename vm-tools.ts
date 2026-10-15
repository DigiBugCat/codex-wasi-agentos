// Extra agentOS registry software for agent VMs (e.g. ripgrep, which Codex and Claude Code both reach for).
// Packages are downloaded once from the agentOS release registry, sha256-verified against the manifest,
// cached under build/registry/, and installed into each VM from the local path (fast, no guest network).
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { AgentOs } from "@rivet-dev/agentos-core";

const REGISTRY = "https://releases.rivet.dev/agent-os/latest/software/";
const CACHE = resolve("build/registry");

type Artifact = { name: string; digest: string; path: string };

/** Local path to a verified registry package, downloading it on first use. */
export async function registryPackage(name: string): Promise<string> {
	mkdirSync(CACHE, { recursive: true });
	const manifestPath = resolve(CACHE, "manifest.json");
	if (!existsSync(manifestPath)) writeFileSync(manifestPath, Buffer.from(await (await fetch(`${REGISTRY}manifest.json`)).arrayBuffer()));
	const { artifacts } = JSON.parse(readFileSync(manifestPath, "utf8")) as { artifacts: Artifact[] };
	const artifact = artifacts.find((a) => a.name === name);
	if (!artifact) throw new Error(`${name} is not in the agentOS software registry`);
	const hex = artifact.digest.replace(/^sha256:/, "");
	const local = resolve(CACHE, `${name}-${hex.slice(0, 12)}.aospkg`);
	if (!existsSync(local)) {
		const bytes = Buffer.from(await (await fetch(new URL(artifact.path, REGISTRY))).arrayBuffer());
		const got = createHash("sha256").update(bytes).digest("hex");
		if (got !== hex) throw new Error(`${name}: digest mismatch (expected ${hex}, got ${got})`);
		writeFileSync(local, bytes);
	}
	return local;
}

/** Install registry packages (default: ripgrep) into a running VM. Set VM_TOOLS="" to skip. */
export async function installTools(vm: AgentOs, names = (process.env.VM_TOOLS ?? "ripgrep").split(",").filter(Boolean)): Promise<string[]> {
	const installed: string[] = [];
	for (const name of names) {
		const pkg = await vm.software.install({ type: "path", path: await registryPackage(name) });
		installed.push(`${pkg.packageName}@${pkg.version}`);
	}
	return installed;
}
