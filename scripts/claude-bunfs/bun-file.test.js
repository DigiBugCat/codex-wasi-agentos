import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { file } from "./bun-file.js";

test("file.arrayBuffer returns only the file bytes", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "bun-file-"));
	t.after(() => rm(dir, { recursive: true, force: true }));

	const bytes = Uint8Array.of(0x41, 0x00, 0xff);
	const path = join(dir, "tiny.bin");
	await writeFile(path, bytes);

	const result = await file(path).arrayBuffer();
	assert.equal(result.byteLength, bytes.byteLength);
	assert.deepEqual(new Uint8Array(result), bytes);
});
