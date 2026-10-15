// Pack a prepared package tree (bin/, package.json with "bin", agentos-package.json, payload)
// into a v2 .aospkg using the 0.4.1 toolchain encoder.
// Usage: node scripts/claude-pack-tree.mjs <treeDir> <out.aospkg>
import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { packAospkgFromTar } from "@rivet-dev/agentos-toolchain";
const [tree, out] = process.argv.slice(2);
const tar = out.replace(/\.aospkg$/, "") + ".tar";
execFileSync("tar", ["-cf", tar, "-C", tree, "."]);
console.log(packAospkgFromTar(tar, out));
rmSync(tar);
