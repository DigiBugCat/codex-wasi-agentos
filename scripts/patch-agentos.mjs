// agentos-core 0.4.1 builds default-software paths with `URL.pathname`, which
// keeps %20 escapes, so the VM fails to boot from any directory with a space
// (e.g. ~/Library/Application Support). Swap in fileURLToPath.
import { readFileSync, writeFileSync } from "node:fs";

const file = "node_modules/@rivet-dev/agentos-core/dist/default-software.js";
let src = readFileSync(file, "utf8");
if (!src.includes("fileURLToPath")) {
	src = src
		.replace('import { readFileSync } from "node:fs";', 'import { readFileSync } from "node:fs";\nimport { fileURLToPath } from "node:url";')
		.replace("new URL(`${name}.aospkg`, artifactDirectory).pathname", "fileURLToPath(new URL(`${name}.aospkg`, artifactDirectory))");
	writeFileSync(file, src);
	console.log("patched", file);
}
