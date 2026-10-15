#!/usr/bin/env node
// Entry point for the rebundled Claude Code inside agentOS 0.4.1 (installed as lib/entry.mjs,
// the package's `claude` bin). It patches the guest's builtin fs objects BEFORE cli.js and its
// chunks evaluate, then loads cli.js.
//
// procfs magic links: on Linux, /proc/self/fd/N is a magic link to the open file description,
// and path resolution *traverses* it, so /proc/self/fd/N/child names `child` inside the directory
// open on fd N, even if that directory was renamed. Claude Code ≥2.1.2xx uses this for
// TOCTOU-safe "openat"-style writes (pinWriteTarget / mkdir-p / temp-dir pinning), e.g.
// mkdir(`/proc/self/fd/${dirfd}/${name}`). agentOS 0.4.1's kernel resolves an exact
// /proc/self/fd/N (readlink/stat/readdir/open-for-read follow it) but rejects any path with
// components after N: resolve_proc_node() gives ENOENT, and the blanket is_proc_path() write guard
// gives EROFS for mkdir/write (crates/kernel/src/kernel.rs, resolve_proc_node / ~6562).
// This shim emulates the traversal: for a path /proc/self/fd/N/<tail> (tail non-empty), it
// replaces the prefix with readlink(/proc/self/fd/N), i.e. the fd's current path, which is what
// the kernel would traverse to. Exact /proc/self/fd/N paths are left untouched, so readlink of the
// link itself still works natively. The race protection is weaker than a real magic link (the
// fd -> path lookup and the operation are two steps), which is acceptable inside a VM.
// The real fix belongs in the agentOS kernel (see notes/claude.md).
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const fs = require("fs");
const fsp = require("fs/promises");
const readlinkSync = fs.readlinkSync.bind(fs);
const appendFileSync = fs.appendFileSync.bind(fs);
const DEBUG = process.env.AGENTOS_PROCFD_LOG; // file path: log each translated path (first 200)
const PROC_FD = /^\/proc\/self\/fd\/(\d+)\/(.+)$/;
let translated = 0;
const resolveProcFd = (p) => {
	let s = typeof p === "string" ? p : Buffer.isBuffer(p) ? p.toString() : p instanceof URL && p.protocol === "file:" ? decodeURIComponent(p.pathname) : null;
	if (s === null) return p;
	const m = PROC_FD.exec(s);
	if (!m) return p;
	let target;
	try { target = readlinkSync(`/proc/self/fd/${m[1]}`); } catch { return p; }
	if (target.endsWith(" (deleted)")) return p;
	translated++;
	const out = `${target.replace(/\/+$/, "")}/${m[2]}`;
	if (DEBUG && translated <= 200) { try { appendFileSync(DEBUG, `${s} -> ${out}\n`); } catch {} }
	return out;
};
// path-taking functions: index list of the path arguments
const PATH_ARGS = {
	access: [0], appendFile: [0], chmod: [0], chown: [0], copyFile: [0, 1], cp: [0, 1], exists: [0], lchmod: [0], lchown: [0], lutimes: [0], link: [0, 1],
	lstat: [0], mkdir: [0], mkdtemp: [0], open: [0], opendir: [0], readdir: [0], readFile: [0], readlink: [0], realpath: [0], rename: [0, 1], rm: [0], rmdir: [0],
	stat: [0], statfs: [0], symlink: [1], truncate: [0], unlink: [0], utimes: [0], writeFile: [0], watch: [0], watchFile: [0], unwatchFile: [0],
	createReadStream: [0], createWriteStream: [0],
};
const wrap = (obj, name, idxs) => {
	const f = obj[name];
	if (typeof f !== "function" || f.__agentosProcFd) return;
	const w = function (...a) {
		for (const i of idxs) if (i < a.length) a[i] = resolveProcFd(a[i]);
		return f.apply(this, a);
	};
	for (const k of Reflect.ownKeys(f)) { if (k === "name" || k === "length" || k === "prototype") continue; try { Object.defineProperty(w, k, Object.getOwnPropertyDescriptor(f, k)); } catch {} }
	Object.defineProperty(w, "name", { value: f.name });
	w.__agentosProcFd = true;
	obj[name] = w;
};
for (const [name, idxs] of Object.entries(PATH_ARGS)) {
	wrap(fs, name, idxs);
	wrap(fs, `${name}Sync`, idxs);
	wrap(fsp, name, idxs);
}
if (fs.realpath?.native) wrap(fs.realpath, "native", [0]);
if (fs.realpathSync?.native) wrap(fs.realpathSync, "native", [0]);
globalThis.__agentosProcFdStats = () => ({ translated });

// Pipe-backed TTY (opt-in: AGENTOS_PIPE_TTY=<size file>). On an agentOS 0.4.1 PTY, everything a
// WASM process in that PTY's session writes (sh, coreutils, git: the Bash tool, the shell
// snapshot's env dump, `ps`, even writes redirected to a file) is ALSO copied onto the PTY, and
// held there until the next input write (build/claude/tui/pty-leak-probe.ts). For the TUI that
// means raw command output, including environment dumps with credentials, splashed over the
// screen on the next keystroke. Without a PTY nothing leaks. So tui.ts can run claude on plain
// stdio pipes and have this shim present them as a terminal: isTTY, raw mode (a no-op: pipes
// have no line discipline, so bytes already arrive raw), and a window size read from the size
// file, which the host rewrites on resize (polled; a change emits stdout 'resize').
if (process.env.AGENTOS_PIPE_TTY && !process.stdout.isTTY) {
	const sizeFile = process.env.AGENTOS_PIPE_TTY;
	const readSize = () => {
		try { const [c, r] = fs.readFileSync(sizeFile, "utf8").trim().split(/[x ]/).map(Number); if (c > 0 && r > 0) return [c, r]; } catch {}
		return null;
	};
	let [cols, rows] = readSize() ?? [80, 24];
	const depth = /truecolor|24bit/i.test(process.env.COLORTERM ?? "") ? 24 : /256/.test(process.env.TERM ?? "") ? 8 : 4;
	for (const s of [process.stdout, process.stderr]) {
		Object.defineProperty(s, "isTTY", { configurable: true, get: () => true });
		Object.defineProperty(s, "columns", { configurable: true, get: () => cols });
		Object.defineProperty(s, "rows", { configurable: true, get: () => rows });
		s.getColorDepth = () => depth;
		s.hasColors = (n = 16) => n <= 2 ** depth;
		s.getWindowSize = () => [cols, rows];
	}
	const sin = process.stdin;
	Object.defineProperty(sin, "isTTY", { configurable: true, get: () => true });
	sin.isRaw = false;
	sin.setRawMode = function (on) { this.isRaw = !!on; return this; };
	setInterval(() => {
		const s = readSize();
		if (s && (s[0] !== cols || s[1] !== rows)) { [cols, rows] = s; process.stdout.emit("resize"); }
	}, 200).unref();
}

// TTY resize: on an agentOS 0.4.1 PTY (terminal.open / spawn with pty), a resize delivers SIGWINCH
// and updates process.stdout.columns/rows, but the tty 'resize' event that Node emits on SIGWINCH
// never fires (verified with build/claude/tui/pty-probe.ts). Ink re-lays out on 'resize', so
// without this the interactive TUI keeps its first-frame size. Emit it ourselves, once per size
// change, and only if nothing else emitted it for that size already.
if (process.stdout.isTTY) {
	const size = () => `${process.stdout.columns}x${process.stdout.rows}`;
	let last = size();
	process.stdout.on("resize", () => { last = size(); });
	process.on("SIGWINCH", () => setImmediate(() => { if (size() !== last) { last = size(); process.stdout.emit("resize"); } }));
}

// TTY stdin: agentOS 0.4.1's guest process.stdin is a minimal object, not a stream.Readable. It
// has on/off/once/emit/pause/resume/read/setEncoding/setRawMode and delivers input only as
// flowing 'data' events. It has no 'readable' event, addListener, ref/unref, listeners,
// readableLength or unshift (build/claude/tui/tty-api-probe.ts). Claude Code's Ink reads keys
// with stdin.ref() + addListener("readable") + a read() loop, so the first raw-mode mount threw
// "u.ref is not a function"; React's root error handler is a no-op in this build, so the whole
// UI silently unmounted. This adapter adds the missing members and emulates paused-mode
// 'readable'/read() on top of 'data'. It is only installed when those members are missing.
if (process.stdin.isTTY && typeof process.stdin.addListener !== "function") {
	const sin = process.stdin;
	const on = sin.on.bind(sin), off = (sin.off ?? sin.removeListener).bind(sin), nativeRead = sin.read.bind(sin);
	const readers = [];
	const queue = [];
	let attached = false, scheduled = false;
	const notify = () => {
		if (scheduled || !queue.length) return;
		scheduled = true;
		setImmediate(() => { scheduled = false; if (queue.length) for (const f of [...readers]) f.call(sin); });
	};
	const onData = (chunk) => { queue.push(chunk); notify(); };
	const join = (parts) => parts.every((p) => typeof p === "string") ? parts.join("") : Buffer.concat(parts.map((p) => typeof p === "string" ? Buffer.from(p, sin.encoding ?? "utf8") : p));
	sin.on = function (ev, fn) {
		if (ev !== "readable") { on(ev, fn); return this; }
		readers.push(fn);
		if (!attached) { attached = true; on("data", onData); }
		notify();
		return this;
	};
	sin.addListener = sin.on;
	sin.prependListener = sin.on;
	sin.off = sin.removeListener = function (ev, fn) {
		if (ev !== "readable") { off(ev, fn); return this; }
		const i = readers.indexOf(fn);
		if (i !== -1) readers.splice(i, 1);
		if (!readers.length && attached) { attached = false; off("data", onData); sin.pause(); }
		return this;
	};
	sin.read = function (n) {
		if (!queue.length) return nativeRead(n);
		const all = join(queue.splice(0));
		if (n && n < all.length) { queue.push(all.slice(n)); return all.slice(0, n); }
		return all;
	};
	sin.unshift = function (chunk) { if (chunk != null && chunk.length) queue.unshift(chunk); return this; };
	sin.listeners = (ev) => (ev === "readable" ? [...readers] : []);
	sin.listenerCount = (ev) => (ev === "readable" ? readers.length : 0);
	sin.ref = function () { return this; };
	sin.unref = function () { return this; };
	Object.defineProperty(sin, "readableLength", { configurable: true, get: () => queue.reduce((a, c) => a + c.length, 0) });
}
await import("./cli.js");
