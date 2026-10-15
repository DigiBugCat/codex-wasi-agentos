#!/usr/bin/env -S python3 -I
"""Smoke test for tui.ts: drive the interactive Claude Code TUI (inside an agentOS VM, mock model)
under a pseudo-terminal, like a person would, and check the screen.

    python3 -I tui-smoke.py            # PASS/FAIL, ~1 min
    python3 -I tui-smoke.py --keep     # also keep build/claude/tui/smoke-*.txt (screens + raw log)
    python3 -I tui-smoke.py --transport pty   # the VM-PTY transport (fails the leak check on 0.4.1)

Checks (TUI_MOCK=1, no credentials, VM network = loopback only):
  1. the TUI renders: the prompt input box appears;
  2. a typed prompt round-trips to the in-VM mock Messages API;
  3. the mock's Bash tool call executes inside the VM (uname says "Linux agentos ... wasm32", the
     host is not Linux) and its result shows on screen; tui.ts confirms the file it wrote;
  4. a resize reaches the TUI (it re-lays out to the new width);
  5. Ctrl-C reaches claude ("press Ctrl-C again"), the host keeps running; no in-VM child
     output (env dumps, shell errors) leaks onto the terminal;
  6. /exit ends claude, tui.ts disposes the VM and exits 0, and the host tty is back in cooked
     mode with the cursor visible;
  7. Ctrl-] quits the bridge while claude runs (exit 130, VM disposed, terminal restored).
A small VT100 emulator below turns the raw byte stream into a screen, so failures show what was
actually on screen.
"""
import os, sys, pty, select, signal, struct, fcntl, termios, time, re, unicodedata, tty

HERE = os.path.dirname(os.path.abspath(__file__))
COLS, ROWS = 110, 34
KEEP = "--keep" in sys.argv
TRANSPORT = sys.argv[sys.argv.index("--transport") + 1] if "--transport" in sys.argv else "pipe"
OUTDIR = os.path.join(HERE, "build", "claude", "tui")


# --------------------------------------------------------------------------- tiny VT emulator
class Screen:
    def __init__(self, cols, rows):
        self.cols, self.rows = cols, rows
        self.main = self._blank()
        self.alt = self._blank()
        self.buf = self.main
        self.x = self.y = 0
        self.saved = (0, 0)
        self.top, self.bot = 0, rows - 1
        self.wrap_pending = False
        self.cursor_visible = True
        self.replies = []
        self._state = None
        self._seq = ""

    def _blank(self):
        return [[" "] * self.cols for _ in range(self.rows)]

    def resize(self, cols, rows):
        def fit(b):
            b = [r[:cols] + [" "] * (cols - len(r)) for r in b]
            return (b + [[" "] * cols for _ in range(rows)])[:rows]
        self.main, self.alt = fit(self.main), fit(self.alt)
        self.buf = self.alt if self.buf is not self.main else self.main
        self.cols, self.rows = cols, rows
        self.top, self.bot = 0, rows - 1
        self.x, self.y = min(self.x, cols - 1), min(self.y, rows - 1)

    def text(self):
        return "\n".join("".join(c for c in r if c is not None).rstrip() for r in self.buf).rstrip("\n")

    def _scroll_up(self, n=1):
        for _ in range(n):
            del self.buf[self.top]
            self.buf.insert(self.bot, [" "] * self.cols)

    def _scroll_down(self, n=1):
        for _ in range(n):
            del self.buf[self.bot]
            self.buf.insert(self.top, [" "] * self.cols)

    def _lf(self):
        if self.y == self.bot:
            self._scroll_up()
        elif self.y < self.rows - 1:
            self.y += 1

    def _put(self, ch):
        w = 0 if unicodedata.combining(ch) else (2 if unicodedata.east_asian_width(ch) in "WF" else 1)
        if w == 0:
            return
        if self.wrap_pending:
            self.x = 0
            self._lf()
            self.wrap_pending = False
        if self.x + w > self.cols:
            self.x = 0
            self._lf()
        row = self.buf[self.y]
        row[self.x] = ch
        if w == 2 and self.x + 1 < self.cols:
            row[self.x + 1] = None
        self.x += w
        if self.x >= self.cols:
            self.x = self.cols - 1
            self.wrap_pending = True

    def feed(self, data: str):
        for ch in data:
            st = self._state
            if st is None:
                o = ord(ch)
                if ch == "\x1b":
                    self._state, self._seq = "esc", ""
                elif ch == "\r":
                    self.x, self.wrap_pending = 0, False
                elif ch in "\n\x0b\x0c":
                    self._lf(); self.wrap_pending = False
                elif ch == "\b":
                    self.x = max(0, self.x - 1); self.wrap_pending = False
                elif ch == "\t":
                    self.x = min(self.cols - 1, (self.x // 8 + 1) * 8)
                elif o < 32 or o == 127:
                    pass
                else:
                    self._put(ch)
            elif st == "esc":
                if ch == "[":
                    self._state, self._seq = "csi", ""
                elif ch in "]P_^X":
                    self._state = "str"
                elif ch in "()*+#":
                    self._state = "skip1"
                elif ch == "7":
                    self.saved = (self.x, self.y); self._state = None
                elif ch == "8":
                    self.x, self.y = self.saved; self._state = None
                elif ch == "M":
                    if self.y == self.top: self._scroll_down()
                    else: self.y = max(0, self.y - 1)
                    self._state = None
                elif ch == "D":
                    self._lf(); self._state = None
                elif ch == "E":
                    self.x = 0; self._lf(); self._state = None
                else:
                    self._state = None
            elif st == "skip1":
                self._state = None
            elif st == "str":
                if ch == "\x07":
                    self._state = None
                elif ch == "\x1b":
                    self._state = "str_esc"
            elif st == "str_esc":
                self._state = None if ch == "\\" else "str"
            elif st == "csi":
                if "\x40" <= ch <= "\x7e":
                    self._csi(self._seq, ch); self._state = None
                else:
                    self._seq += ch

    def _csi(self, p, f):
        priv = p[:1] if p[:1] in "?<>=" else ""
        body = p[len(priv):]
        args = [int(a) if a.isdigit() else 0 for a in body.split(";")] if body else []
        a0 = args[0] if args else 0
        n = a0 or 1
        self.wrap_pending = False if f not in "m" else self.wrap_pending
        if priv == "?" and f in "hl":
            for a in args:
                if a in (1049, 1047, 47):
                    if f == "h" and self.buf is self.main:
                        self.saved_main_cursor = (self.x, self.y)
                        self.alt = self._blank(); self.buf = self.alt
                    elif f == "l" and self.buf is not self.main:
                        self.buf = self.main
                        self.x, self.y = getattr(self, "saved_main_cursor", (0, 0))
                elif a == 25:
                    self.cursor_visible = f == "h"
            return
        if priv:
            if priv == "?" and f == "u":
                pass  # kitty keyboard query: no reply (not supported)
            return
        if f == "A": self.y = max(0, self.y - n)
        elif f == "B": self.y = min(self.rows - 1, self.y + n)
        elif f == "C": self.x = min(self.cols - 1, self.x + n)
        elif f == "D": self.x = max(0, self.x - n)
        elif f == "E": self.x = 0; self.y = min(self.rows - 1, self.y + n)
        elif f == "F": self.x = 0; self.y = max(0, self.y - n)
        elif f == "G": self.x = min(self.cols - 1, n - 1)
        elif f == "d": self.y = min(self.rows - 1, n - 1)
        elif f in "Hf":
            r = (args[0] if len(args) > 0 and args[0] else 1) - 1
            c = (args[1] if len(args) > 1 and args[1] else 1) - 1
            self.y, self.x = min(self.rows - 1, r), min(self.cols - 1, c)
        elif f == "J":
            if a0 == 0:
                self.buf[self.y][self.x:] = [" "] * (self.cols - self.x)
                for r in range(self.y + 1, self.rows): self.buf[r] = [" "] * self.cols
            elif a0 == 1:
                for r in range(0, self.y): self.buf[r] = [" "] * self.cols
                self.buf[self.y][: self.x + 1] = [" "] * (self.x + 1)
            else:
                for r in range(self.rows): self.buf[r] = [" "] * self.cols
        elif f == "K":
            row = self.buf[self.y]
            if a0 == 0: row[self.x:] = [" "] * (self.cols - self.x)
            elif a0 == 1: row[: self.x + 1] = [" "] * (self.x + 1)
            else: self.buf[self.y] = [" "] * self.cols
        elif f == "X":
            row = self.buf[self.y]
            for i in range(self.x, min(self.cols, self.x + n)): row[i] = " "
        elif f == "P":
            row = self.buf[self.y]
            del row[self.x: self.x + n]; row.extend([" "] * (self.cols - len(row)))
        elif f == "@":
            row = self.buf[self.y]
            for _ in range(n): row.insert(self.x, " ")
            del row[self.cols:]
        elif f == "L":
            for _ in range(n):
                del self.buf[self.bot]; self.buf.insert(self.y, [" "] * self.cols)
        elif f == "M":
            for _ in range(n):
                del self.buf[self.y]; self.buf.insert(self.bot, [" "] * self.cols)
        elif f == "S": self._scroll_up(n)
        elif f == "T": self._scroll_down(n)
        elif f == "r":
            self.top = (args[0] - 1) if len(args) > 0 and args[0] else 0
            self.bot = (args[1] - 1) if len(args) > 1 and args[1] else self.rows - 1
            self.x = self.y = 0
        elif f == "s": self.saved = (self.x, self.y)
        elif f == "u": self.x, self.y = self.saved
        elif f == "n" and a0 == 6: self.replies.append(f"\x1b[{self.y + 1};{self.x + 1}R")
        elif f == "c" and not body: self.replies.append("\x1b[?62;22c")


# --------------------------------------------------------------------------- driver
class Session:
    def __init__(self, argv, env):
        self.pid, self.fd = pty.fork()
        if self.pid == 0:
            os.chdir(HERE)
            os.execvpe(argv[0], argv, env)
        self.set_size(COLS, ROWS)
        self.screen = Screen(COLS, ROWS)
        self.raw = bytearray()
        self.exit_status = None
        self._dec = __import__("codecs").getincrementaldecoder("utf-8")("replace")

    def set_size(self, cols, rows):
        fcntl.ioctl(self.fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))

    def resize(self, cols, rows):
        self.set_size(cols, rows)
        self.screen.resize(cols, rows)
        os.kill(self.pid, signal.SIGWINCH)

    def pump(self, secs):
        end = time.time() + secs
        while True:
            left = end - time.time()
            if left <= 0:
                return
            r, _, _ = select.select([self.fd], [], [], min(left, 0.1))
            if r:
                try:
                    d = os.read(self.fd, 65536)
                except OSError:
                    d = b""
                if not d:
                    self._reap(block=True)
                    return
                self.raw += d
                self.screen.feed(self._dec.decode(d))
                for rep in self.screen.replies:
                    os.write(self.fd, rep.encode())
                self.screen.replies.clear()
            elif self._reap():
                return

    def _reap(self, block=False):
        if self.exit_status is not None:
            return True
        pid, st = os.waitpid(self.pid, 0 if block else os.WNOHANG)
        if pid:
            self.exit_status = os.waitstatus_to_exitcode(st)
            return True
        return False

    def wait_for(self, pred, timeout, step=0.2):
        end = time.time() + timeout
        while time.time() < end:
            self.pump(step)
            if pred(self.screen.text()) or self.exit_status is not None:
                return pred(self.screen.text())
        return False

    def type(self, s, delay=0.03):
        for ch in s:
            os.write(self.fd, ch.encode())
            self.pump(delay)

    def tty_modes(self):
        attrs = termios.tcgetattr(self.fd)
        return {"icanon": bool(attrs[3] & termios.ICANON), "echo": bool(attrs[3] & termios.ECHO)}

    def kill(self):
        if self.exit_status is None:
            try:
                os.kill(self.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            self.pump(5)
            if self.exit_status is None:
                os.kill(self.pid, signal.SIGKILL)
                self._reap(block=True)


def strip_ansi(b: bytes) -> str:
    s = b.decode("utf-8", "replace")
    s = re.sub(r"\x1b\][^\x07\x1b]*(\x07|\x1b\\)", "", s)
    s = re.sub(r"\x1b\[[0-9;?<>=]*[ -/]*[@-~]", "", s)
    return re.sub(r"\x1b[()*+#][0-9A-Za-z]|\x1b[78=>DEMc]", "", s)


def main():
    env = {k: v for k, v in os.environ.items() if not k.startswith(("ANTHROPIC_", "CLAUDE_CODE_OAUTH"))}
    env.update(TUI_MOCK="1", TERM="xterm-256color", TUI_MAX_MINUTES="5", TUI_TRANSPORT=TRANSPORT)
    env.pop("NO_COLOR", None); env.pop("CI", None)
    if KEEP:
        os.makedirs(OUTDIR, exist_ok=True)
        env["TUI_LOG"] = os.path.join(OUTDIR, "smoke-pty.log")
        for f in (env["TUI_LOG"], env["TUI_LOG"] + ".mock"):
            if os.path.exists(f): os.remove(f)
    s = Session(["timeout", "240", "npx", "tsx", "tui.ts"], env)
    results, shots = [], {}

    def check(name, ok, detail=""):
        results.append((name, bool(ok), detail))
        print(f"  [{'ok' if ok else 'XX'}] {name}{(' - ' + detail) if detail else ''}", flush=True)

    t0 = time.time()
    try:
        # 1. TUI renders: wait for the prompt box ("│ >" / "> " input line) and the welcome header
        prompt_re = re.compile(r"^\s*[│|]?\s*[❯>]", re.M)
        ok = s.wait_for(lambda t: prompt_re.search(t) and "Claude Code" in t, 120)
        s.pump(2.0)
        shots["1-start"] = s.screen.text()
        check("TUI renders (welcome + input box)", ok, f"{time.time() - t0:.1f}s after launch")
        if not ok:
            return results, shots, s

        # 2+3. prompt -> mock -> Bash in the VM -> result on screen
        s.type("run uname in the vm")
        s.pump(0.5)
        shots["2-typed"] = s.screen.text()
        os.write(s.fd, b"\r")
        ok = s.wait_for(lambda t: "MOCK SAW TOOL RESULT" in t, 90)
        s.pump(1.5)
        txt = s.screen.text()
        shots["3-after-turn"] = txt
        check("prompt round-trips to the in-VM mock", ok)
        check("mock's Bash tool ran inside the VM (uname: Linux agentos ... wasm32)", "Linux agentos" in txt and "wasm32" in txt,
              next((l.strip() for l in txt.splitlines() if "Linux agentos" in l), "not on screen"))
        check("Bash tool call is shown in the transcript", re.search(r"\$ echo hello-from-vm|Ran 1 shell command|Bash\(", txt) is not None,
              next((l.strip() for l in txt.splitlines() if re.search(r"hello-from-vm|Ran 1 shell|Bash\(", l)), ""))

        # 4. resize: widen the terminal; the input box rules must re-lay out to the new width
        rule_len = lambda t: max((len(m) for m in re.findall(r"─{20,}", t)), default=0)
        before = rule_len(s.screen.text())
        s.resize(130, ROWS)
        s.wait_for(lambda t: rule_len(t) >= 130, 15)
        txt = s.screen.text()
        shots["4-resized-130"] = txt
        check("resize propagates (box re-laid out from %d to 130 cols)" % before, rule_len(txt) == 130, f"rule width {before} -> {rule_len(txt)}")

        # 5. Ctrl-C goes to claude (its "press again to exit" hint), not to the host bridge
        os.write(s.fd, b"\x03")
        ok = s.wait_for(lambda t: re.search(r"(?i)ctrl.?c again", t) is not None, 10)
        shots["5-ctrl-c"] = s.screen.text()
        check("Ctrl-C reaches claude and the host keeps running", ok and s.exit_status is None,
              next((l.strip() for l in s.screen.text().splitlines() if re.search(r"(?i)again", l)), "no hint") + f", host exit_status={s.exit_status}")
        s.pump(4.0)  # let the double-press window lapse

        # 6. /exit -> clean shutdown
        s.type("/exit")
        s.pump(0.6)
        os.write(s.fd, b"\r")
        s.wait_for(lambda t: False, 60)  # until the child exits (or 60 s)
        tail = strip_ansi(bytes(s.raw[-6000:]))
        shots["6-exit"] = s.screen.text()
        check("tui.ts exits 0 after /exit", s.exit_status == 0, f"exit={s.exit_status}")
        check("VM shut down by tui.ts", "shutting down the VM" in tail)
        m = re.search(r"mock check: (.*)", tail)
        check("tui.ts read the Bash tool's file back from the VM", m and "hello-from-vm" in m.group(1), m.group(1).strip() if m else "no mock check line")
        raw = bytes(s.raw).decode("utf-8", "replace")
        leaked = [k for k in ("ANTHROPIC_API_KEY=", "SHLVL=", "command not found") if k in raw]
        check("no in-VM child output leaked onto the terminal (env dumps, shell errors)", not leaked, f"found {leaked}" if leaked else "")
        modes = s.tty_modes()
        check("host tty restored (cooked mode, echo, cursor visible, main screen)", modes["icanon"] and modes["echo"] and s.screen.cursor_visible and s.screen.buf is s.screen.main, str(modes) + f" cursor_visible={s.screen.cursor_visible}")
    finally:
        s.kill()

    # 7. escape hatch: Ctrl-] quits the bridge while claude is still running (VM disposed, tty restored)
    q = Session(["timeout", "120", "npx", "tsx", "tui.ts"], env)
    try:
        ok = q.wait_for(lambda t: prompt_re.search(t) and "Claude Code" in t, 120)
        if ok:
            os.write(q.fd, b"\x1d")
            q.wait_for(lambda t: False, 30)
        modes = q.tty_modes() if q.exit_status is not None else {"icanon": False, "echo": False}
        tail = strip_ansi(bytes(q.raw[-3000:]))
        shots["7-ctrl-bracket"] = q.screen.text()
        check("Ctrl-] quits the host bridge (exit 130, VM shut down, tty restored)",
              ok and q.exit_status == 130 and "Ctrl-]: quit" in tail and modes["icanon"] and modes["echo"] and q.screen.cursor_visible and q.screen.buf is q.screen.main,
              f"exit={q.exit_status} {modes} cursor_visible={q.screen.cursor_visible} main_screen={q.screen.buf is q.screen.main}")
    finally:
        q.kill()
    return results, shots, s


if __name__ == "__main__":
    print(f"tui-smoke: driving `npx tsx tui.ts` (TUI_MOCK=1, TUI_TRANSPORT={TRANSPORT}) on a {COLS}x{ROWS} pty")
    results, shots, s = main()
    if KEEP:
        os.makedirs(OUTDIR, exist_ok=True)
        for k, v in shots.items():
            with open(os.path.join(OUTDIR, f"smoke-{k}.txt"), "w") as f:
                f.write(v + "\n")
        with open(os.path.join(OUTDIR, "smoke-stripped.txt"), "w") as f:
            f.write(strip_ansi(bytes(s.raw)))
    failed = [r for r in results if not r[1]]
    if failed or not results:
        for k, v in shots.items():
            print(f"\n----- screen: {k} -----\n{v}")
        if not shots:
            print("\n----- raw output (stripped) -----\n" + strip_ansi(bytes(s.raw))[-4000:])
    print(f"\n{'PASS' if results and not failed else 'FAIL'} ({len(results) - len(failed)}/{len(results)} checks)")
    sys.exit(0 if results and not failed else 1)
