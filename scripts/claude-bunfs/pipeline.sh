#!/bin/zsh
# Bun-extracted Claude Code -> esbuild rebundle -> agentOS fixups -> v2 .aospkg
# usage: scripts/claude-bunfs/pipeline.sh <scratchDir> <W> [name]
#   <scratchDir>/extract-cc-2.1.300   output of bunfs_list.py <claude ELF> <dir>   (read only)
#   <scratchDir>/node-cc-2.1.300/node_modules   npm deps: ws yaml smol-toml semver string-width slice-ansi wrap-ansi strip-ansi
#   name   output name under <W>/build/claude (default cc-2.1.300). The rebundled intermediate goes to
#          <W>/build/claude/<name>/rb (the scratch dir is only read).
# writes <W>/build/claude/<name>/package.aospkg
HERE=${0:A:h}; S=$1; W=$2; NAME=${3:-cc-2.1.300}
R=$W/build/claude/$NAME/rb
mkdir -p ${R:h}
node $HERE/rebundle.mjs "$W/node_modules/esbuild/lib/main.js" $S/extract-cc-2.1.300 $R $S/node-cc-2.1.300/node_modules | tail -1 || exit 1
cp -R $S/node-cc-2.1.300/node_modules $R/node_modules
node $HERE/agentos-fixups.mjs $R
RB=$R $HERE/repack-cc.sh $S "$W" $NAME
