// Repack a July-era v1 .aospkg whose payload is a JS closure (bin/ symlinks into
// node_modules/, root package.json with a "bin" map) into the v2 format that the
// agentOS 0.4.x sidecar accepts. Unlike aospkg-v1-to-v2.mjs this does NOT run
// `agentos-toolchain build` (which keeps only bin/ + share/ and would drop the
// node_modules closure); it re-encodes the extracted tree directly with the
// toolchain's packAospkgFromTar.
//
// Usage: node scripts/aospkg-v1-to-v2-closure.mjs <in.aospkg> <outDir> <agentos-package.json> [--prune-native]
//   <agentos-package.json>: source manifest; its name and agent.env are carried
//   into the v2 manifest (name, version from root package.json, provides.env).
//   --prune-native: drop vendored native executables / .node / .so files
//   (ripgrep, audio-capture, sharp) that can never run in agentOS anyway.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { packAospkgFromTar } from "@rivet-dev/agentos-toolchain";

const args = process.argv.slice(2);
const prune = args.includes("--prune-native");
const [input, outDirArg, srcManifestPath] = args.filter((a) => !a.startsWith("--"));
const outDir = resolve(outDirArg);
const buf = readFileSync(input);
if (buf.readUInt32BE(0) !== 0x89414f53) throw new Error("not an .aospkg");
const manifestLen = buf.readUInt32LE(8);
const indexLen = buf.readUInt32LE(12);
console.log(`format v${buf.readUInt16LE(4)}, manifest ${manifestLen}B, index ${indexLen}B`);

const tree = join(outDir, "pkg");
rmSync(outDir, { recursive: true, force: true });
mkdirSync(tree, { recursive: true });
const tarIn = join(outDir, "chunk3.tar");
writeFileSync(tarIn, buf.subarray(16 + manifestLen + indexLen));
execFileSync("tar", ["xf", tarIn, "-C", tree]);
rmSync(tarIn);

if (prune) {
	const nativeMagic = (p) => {
		const h = readFileSync(p).subarray(0, 4);
		return h.equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) || [0xfeedfacf, 0xcffaedfe, 0xcafebabe, 0xfeedface, 0xcefaedfe].includes(h.readUInt32BE(0)) || (h[0] === 0x4d && h[1] === 0x5a);
	};
	let n = 0;
	const walk = (d) => {
		for (const e of readdirSync(d, { withFileTypes: true })) {
			const p = join(d, e.name);
			if (e.isDirectory()) walk(p);
			else if (e.isFile() && statSync(p).size >= 4 && (/\.(node|so(\.\d+)*|dylib|dll|exe)$/.test(e.name) || nativeMagic(p))) {
				rmSync(p);
				n++;
			}
		}
	};
	walk(join(tree, "node_modules"));
	console.log(`pruned ${n} native file(s)`);
}

const rootPkg = JSON.parse(readFileSync(join(tree, "package.json"), "utf8"));
const src = JSON.parse(readFileSync(srcManifestPath, "utf8"));
const manifest = { name: src.name, version: rootPkg.version, provides: { env: src.agent?.env ?? {} } };
writeFileSync(join(tree, "agentos-package.json"), JSON.stringify(manifest, null, 2) + "\n");
console.log("manifest:", JSON.stringify(manifest));

mkdirSync(join(outDir, "dist"), { recursive: true });
const tarOut = join(outDir, "dist", "package.tar");
execFileSync("tar", ["-cf", tarOut, "-C", tree, "."]);
const summary = packAospkgFromTar(tarOut, join(outDir, "dist", "package.aospkg"));
rmSync(tarOut);
console.log("packed:", summary, "->", join(outDir, "dist", "package.aospkg"));
