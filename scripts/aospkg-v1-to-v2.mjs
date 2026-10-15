// Repack a July-era v1 .aospkg (agentOS <=0.3) so the 0.4.x sidecar accepts it.
// Both versions share the container: 16-byte header, chunk1 manifest, chunk2
// index, chunk3 = the plain mount tar. We pull chunk3 out, unpack it, and let
// `agentos-toolchain build` re-encode a v2 package from it.
// Usage: node scripts/aospkg-v1-to-v2.mjs <in.aospkg> <outDir> <name> <version>
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [input, outDir, name, version] = process.argv.slice(2);
const buf = readFileSync(input);
if (buf.readUInt32BE(0) !== 0x89414f53) throw new Error("not an .aospkg");
const formatVersion = buf.readUInt16LE(4);
const manifestLen = buf.readUInt32LE(8);
const indexLen = buf.readUInt32LE(12);
console.log(`format v${formatVersion}, manifest ${manifestLen}B, index ${indexLen}B`);

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });
const tarPath = join(outDir, "chunk3.tar");
writeFileSync(tarPath, buf.subarray(16 + manifestLen + indexLen));
execFileSync("tar", ["xf", tarPath, "-C", outDir]);
rmSync(tarPath);

for (const f of ["agentos-package.json", "package.json"]) writeFileSync(join(outDir, f), JSON.stringify({ name, version }, null, 2));
execFileSync("npx", ["agentos-toolchain", "build", outDir], { stdio: "inherit" });
