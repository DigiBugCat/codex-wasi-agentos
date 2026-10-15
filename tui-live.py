"""Drive tui.ts against the REAL model once (subscription token from a file) and print the final screen.

    python3 -I tui-live.py [prompt]        # needs ~/.claude/agentos-demo-token (from `claude setup-token`)

Reuses tui-smoke.py's pty Session + VT Screen. Never prints the token.
"""
import importlib.util, os, sys, time

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("tui_smoke", os.path.join(HERE, "tui-smoke.py"))
smoke = importlib.util.module_from_spec(spec)
spec.loader.exec_module(smoke)

PROMPT = sys.argv[1] if len(sys.argv) > 1 else (
    "Write primes.js that prints the first 10 prime numbers on one line, run it with node, and tell me the output."
)
token_file = os.path.expanduser("~/.claude/agentos-demo-token")
env = {k: v for k, v in os.environ.items() if not k.startswith(("ANTHROPIC_", "CLAUDE_CODE_OAUTH"))}
env.update(CLAUDE_CODE_OAUTH_TOKEN_FILE=token_file, TERM="xterm-256color", TUI_MAX_MINUTES="8")

t0 = time.time()
s = smoke.Session(["npx", "tsx", "tui.ts"], env)
ok = s.wait_for(lambda t: "Claude Code v" in t and "❯" in t, 90)
print(f"[live] TUI rendered={ok} after {time.time() - t0:.1f}s")
if ok:
    s.type(PROMPT)
    s.pump(0.5)
    os.write(s.fd, b"\r")
    t1 = time.time()
    # Done when the answer mentions 29 (10th prime) and the spinner line has settled into a "for Ns" summary.
    done = s.wait_for(lambda t: "29" in t.split(PROMPT[:20])[-1] and (" for " in t and "·" in t), 240)
    s.pump(2)
    print(f"[live] turn finished={done} after {time.time() - t1:.1f}s")
    print("\n".join(line.rstrip() for line in s.screen.text().split("\n") if line.strip()))
    s.type("/exit")
    s.pump(0.3)
    os.write(s.fd, b"\r")
    s.wait_for(lambda t: False, 20)
print(f"[live] tui.ts exit={s.exit_status}")
s.kill()
