#!/usr/bin/env python3
"""Headless tomod baseline for the Core / Client / Addon refactor. See docs/addons-baseline.md.

  addons-bench.py setup                  new data dir: 5 repos, 25 linked worktrees, 12 panes with 1 MB scrollback
  addons-bench.py ops [trials]           reattach, worktree_open, worktree_refresh, ps round trips
  addons-bench.py idle <secs> <0|1>      daemon CPU and RSS over an idle window, without or with a subscriber
  addons-bench.py startup [trials]       cold start: socket, first subscribe, worktrees, summaries, pane restore

Env: TOMO_DATA_DIR (must start with /tmp/tomo-addons- or /tmp/tomo-startup-), TOMO_BIN, TOMO_DAEMON_BIN.
"""
import base64, json, os, socket, statistics, subprocess, sys, threading, time

D = os.environ["TOMO_DATA_DIR"]
assert D.startswith(("/tmp/tomo-addons-", "/tmp/tomo-startup-")), D
T = os.environ["TOMO_BIN"]
REPOS = D + "-repos"
SOCK = os.path.join(D, "tomod.sock")


class Rpc:
    def __init__(self):
        self.s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.s.connect(SOCK)
        self.buf = b""
        self.n = 0
        self.call("hello", {"protocol": 3, "client": "addons-bench"})

    def frames(self):
        while True:
            while b"\n" in self.buf:
                line, self.buf = self.buf.split(b"\n", 1)
                if line.strip():
                    yield json.loads(line)
            chunk = self.s.recv(1 << 20)
            if not chunk:
                return
            self.buf += chunk

    def call(self, method, params=None, until=None):
        self.n += 1
        rid = self.n
        msg = {"id": rid, "method": method} | ({"params": params} if params is not None else {})
        self.s.sendall((json.dumps(msg) + "\n").encode())
        got_result, got_extra, result = False, until is None, None
        for f in self.frames():
            if f.get("id") == rid:
                if "error" in f:
                    raise SystemExit(f"{method}: {f['error']}")
                got_result, result = True, f.get("result")
            elif until and until(f):
                got_extra = True
            if got_result and got_extra:
                return result
        raise SystemExit("socket closed")


def tomo(*args):
    return subprocess.run([T, *args], capture_output=True, text=True, check=True).stdout.strip()


def setup():
    subprocess.run([T, "daemon", "stop"], capture_output=True)
    time.sleep(0.5)
    subprocess.run(["rm", "-rf", D, REPOS], check=True)
    os.makedirs(D)
    tomo("daemon", "start")
    for r in range(1, 6):
        repo = f"{REPOS}/r{r}/repo"
        os.makedirs(repo)
        subprocess.run(["git", "init", "-q", repo], check=True)
        for f in range(40):
            with open(f"{repo}/file{f}.txt", "w") as fh:
                fh.write("line\n" * 200)
        subprocess.run(["git", "-C", repo, "add", "."], check=True)
        subprocess.run(["git", "-C", repo, "commit", "-q", "-m", "init"], check=True)
        tomo("repo", "add", repo)
        for w in range(1, 6):
            tomo("worktree", "create", "--repo", repo, "--branch", f"feat/w{w}", "--new")
    wts = json.loads(tomo("worktree", "list", "--json"))
    linked = [w["id"] for w in wts if not w["path"].endswith("/repo")]
    panes = [tomo("pane", "create", "--worktree", linked[i]) for i in range(12)]
    time.sleep(2)
    rpc = Rpc()
    for p in panes:
        rpc.call("pane_send", {"pane_id": p, "data_base64": base64.b64encode(b"seq 1 150000\r").decode()})
    time.sleep(5)
    print(json.dumps({"worktrees": len(wts), "panes": panes}))


def ms(fn):
    t = time.perf_counter()
    fn()
    return (time.perf_counter() - t) * 1000


def output_of(pane):
    return lambda f: f.get("event") == "pane_output" and f["data"]["pane_id"] == pane


def trial(live, with_tabs, pane_of):
    sub, att, reattach = [], [], []
    for i in range(10):
        pane = live[i % len(live)]["id"]
        c = Rpc()
        t0 = time.perf_counter()
        sub.append(ms(lambda: c.call("subscribe")))
        att.append(ms(lambda: c.call("pane_attach", {"pane_id": pane}, until=output_of(pane))))
        reattach.append((time.perf_counter() - t0) * 1000)
        c.s.close()
    c = Rpc()
    switch, switch_attach = [], []
    for i in range(20):
        wt = with_tabs[i % len(with_tabs)]
        t0 = time.perf_counter()
        switch.append(ms(lambda: c.call("worktree_open", {"worktree_id": wt})))
        c.call("pane_attach", {"pane_id": pane_of[wt]}, until=output_of(pane_of[wt]))
        switch_attach.append((time.perf_counter() - t0) * 1000)
        c.call("pane_detach", {"pane_id": pane_of[wt]})
    refresh = [ms(lambda: c.call("worktree_refresh")) for _ in range(5)]
    fresh, cached = [], []
    for _ in range(5):
        time.sleep(1.6)
        fresh.append(ms(lambda: c.call("ps", {"worktree_id": None})))
        cached.append(ms(lambda: c.call("ps", {"worktree_id": None})))
    c.s.close()
    return {"subscribe (snapshot)": sub, "pane_attach (scrollback)": att, "reattach total": reattach,
            "worktree_open (warm)": switch, "worktree_open + attach": switch_attach,
            "worktree_refresh": refresh, "ps fresh poll": fresh, "ps cached": cached}


def ops(trials):
    c = Rpc()
    snap = c.call("subscribe")
    c.s.close()
    live = [p for p in snap["panes"] if p.get("kind", "terminal") == "terminal"]
    pane_of = {p["worktree_id"]: p["id"] for p in live}
    with_tabs = sorted(pane_of)
    print(f"snapshot {len(json.dumps(snap)) / 1024:.0f} KB, {len(snap['worktrees'])} worktrees, {len(live)} terminal panes")
    medians = {}
    for n in range(trials):
        print(f"--- trial {n + 1}")
        for name, s in trial(live, with_tabs, pane_of).items():
            print(f"{name:28s} n={len(s):3d} median {statistics.median(s):8.2f} ms  min {min(s):8.2f}  max {max(s):8.2f}")
            medians.setdefault(name, []).append(statistics.median(s))
    print("--- median of trial medians (min..max)")
    for name, m in medians.items():
        print(f"{name:28s} {statistics.median(m):8.2f} ms ({min(m):.2f}..{max(m):.2f})")


def cpu_rss(pid):
    cputime, rss = subprocess.run(["ps", "-o", "cputime=,rss=", "-p", str(pid)], capture_output=True, text=True).stdout.split()
    return sum(float(x) * 60 ** i for i, x in enumerate(reversed(cputime.split(":")))), int(rss)


def idle(secs, subscribed):
    pid = int(subprocess.run(["pgrep", "-f", os.environ["TOMO_DAEMON_BIN"]], capture_output=True, text=True).stdout.split()[0])
    if subscribed:
        c = Rpc()
        c.call("subscribe")
        threading.Thread(target=lambda: all(True for _ in c.frames()), daemon=True).start()
    time.sleep(3)
    c0, r0 = cpu_rss(pid)
    time.sleep(secs)
    c1, r1 = cpu_rss(pid)
    print(f"idle subscribed={subscribed} {secs}s: cpu {(c1 - c0) / secs * 100:.2f} %  cpu-seconds {c1 - c0:.2f}  rss start {r0 / 1024:.1f} MB end {r1 / 1024:.1f} MB")


def connect_until(deadline):
    while time.perf_counter() < deadline:
        try:
            s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            s.connect(SOCK)
            return s
        except OSError:
            time.sleep(0.001)
    raise SystemExit("socket never accepted")


def stop_daemon():
    subprocess.run([T, "daemon", "stop"], capture_output=True, env=os.environ)
    for _ in range(200):
        if not os.path.exists(SOCK):
            return
        time.sleep(0.05)


def startup_trial():
    """One cold boot. Every time is milliseconds after the tomod process starts."""
    stop_daemon()
    daemon_bin = os.environ["TOMO_DAEMON_BIN"]
    t0 = time.perf_counter()
    p = subprocess.Popen([daemon_bin], stderr=open(D + "/startup.log", "w"), env=os.environ)
    s = connect_until(t0 + 30)
    t_connect = time.perf_counter()
    buf = b""

    def frames():
        nonlocal buf
        while True:
            while b"\n" in buf:
                line, buf = buf.split(b"\n", 1)
                if line.strip():
                    yield time.perf_counter(), json.loads(line)
            chunk = s.recv(1 << 20)
            if not chunk:
                raise SystemExit("socket closed")
            buf += chunk

    def call(method, params=None):
        s.sendall((json.dumps({"id": 1, "method": method} | ({"params": params} if params else {})) + "\n").encode())
        for at, f in frames():
            if f.get("id") == 1:
                if "error" in f:
                    raise SystemExit(f"{method}: {f['error']}")
                return at, f.get("result")

    t_hello, _ = call("hello", {"protocol": 3, "client": "startup-bench"})
    t_sub, snap = call("subscribe")
    wts = snap["worktrees"]
    panes = snap["panes"]
    terminals = [x for x in panes if x.get("kind", "terminal") == "terminal"]
    t_wts = t_sub if wts else None
    t_summ = t_sub if wts and all(w.get("git") for w in wts) else None
    seen = len(wts)
    if t_summ is None:
        for at, f in frames():
            if f.get("event") != "worktrees_changed":
                continue
            ws = f["data"]["worktrees"]
            seen = max(seen, len(ws))
            if t_wts is None and ws:
                t_wts = at
            if ws and all(w.get("git") for w in ws):
                t_summ = at
                break
    out = {
        "connect": (t_connect - t0) * 1000,
        "hello": (t_hello - t0) * 1000,
        "subscribe": (t_sub - t0) * 1000,
        "worktrees visible": (t_wts - t0) * 1000,
        "summaries done": (t_summ - t0) * 1000,
    }
    snapshot = {
        "kb": len(json.dumps(snap)) / 1024,
        "worktrees": len(wts),
        "with git": sum(1 for w in wts if w.get("git")),
        "panes": len(panes),
        "live panes": sum(1 for x in terminals if x.get("live")),
        "distinct pids": len({x["pid"] for x in terminals if x.get("pid")}),
        "worktrees at end": seen,
    }
    s.close()
    stop_daemon()
    p.wait(timeout=30)
    return out, snapshot


def startup(trials):
    rows, snaps = [], []
    for n in range(trials):
        out, snap = startup_trial()
        rows.append(out)
        snaps.append(snap)
        print(f"--- trial {n + 1}  " + "  ".join(f"{k} {v:.1f}" for k, v in out.items()))
    print("--- median ms after the tomod process starts")
    for name in rows[0]:
        s = [r[name] for r in rows]
        print(f"{name:20s} {statistics.median(s):8.1f} ms  (min {min(s):.1f}  max {max(s):.1f})")
    print("--- first snapshot (median over trials)")
    for name in snaps[0]:
        print(f"{name:20s} {statistics.median(x[name] for x in snaps):8.1f}")


if __name__ == "__main__":
    mode = sys.argv[1]
    if mode == "setup":
        setup()
    elif mode == "ops":
        ops(int(sys.argv[2]) if len(sys.argv) > 2 else 3)
    elif mode == "idle":
        idle(int(sys.argv[2]), sys.argv[3] == "1")
    elif mode == "startup":
        startup(int(sys.argv[2]) if len(sys.argv) > 2 else 5)
