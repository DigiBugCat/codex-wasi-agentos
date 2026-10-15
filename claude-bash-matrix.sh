#!/bin/zsh
# Run claude-bash-turn.ts for several package variants in parallel (one VM each, max 4), then
# print variant -> PASS/FAIL -> evidence.   usage: ./claude-bash-matrix.sh [variant ...]
# variants: main (build/claude/cc-2.1.300) and the ones from scripts/claude-bunfs/make-variants.sh
cd ${0:A:h}
if (( $# )); then VARIANTS=($@); else VARIANTS=(main noshim rewrite rewrite-self); fi
for v in $VARIANTS; do
	pkg=build/claude/cc-2.1.300$([ $v = main ] || echo "-$v")/package.aospkg
	( TURN_DEBUG=1 timeout 200 npx tsx claude-bash-turn.ts $pkg > build/claude/matrix-$v.log 2>&1 ) &
done
wait
printf '%-14s %-5s %s\n' variant result evidence
for v in $VARIANTS; do
	f=build/claude/matrix-$v.log
	res=$(grep -E '^(PASS|FAIL)$' $f | tail -1)
	ev=$(grep -E 'tool_result|WATCHDOG|budget|host read' $f | grep -v 'debug log' | head -2 | sed -E 's/\x1b\[[0-9;]*m//g' | cut -c1-150 | paste -sd ' ' -)
	t=$(grep -oE 'claude -p finished: outcome=[a-z_]+ in [0-9]+ms' $f)
	printf '%-14s %-5s %s | %s\n' $v "${res:-?}" "$t" "$ev"
done
