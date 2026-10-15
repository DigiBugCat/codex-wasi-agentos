// Post-process rebundled output for agentOS 0.4.1 Node-compat gaps found by trial.
// usage: node agentos-fixups.mjs <dir>
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { builtinModules } from "node:module";
const BUILTIN = new Set(builtinModules);
const dir = process.argv[2]; let n = 0, k = 0;
// named imports from builtins that agentOS's ESM builtin wrappers don't export
const FALLBACK = {
	buffer: { constants: "{MAX_LENGTH:4294967296,MAX_STRING_LENGTH:536870888}" },
	// crypto.randomInt is missing entirely; the TUI renderer's image-id allocator calls it at
	// construction ("eC is not a function"). Uniform over [min, max) from 53 random bits.
	crypto: { randomInt: '((a,b,cb)=>{if(b===undefined||typeof b==="function"){cb=b;b=a;a=0}const u=globalThis.crypto.getRandomValues(new Uint32Array(2)),r=a+Math.floor(((u[0]*2097152)+(u[1]>>>11))/9007199254740992*(b-a));if(typeof cb==="function"){queueMicrotask(()=>cb(null,r));return}return r})' },
	util: { getSystemErrorName: '((n)=>{for(const[k,v]of Object.entries(__bunRequire("os").constants?.errno??{}))if(-v===n)return k;return`Unknown system error ${n}`})' },
};
// Present in the namespace but undefined (found by build/claude/tui/builtin-undef-check.ts; the
// original gap check used `in`, which these pass). util.isDeepStrictEqual is hit by the TUI's
// plugin-theme store ("OCt is not a function") and by Bun.deepEquals in bun-shim.js.
FALLBACK.util.isDeepStrictEqual = '((a,b)=>{try{__bunRequire("assert").deepStrictEqual(a,b);return true}catch{return false}})';
FALLBACK.crypto.timingSafeEqual = '((a,b)=>{if(a.byteLength!==b.byteLength)throw new RangeError("Input buffers must have the same byte length");const x=new Uint8Array(a.buffer,a.byteOffset,a.byteLength),y=new Uint8Array(b.buffer,b.byteOffset,b.byteLength);let d=0;for(let i=0;i<x.length;i++)d|=x[i]^y[i];return d===0})';
FALLBACK.url = { domainToASCII: '((d)=>{try{return new URL("http://"+d).hostname}catch{return""}})' };
for (const f of readdirSync(dir)) {
	if (!f.endsWith(".js")) continue;
	const p = `${dir}/${f}`; let s = readFileSync(p, "utf8"); const s0 = s;
	s = s.replace(/import \{ ([^}]+) \} from "(?:node:)?([a-z_/]+)";/g, (all, specs, mod) => {
		if (!BUILTIN.has(mod)) return all;
		const parts = specs.split(",").map((x) => x.trim()).filter(Boolean);
		const ns = `__ns_${mod.replace(/[^a-z_]/g, "_")}_${k++}`;
		return `import * as ${ns} from "${mod}";` + parts.map((x) => { const [imp, loc = imp] = x.split(" as ").map((y) => y.trim()); const fb = FALLBACK[mod]?.[imp]; return `const ${loc} = ${ns}.${imp} ?? ${ns}.default?.${imp}${fb ? ` ?? ${fb}` : ""};`; }).join("");
	});
	// agentOS 0.4.1 guest ESM has no import.meta.dirname/filename
	if (s.includes("import.meta.dirname") || s.includes("import.meta.filename")) {
		s = s.replaceAll("import.meta.dirname", "__bunDirname").replaceAll("import.meta.filename", "__bunFilename");
		s = 'import{fileURLToPath as __bunFU}from"node:url";import{dirname as __bunDN}from"node:path";const __bunFilename=__bunFU(import.meta.url);const __bunDirname=__bunDN(__bunFilename);' + s;
	}
	// agentOS implements process.exit() by throwing ProcessExitError; Claude Code catches that and
	// SIGKILLs itself (exit 137). Let the exit propagate instead.
	s = s.replace(/try\s*\{\s*process\.exit\(([\w$]+)\);?\s*\}\s*catch\s*\(?[\w$]*\)?\s*\{\s*process\.kill\(process\.pid,\s*"SIGKILL"\);?\s*\}/g, "process.exit($1);");
	// (/proc/self/fd/N/<child> traversal is handled at runtime by agentos-entry.mjs, not by rewriting
	// the bundle: a blind rewrite also changed readlink(`/proc/self/fd/${fd}`) itself, which broke
	// pinWriteTarget's fd->path check.)
	if (s !== s0) { writeFileSync(p, s); n++; }
}
console.log("fixups applied to", n, "files");
