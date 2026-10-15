#!/usr/bin/env python3
"""Widen `#[cfg(unix)]` gates to also cover WASI.

usage: widen.py FILE NAME [NAME...]   widen the cfg(unix) attribute directly above
                                      the item whose line contains NAME (fn/mod/use/const...)
       widen.py FILE @LINE [@LINE...] widen the cfg(unix) attribute nearest above LINE
"""
import re, sys

UNIX_PATTERNS = [
    ('#[cfg(unix)]', '#[cfg(any(unix, target_os = "wasi"))]'),
    ('#[cfg(target_family = "unix")]', '#[cfg(any(target_family = "unix", target_os = "wasi"))]'),
    ('#[cfg(not(windows))]', None),  # already covers wasi
]

def widen_at(lines, idx):
    for j in range(idx - 1, max(-1, idx - 8), -1):
        s = lines[j].strip()
        for old, new in UNIX_PATTERNS:
            if s == old:
                if new is None:
                    return True
                lines[j] = lines[j].replace(old, new)
                return True
        if not (s.startswith('#[') or s.startswith('///') or s.startswith('//') or s == ''):
            break
    return False

path = sys.argv[1]
lines = open(path).read().split('\n')
ok = True
for target in sys.argv[2:]:
    if target.startswith('@'):
        idx = int(target[1:]) - 1
        if not widen_at(lines, idx):
            print(f'{path}:{idx+1}: no cfg(unix) above', file=sys.stderr); ok = False
        continue
    rx = re.compile(r'\b(fn|mod|struct|enum|const|static|type|use|impl|trait)\b[^\n]*\b' + re.escape(target) + r'\b')
    hits = [i for i, l in enumerate(lines) if rx.search(l)]
    done = False
    for i in hits:
        if widen_at(lines, i):
            done = True
    if not done:
        print(f'{path}: {target}: no cfg(unix)-gated item found', file=sys.stderr); ok = False
open(path, 'w').write('\n'.join(lines))
sys.exit(0 if ok else 1)
