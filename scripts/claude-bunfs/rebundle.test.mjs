import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const require = createRequire(import.meta.url);
const rebundlePath = fileURLToPath(new URL("./rebundle.mjs", import.meta.url));

test("rebundle stages and bundles the Bun file shim", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "claude-bunfs-rebundle-"));
	t.after(() => rm(root, { recursive: true, force: true }));

	const src = join(root, "extract");
	const out = join(root, "out");
	const nm = join(root, "node_modules");
	await Promise.all([mkdir(src), mkdir(nm)]);
	await writeFile(join(src, "cli"), '// @bun\nconsole.log("synthetic entry");\n');

	const esbuildPath = process.env.CLAUDE_BUNFS_ESBUILD_MAIN ?? require.resolve("esbuild");
	execFileSync(process.execPath, [rebundlePath, esbuildPath, src, out, nm]);

	assert.equal(
		await readFile(join(out + ".stage", "bun-file.js"), "utf8"),
		await readFile(new URL("./bun-file.js", import.meta.url), "utf8"),
	);
	const bundled = (await Promise.all((await readdir(out, { recursive: true }))
		.filter((path) => path.endsWith(".js"))
		.map((path) => readFile(join(out, path), "utf8")))).join("\n");
	assert.match(bundled, /byteOffset/);
});
