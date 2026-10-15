// Minimal globalThis.Bun polyfill so the bunfs-extracted Claude Code bundle can boot on Node/agentOS.
// Experimental; covers the APIs seen on the --version/--help/-p paths only.
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { Readable } from "node:stream";
import { readFileSync, existsSync, statSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { spawn as cpSpawn } from "node:child_process";
const require = createRequire(import.meta.url);
const yaml = require("yaml");
const toml = require("smol-toml");
const semver = require("semver");
const { default: stringWidth } = await import("string-width");
const { default: sliceAnsi } = await import("slice-ansi");
const { default: wrapAnsi } = await import("wrap-ansi");
const { default: stripAnsi } = await import("strip-ansi");
import { createBunAnt } from "./bun-ant.js";

const CRC = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (b) => { b = typeof b === "string" ? Buffer.from(b) : b; let c = 0xffffffff; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const hash = (x) => BigInt("0x" + createHash("sha256").update(typeof x === "string" ? x : Buffer.from(x)).digest("hex").slice(0, 16));
hash.crc32 = crc32;
const which = (cmd, opts) => {
	if (cmd.includes("/")) return existsSync(cmd) ? cmd : null;
	for (const d of (opts?.PATH ?? process.env.PATH ?? "").split(delimiter)) {
		const p = join(d, cmd);
		try { if (statSync(p).isFile()) return p; } catch {}
	}
	return null;
};
const toWebStream = (s) => Readable.toWeb(s);
// Bun.spawn subset: argv array or {cmd}, returns {pid, exited, stdout, stderr, kill}
const spawn = (cmdOrOpts, maybeOpts) => {
	const opts = Array.isArray(cmdOrOpts) ? maybeOpts ?? {} : cmdOrOpts;
	const argv = Array.isArray(cmdOrOpts) ? cmdOrOpts : cmdOrOpts.cmd;
	const map = (v) => (v === "inherit" || v === "ignore" || v === "pipe" ? v : v == null ? "pipe" : "ignore");
	const stdio = opts.stdio ? opts.stdio.map(map) : [map(opts.stdin ?? "ignore"), map(opts.stdout ?? "pipe"), map(opts.stderr ?? "inherit")];
	const child = cpSpawn(argv[0], argv.slice(1), { cwd: opts.cwd, env: opts.env, stdio, argv0: opts.argv0, detached: opts.detached });
	const exited = new Promise((res) => child.on("close", (code, sig) => res(code ?? (sig ? 128 : 0))));
	return {
		pid: child.pid, exited, kill: (s) => child.kill(s), unref: () => child.unref(), ref: () => child.ref(),
		stdin: child.stdin, stdout: child.stdout ? toWebStream(child.stdout) : undefined, stderr: child.stderr ? toWebStream(child.stderr) : undefined,
		get exitCode() { return child.exitCode; },
	};
};
const file = (p) => ({
	name: String(p), text: async () => readFileSync(p, "utf8"), json: async () => JSON.parse(readFileSync(p, "utf8")),
	arrayBuffer: async () => readFileSync(p).buffer, exists: async () => existsSync(p), get size() { try { return statSync(p).size; } catch { return 0; } },
	write: async (d) => writeFileSync(p, d),
});
const missing = new Set();
const Bun = new Proxy({
	version: "1.3.0-node-shim", revision: "shim", main: process.argv[1], isStandaloneExecutable: false,
	hash, which, spawn, file, semver: { order: (a, b) => semver.compare(a, b), satisfies: (v, r) => semver.satisfies(v, r) },
	deepEquals: (a, b) => isDeepStrictEqual(a, b), YAML: { parse: (s) => yaml.parse(s), stringify: (v, r, sp) => yaml.stringify(v, { indent: typeof sp === "number" ? sp : 2 }) },
	TOML: { parse: (s) => toml.parse(s) }, JSONL: { parse: (s) => s.split("\n").filter(Boolean).map((l) => JSON.parse(l)) },
	stringWidth: (s, o) => stringWidth(s, o), sliceAnsi: (s, a, b) => sliceAnsi(s, a, b), wrapAnsi: (s, w, o) => wrapAnsi(s, w, o), stripANSI: (s) => stripAnsi(s),
	sleepSync: (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms), gc: () => {},
	zstdDecompressSync: () => { throw new Error("Bun.zstdDecompressSync not shimmed"); }, zstdDecompress: async () => { throw new Error("Bun.zstdDecompress not shimmed"); },
	stdin: { stream: () => Readable.toWeb(process.stdin), text: async () => { let s = ""; for await (const c of process.stdin) s += c; return s; } },
	unsafe: { setJITPolicy() {} },
	ant: createBunAnt({ stringWidth }), // Bun.ant.CellSegmenter for the interactive TUI renderer (bun-ant.js)
	env: process.env,
}, {
	get(t, k) {
		if (k in t) return t[k];
		if (typeof k === "string" && !missing.has(k)) { missing.add(k); if (process.env.BUN_SHIM_DEBUG) process.stderr.write(`[bun-shim] missing Bun.${k}\n`); }
		return undefined;
	},
});
globalThis.Bun = Bun;

// agentOS 0.4.1: async_hooks.AsyncResource.bind() calls the class without `new`.
{
	const ah = await import("node:async_hooks");
	const AR = ah.AsyncResource ?? ah.default?.AsyncResource;
	try { AR.bind(() => {})(); } catch { try { AR.bind = (fn) => fn; } catch {} if (process.env.BUN_SHIM_DEBUG) process.stderr.write("[bun-shim] patched AsyncResource.bind\n"); }
}

