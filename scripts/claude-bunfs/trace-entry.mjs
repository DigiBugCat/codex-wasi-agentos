#!/usr/bin/env node
// Diagnostic entry for the rebundled Claude Code: wraps fs / fs.promises / child_process /
// worker_threads / timers on the CJS builtin objects (agentOS ESM builtin namespaces are live
// views of them) BEFORE cli.js and its chunks evaluate, then appends call counters and notable
// events to $CLAUDE_TRACE_FILE (default /tmp/claude-trace.log).
// Usage inside the VM: node /opt/agentos/pkgs/claude2/<ver>/lib/trace-entry.mjs <claude args...>
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const fs = require("fs");
const OUT = process.env.CLAUDE_TRACE_FILE ?? "/tmp/claude-trace.log";
const append = fs.appendFileSync.bind(fs);
const t0 = Date.now();
const counts = new Map();
let total = 0;
let lastDump = 0;
const emit = (s) => { try { append(OUT, `+${Date.now() - t0}ms ${s}\n`); } catch {} };
const dump = (why) => {
	const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([k, v]) => `${v}x ${k}`).join("\n    ");
	emit(`DUMP(${why}) total=${total}\n    ${top}`);
};
const short = (a) => (typeof a === "string" ? a.slice(0, 90) : typeof a === "number" ? `fd${a}` : a instanceof URL ? a.href : typeof a === "function" ? "fn" : Array.isArray(a) ? `[${a.slice(0, 4).map(short).join(" ")}]` : typeof a);
const note = (key) => {
	counts.set(key, (counts.get(key) ?? 0) + 1);
	total++;
	if (total - lastDump >= 20000) { lastDump = total; dump("calls"); }
};
// keep fs.realpath.native, exec[util.promisify.custom], etc.
const copyProps = (from, to) => { for (const k of Reflect.ownKeys(from)) { if (k === "name" || k === "length" || k === "prototype") continue; try { Object.defineProperty(to, k, Object.getOwnPropertyDescriptor(from, k)); } catch {} } };
const wrapAll = (obj, label, opts = {}) => {
	for (const name of Object.keys(obj)) {
		const f = obj[name];
		if (typeof f !== "function" || /^[A-Z]/.test(name) || name === "constants") continue;
		try {
			obj[name] = function (...a) {
				note(`${label}.${name}(${short(a[0])})`);
				if (!opts.log?.(name)) return f.apply(this, a);
				const stack = process.env.CLAUDE_TRACE_STACK ? "\n      " + (new Error().stack ?? "").split("\n").slice(2, 7).map((l) => l.trim().replace(/\/opt\/agentos\/pkgs\/claude2\/[^/]+\/lib\//, "")).join("\n      ") : "";
				try {
					const r = f.apply(this, a);
					if (r && typeof r.then === "function") r.then((v) => emit(`${label}.${name} ${a.slice(0, 2).map(short).join(" ")} -> ok${stack}`), (e) => emit(`${label}.${name} ${a.slice(0, 2).map(short).join(" ")} -> ${e?.code ?? e}${stack}`));
					else emit(`${label}.${name} ${a.slice(0, 2).map(short).join(" ")} -> ${typeof r === "number" ? "fd" + r : "ok"}${stack}`);
					return r;
				} catch (e) {
					emit(`${label}.${name} ${a.slice(0, 2).map(short).join(" ")} -> THROW ${e?.code ?? e}${stack}`);
					throw e;
				}
			};
			Object.defineProperty(obj[name], "name", { value: name });
			copyProps(f, obj[name]);
		} catch {}
	}
};
wrapAll(fs, "fs", { log: (n) => /^(mkdir|open|rm|unlink|rename|watch|watchFile|mkdtemp|readlink|realpath)/.test(n) });
wrapAll(require("fs/promises"), "fsp", { log: (n) => /^(mkdir|open|rm|unlink|rename|watch|mkdtemp)/.test(n) });
const cp = require("child_process");
for (const name of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]) {
	const f = cp[name];
	cp[name] = function (...a) {
		const t = Date.now();
		emit(`cp.${name} ${short(a[0])} ${Array.isArray(a[1]) ? JSON.stringify(a[1]).slice(0, 300) : ""}`);
		note(`cp.${name}(${short(a[0])})`);
		const r = f.apply(this, a);
		if (name.endsWith("Sync")) emit(`cp.${name} returned after ${Date.now() - t}ms`);
		else r?.on?.("exit", (code, sig) => emit(`cp.${name} ${short(a[0])} pid=${r.pid} exit code=${code} sig=${sig} after ${Date.now() - t}ms`));
		return r;
	};
	copyProps(f, cp[name]);
}
const wt = require("worker_threads");
if (wt.Worker) {
	const W = wt.Worker;
	wt.Worker = class extends W { constructor(file, o) { emit(`new Worker ${short(String(file))} eval=${o?.eval ?? false}`); super(file, o); } };
}
for (const name of ["setTimeout", "setImmediate", "setInterval", "queueMicrotask"]) {
	const f = globalThis[name];
	globalThis[name] = function (cb, ms, ...rest) { note(`${name}(${typeof ms === "number" ? ms : ""}) ${(cb?.name || "anon").slice(0, 30)}`); return f.call(this, cb, ms, ...rest); };
}
const nt = process.nextTick;
process.nextTick = function (cb, ...a) { note(`nextTick ${(cb?.name || "anon").slice(0, 30)}`); return nt.call(this, cb, ...a); };
const iv = setInterval(() => dump("timer"), 3000); iv.unref?.();
process.on("exit", (c) => dump(`exit ${c}`));
emit(`trace-entry start argv=${JSON.stringify(process.argv.slice(2))}`);
await import("./entry.mjs");
