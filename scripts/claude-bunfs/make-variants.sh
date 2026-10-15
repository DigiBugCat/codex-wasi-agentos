#!/bin/zsh
# Build diagnostic variants of the 2.1.300 package from the main tree (build/claude/cc-2.1.300/pkg,
# produced by pipeline.sh) for the Bash-tool matrix (claude-bash-matrix.sh):
#   noshim        bin -> lib/cli.js directly: no /proc/self/fd/N/<child> translation (original EROFS)
#   rewrite       blind template rewrite `/proc/self/fd/${x}` -> `${__bunPfd(x)}` in every chunk,
#                 __bunPfd (fd -> readlink path) defined in a separate entry file
#   rewrite-self  the first workaround exactly: __bunPfd defined INSIDE cli.js (as bun-shim did),
#                 then the same rewrite, which also rewrites __bunPfd's own `/proc/self/fd/${fd}`
#                 -> unbounded try/catch self-recursion (the "CPU-budget spin")
# usage: scripts/claude-bunfs/make-variants.sh <W>
W=$1; SRC="$W/build/claude/cc-2.1.300/pkg"
REWRITE='const fs=require("fs");const d=process.argv[1];let n=0;
for(const f of fs.readdirSync(d)){if(!f.endsWith(".js"))continue;const p=d+"/"+f;const s=fs.readFileSync(p,"utf8");
const t=s.replace(/\/proc\/self\/fd\/\$\{([\w$.]+)\}/g,(_,x)=>{n++;return "${globalThis.__bunPfd("+x+")}"});if(t!==s)fs.writeFileSync(p,t)}
console.log("  rewrote",n,"template sites")'
OLD_SHIM='{ const { readlinkSync } = await import("node:fs"); globalThis.__bunPfd = (fd) => { try { return readlinkSync(`/proc/self/fd/${fd}`); } catch { return `/proc/self/fd/${fd}`; } }; }'
for v in noshim rewrite rewrite-self; do
	T="$W/build/claude/cc-2.1.300-$v/pkg"; rm -rf "$W/build/claude/cc-2.1.300-$v"; mkdir -p "$T"; cp -R "$SRC/" "$T/"
	rm -f "$T/bin/claude"
	case $v in
	noshim) ln -s ../lib/cli.js "$T/bin/claude"; BIN=lib/cli.js ;;
	rewrite)
		node -e "$REWRITE" "$T/lib"
		printf '#!/usr/bin/env node\nimport { readlinkSync } from "node:fs";\nglobalThis.__bunPfd = (fd) => { try { return readlinkSync(`/proc/self/fd/${fd}`); } catch { return `/proc/self/fd/${fd}`; } };\nawait import("./cli.js");\n' > "$T/lib/entry.mjs"
		ln -s ../lib/entry.mjs "$T/bin/claude"; BIN=lib/entry.mjs ;;
	rewrite-self)
		node -e 'const fs=require("fs");const p=process.argv[1];const s=fs.readFileSync(p,"utf8");const i=s.indexOf("\n")+1;fs.writeFileSync(p,s.slice(0,i)+process.argv[2]+"\n"+s.slice(i))' "$T/lib/cli.js" "$OLD_SHIM"
		node -e "$REWRITE" "$T/lib"
		ln -s ../lib/cli.js "$T/bin/claude"; BIN=lib/cli.js ;;
	esac
	chmod 755 "$T/lib/cli.js" "$T/lib/entry.mjs"
	node -e 'require("fs").writeFileSync(process.argv[1],JSON.stringify({name:"claude-code-bunfs",version:"2.1.300",bin:{claude:process.argv[2]}},null,2))' "$T/package.json" $BIN
	echo "$v:"; (cd "$W" && node scripts/claude-pack-tree.mjs "$T" "build/claude/cc-2.1.300-$v/package.aospkg")
done
