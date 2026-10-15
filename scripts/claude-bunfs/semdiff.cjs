// Semantic diff of two rebundled lib/ dirs: pairs chunks by their bunfs name (ignoring esbuild's
// content hash), strips path-dependent comments/__esm keys, and prints the first difference.
// usage: node semdiff.cjs <oldLib> <newLib>
const fs = require("fs");
const [O, N] = process.argv.slice(2);
const key = (f) => f.replace(/-[A-Z0-9]{8}\.js$/, "");
const norm = (s) =>
	s
		.split("\n")
		.filter((l) => !l.startsWith("// ../"))
		.map((l) => {
			const i = l.indexOf("rb-cc-2.1.300.stage/");
			if (i < 0) return l;
			const q = l.lastIndexOf('"', i);
			return q < 0 ? l : l.slice(0, q + 1) + l.slice(i + "rb-cc-2.1.300.stage/".length);
		})
		.join("\n")
		.replace(/chunk-([a-z0-9]+-)?[A-Z0-9]{8}\.js/g, "chunk.js")
		.replace(/__ns_[a-z_]+_\d+/g, "__ns");
const mapf = (d) => Object.fromEntries(fs.readdirSync(d).filter((f) => /\.m?js$/.test(f)).map((f) => [key(f), f]));
const mo = mapf(O), mn = mapf(N);
const diffs = [];
for (const k of new Set([...Object.keys(mo), ...Object.keys(mn)])) {
	if (!mo[k] || !mn[k]) { diffs.push(`ONLY ${mo[k] ? "old" : "new"} ${k}`); continue; }
	const a = norm(fs.readFileSync(`${O}/${mo[k]}`, "utf8")), b = norm(fs.readFileSync(`${N}/${mn[k]}`, "utf8"));
	if (a === b) continue;
	let i = 0;
	while (a[i] === b[i]) i++;
	diffs.push(`DIFF ${k} @${i}\n   old: ${JSON.stringify(a.slice(Math.max(0, i - 150), i + 250))}\n   new: ${JSON.stringify(b.slice(Math.max(0, i - 150), i + 250))}`);
}
console.log(`${diffs.length} differing files`);
console.log(diffs.slice(0, 20).join("\n"));
