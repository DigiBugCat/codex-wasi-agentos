#!/bin/zsh
# Assemble <W>/build/claude/<name>/pkg from the rebundled dir and pack it into
# <W>/build/claude/<name>/package.aospkg   (name defaults to cc-2.1.300; rebundled dir = $RB, else <W>/build/claude/<name>/rb)
#   bin/claude -> ../lib/entry.mjs (agentos-entry.mjs: procfs + tty shims, then cli.js)
HERE=${0:A:h}; S=$1; W=$2; NAME=${3:-cc-2.1.300}; R=${RB:-$W/build/claude/$NAME/rb}; T="$W/build/claude/$NAME/pkg"
rm -rf "$T" && mkdir -p "$T/bin" && cp -R $R "$T/lib" && rm -f "$T"/lib/*.node || exit 1
printf '#!/usr/bin/env node\n' | cat - "$T/lib/cli.js" > "$T/lib/cli.tmp" && mv "$T/lib/cli.tmp" "$T/lib/cli.js"
cp $HERE/agentos-entry.mjs "$T/lib/entry.mjs"
cp $HERE/trace-entry.mjs "$T/lib/trace-entry.mjs"   # diagnostic entry (not on PATH)
chmod 755 "$T/lib/cli.js" "$T/lib/entry.mjs" "$T/lib/trace-entry.mjs"
ln -s ../lib/entry.mjs "$T/bin/claude"
node -e '
const fs=require("fs");const [t,src]=process.argv.slice(1);
fs.writeFileSync(t+"/package.json",JSON.stringify({name:"claude-code-bunfs",version:"2.1.300",bin:{claude:"lib/entry.mjs"}},null,2));
fs.writeFileSync(t+"/agentos-package.json",JSON.stringify({name:"claude2",version:"2.1.300",provides:{env:JSON.parse(fs.readFileSync(src,"utf8")).agent.env}},null,2));' "$T" "$W/vendor/claude-code/agentos-package.json"
cd "$W" && node scripts/claude-pack-tree.mjs "$T" build/claude/$NAME/package.aospkg
