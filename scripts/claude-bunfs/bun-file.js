import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";

export const file = (p) => ({
	name: String(p), text: async () => readFileSync(p, "utf8"), json: async () => JSON.parse(readFileSync(p, "utf8")),
	arrayBuffer: async () => {
		const bytes = readFileSync(p);
		return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
	},
	exists: async () => existsSync(p), get size() { try { return statSync(p).size; } catch { return 0; } },
	write: async (d) => writeFileSync(p, d),
});
