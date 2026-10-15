// Re-bundle the extracted Bun module graph with esbuild so Bun's require(esm)-in-a-cycle
// semantics become esbuild lazy-init wrappers that Node/agentOS can evaluate.
// usage: node rebundle.mjs <esbuild-main.js> <extractDir> <outDir> <nodeModulesDir>
import { readdirSync, readFileSync, writeFileSync, mkdirSync, rmSync, statSync, copyFileSync, symlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { execFileSync } from "node:child_process";
const [esbuildPath, src, out, nm] = process.argv.slice(2);
const esbuild = await import(esbuildPath);
const stage = out + ".stage";
rmSync(stage, { recursive: true, force: true }); rmSync(out, { recursive: true, force: true });
for (const f of readdirSync(src, { recursive: true })) {
	const p = join(src, f); if (!statSync(p).isFile() || f.endsWith(".jsc")) continue;
	const dst = join(stage, f === "cli" ? "cli.js" : f); mkdirSync(dirname(dst), { recursive: true });
	let b = readFileSync(p);
	if (b[0] === 0x28 && b[1] === 0xb5 && b[2] === 0x2f && b[3] === 0xfd) b = execFileSync("zstd", ["-dc"], { input: b, maxBuffer: 1 << 28 });
	if (/\.(m?js)$/.test(dst) && b.subarray(0, 7).toString() === "// @bun") {
		let s = b.toString("utf8").replaceAll('"/$bunfs/root/cli"', '"./cli.js"').replaceAll('"/$bunfs/root/', '"./').replaceAll("import.meta.require", "require");
		s = s.replace(/import\.meta\.dir\b(?!name)/g, "import.meta.dirname");
		if (f === "cli") s = 'import"./bun-shim.js";' + s;
		b = Buffer.from(s);
	}
	writeFileSync(dst, b);
}
copyFileSync(new URL("./bun-shim.js", import.meta.url), join(stage, "bun-shim.js"));
copyFileSync(new URL("./bun-ant.js", import.meta.url), join(stage, "bun-ant.js"));
symlinkSync(nm, join(stage, "node_modules"));
const r = await esbuild.build({
	entryPoints: [join(stage, "cli.js")], bundle: true, splitting: true, format: "esm", platform: "node", target: "node22",
	outdir: out, external: ["bun:*", "*.node", "node-fetch", "ws", "yaml", "smol-toml", "semver", "string-width", "slice-ansi", "wrap-ansi", "strip-ansi"],
	loader: { ".txt": "text", ".md": "text", ".html": "text", ".css": "text", ".asset": "file", ".woff2": "file", ".png": "file", ".wasm": "file" },
	supported: { using: false }, logLevel: "error", logLimit: 15, legalComments: "none", minifyWhitespace: false,
	banner: { js: 'import{createRequire as __cr}from"node:module";import{readFileSync as __rf}from"node:fs";const __cr0=__cr(import.meta.url);const __bunRequire=Object.assign((p)=>{if(/\\.(txt|md|html|css|svg)$/.test(p))return __rf(__cr0.resolve(p),"utf8");if(/\\.(asset|woff2|png|zst)$/.test(p))return __cr0.resolve(p);return __cr0(p)},{resolve:__cr0.resolve,cache:__cr0.cache});' },
});
// agentOS injects its own lexical `require` into ESM scope, so point esbuild's helper at ours instead.
for (const f of readdirSync(out)) { if (!f.endsWith(".js")) continue; const p = join(out, f); const s0 = readFileSync(p, "utf8"); const s1 = s0.replaceAll('typeof require !== "undefined" ? require', 'typeof __bunRequire !== "undefined" ? __bunRequire').replaceAll("require.apply(this, arguments)", "__bunRequire.apply(this, arguments)"); if (s1 !== s0) writeFileSync(p, s1); }
for (const f of readdirSync(stage, { recursive: true })) { const p = join(stage, f); if (f.startsWith("node_modules") || /\.(m?js)$/.test(f) || !statSync(p).isFile()) continue; mkdirSync(dirname(join(out, f)), { recursive: true }); copyFileSync(p, join(out, f)); }
writeFileSync(join(out, "package.json"), JSON.stringify({ name: "claude-code-rebundled", version: "2.1.300", type: "module", bin: { claude: "cli.js" } }, null, 2));
console.log("errors", r.errors.length, "warnings", r.warnings.length);
