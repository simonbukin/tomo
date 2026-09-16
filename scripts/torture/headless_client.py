#!/usr/bin/env python3
"""A headless Tomo client: the Unix socket protocol and the Python standard library, nothing else.

It keeps its own copy of the client state. It starts from the `subscribe` snapshot and
applies each event, as `app/src/store.ts` does. It runs commands over the socket and checks
that the events it received produce the same state as a fresh snapshot. It prints PASS and
FAIL lines for `client.sh`. Uses $TOMO_SOCKET or $TOMO_DATA_DIR/tomod.sock.

  headless_client.py <repo path>      the fake agent must be `[agents.claude]` in config.toml
"""
import base64, json, os, socket, sys, time

PROTOCOL = 3
FAILED = []


def check(ok, name, detail=""):
    print(f"PASS {name}" if ok else f"FAIL {name}{f' ({detail})' if detail else ''}", flush=True)
    if not ok:
        FAILED.append(name)
    return ok


class RpcError(Exception):
    pass


class Conn:
    def __init__(self):
        self.s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.s.connect(os.environ.get("TOMO_SOCKET") or os.path.join(os.environ["TOMO_DATA_DIR"], "tomod.sock"))
        self.buf, self.n, self.events = b"", 0, []

    def frame(self, deadline):
        while b"\n" not in self.buf:
            left = deadline - time.time()
            if left <= 0:
                return None
            self.s.settimeout(left)
            try:
                chunk = self.s.recv(1 << 20)
            except socket.timeout:
                return None
            if not chunk:
                raise RpcError("daemon closed the connection")
            self.buf += chunk
        line, self.buf = self.buf.split(b"\n", 1)
        return json.loads(line) if line.strip() else self.frame(deadline)

    def call(self, method, params=None, timeout=30):
        self.n += 1
        msg = {"id": self.n, "method": method, **({"params": params} if params is not None else {})}
        self.s.sendall((json.dumps(msg) + "\n").encode())
        deadline = time.time() + timeout
        while (f := self.frame(deadline)) is not None:
            if "event" in f:
                self.events.append(f)
            elif f.get("id") == self.n:
                if "error" in f:
                    raise RpcError(f"{method}: {f['error']['code']}: {f['error']['message']}")
                return f.get("result")
        raise RpcError(f"{method}: no reply in {timeout}s")

    def drain(self, seconds):
        deadline = time.time() + seconds
        while (f := self.frame(deadline)) is not None:
            if "event" in f:
                self.events.append(f)
        out, self.events = self.events, []
        return out

    def close(self):
        self.s.close()


def by_key(items, key="id"):
    return {x[key]: x for x in items}


def leaf_ids(node):
    return [node["pane_id"]] if node["type"] == "leaf" else leaf_ids(node["first"]) + leaf_ids(node["second"])


def from_snapshot(snap):
    return {
        "status": snap["status"],
        "repos": by_key(snap["repos"]),
        "worktrees": by_key(snap["worktrees"]),
        "tabs": by_key(snap["tabs"]),
        "panes": by_key(snap["panes"]),
        "agents": by_key(snap["agents"], "pane_id"),
        "attention": by_key(snap["attention"]),
    }


def without(d, key):
    return {k: v for k, v in d.items() if k != key}


def fold(state, frame):
    ev, d = frame["event"], frame.get("data") or {}
    if ev == "repos_changed":
        return {**state, "repos": by_key(d["repos"])}
    if ev == "worktrees_changed":
        return {**state, "worktrees": by_key(d["worktrees"])}
    if ev == "metadata_changed" and d["worktree_id"] in state["worktrees"]:
        w = state["worktrees"][d["worktree_id"]]
        return {**state, "worktrees": {**state["worktrees"], w["id"]: {**w, "metadata": d["metadata"]}}}
    if ev == "tabs_changed":
        wt = d["worktree_id"]
        tabs = {**{k: t for k, t in state["tabs"].items() if t["worktree_id"] != wt}, **by_key(d["tabs"])}
        live = {p for t in tabs.values() for p in leaf_ids(t["layout"])}
        panes = {k: p for k, p in state["panes"].items() if p["worktree_id"] != wt or k in live}
        agents = {k: a for k, a in state["agents"].items() if k in panes}
        return {**state, "tabs": tabs, "panes": panes, "agents": agents}
    if ev == "pane_changed":
        return {**state, "panes": {**state["panes"], d["pane"]["id"]: d["pane"]}}
    if ev == "pane_exited" and d["pane_id"] in state["panes"]:
        p = state["panes"][d["pane_id"]]
        return {**state, "panes": {**state["panes"], p["id"]: {**p, "live": False, "exit_code": d["exit_code"]}}}
    if ev == "agent_changed":
        return {**state, "agents": {**state["agents"], d["agent"]["pane_id"]: d["agent"]}}
    if ev == "agent_removed":
        return {**state, "agents": without(state["agents"], d["pane_id"])}
    if ev == "attention_added":
        return {**state, "attention": {**state["attention"], d["item"]["id"]: d["item"]}}
    if ev == "attention_resolved":
        return {**state, "attention": without(state["attention"], d["id"])}
    if ev == "attention_viewed" and d["id"] in state["attention"]:
        a = state["attention"][d["id"]]
        return {**state, "attention": {**state["attention"], a["id"]: {**a, "viewed_at_ms": a["viewed_at_ms"] or int(time.time() * 1000)}}}
    if ev == "attention_cleared":
        return {**state, "attention": {}}
    return state


def needs_me(item, agents):
    """The rule of `needsMeItem` in app/src/activityModel.ts. A second client must copy it."""
    if item.get("resolved_at_ms") is not None:
        return False
    if item["kind"] != "waiting":
        return True
    if item.get("viewed_at_ms") is not None:
        return False
    return any(a["pane_id"] == item["pane_id"] and a["state"] == "waiting" for a in agents.values())


def view(state):
    return {
        "repos": sorted(state["repos"]),
        "worktrees": sorted((w["id"], w["repo_id"], w["path"], w["is_main"]) for w in state["worktrees"].values()),
        "tabs": {t["id"]: (t["worktree_id"], t["title"], t["position"], json.dumps(t["layout"], sort_keys=True), t["active_pane_id"], t["is_active"]) for t in state["tabs"].values()},
        "panes": {p["id"]: (p["tab_id"], p["worktree_id"], p["live"], p["kind"]) for p in state["panes"].values()},
        "agents": {a["pane_id"]: (a["kind"], a["state"], a["session_ref"]) for a in state["agents"].values()},
        "attention": {a["id"]: (a["kind"], a["pane_id"], a["viewed_at_ms"] is not None) for a in state["attention"].values()},
    }


def fresh_snapshot():
    c = Conn()
    try:
        c.call("hello", {"protocol": PROTOCOL, "client": "headless-client-check"})
        return from_snapshot(c.call("subscribe"))
    finally:
        c.close()


def apply_events(conn, state, seconds):
    events = conn.drain(seconds)
    return state if not events else apply_all(state, events)


def apply_all(state, events):
    return apply_all(fold(state, events[0]), events[1:]) if events else state


def wait_until(conn, state, pred, timeout=20):
    deadline = time.time() + timeout
    state = apply_all(state, conn.drain(0))
    while not pred(state) and time.time() < deadline:
        state = apply_events(conn, state, 0.2)
    return state, pred(state)


def converges(conn, state, name, tries=15):
    for _ in range(tries):
        fresh = fresh_snapshot()
        state = apply_events(conn, state, 0.3)
        if view(state) == view(fresh):
            return check(True, f"{name}: live events give the same state as a fresh snapshot") and state
    diff = {k: (view(state)[k], view(fresh)[k]) for k in view(state) if view(state)[k] != view(fresh)[k]}
    check(False, f"{name}: live events give the same state as a fresh snapshot", json.dumps(diff)[:600])
    return state


def attached_text(conn, pane_id, needle, timeout=10):
    conn.call("pane_attach", {"pane_id": pane_id})
    deadline, seen = time.time() + timeout, b""
    while needle.encode() not in seen and time.time() < deadline:
        seen += b"".join(base64.b64decode(f["data"]["data_base64"]) for f in conn.drain(0.2) if f["event"] == "pane_output" and f["data"]["pane_id"] == pane_id)
    conn.call("pane_detach", {"pane_id": pane_id})
    return needle.encode() in seen


def files_check(conn, wt, repo_path):
    """fs_list: the wire fields, the order the daemon sends, and the recency sort that each client does itself."""
    root = os.path.join(repo_path, "files-check")
    os.makedirs(os.path.join(root, "sub"), exist_ok=True)
    now = time.time()
    ages = {"alpha.txt": 300, "Beta.txt": 200, "gamma.txt": 100}
    for name, age in ages.items():
        path = os.path.join(root, name)
        with open(path, "w") as f:
            f.write(name)
        os.utime(path, (now - age, now - age))
    os.utime(os.path.join(root, "sub"), (now - 400, now - 400))

    entries = conn.call("fs_list", {"worktree_id": wt, "rel_path": "files-check"})
    by_name = {e["name"]: e for e in entries}
    sane = len(entries) == 4 and by_name["sub"]["is_dir"] and not by_name["alpha.txt"]["is_dir"]
    sane = sane and all(e["rel_path"] == f"files-check/{e['name']}" for e in entries)
    sane = sane and all(e["size"] == len(name) for name, e in by_name.items() if name in ages)
    sane = sane and all(abs(by_name[name]["modified_ms"] / 1000 - (now - age)) < 2 for name, age in ages.items())
    check(sane, "fs_list: each entry carries a sane modified_ms, size, is_dir, and rel_path", json.dumps(entries)[:400])

    names = [e["name"] for e in entries]
    check(names == ["sub", "alpha.txt", "Beta.txt", "gamma.txt"], "fs_list: the daemon sends directories first, then names, without case", json.dumps(names))

    recent = [e["name"] for e in sorted(entries, key=lambda e: -e["modified_ms"])]
    check(recent == ["gamma.txt", "Beta.txt", "alpha.txt", "sub"], "fs_list: a recency sort on the client puts the newest entry first", json.dumps(recent))


def run(repo_path):
    conn = Conn()
    hello = conn.call("hello", {"protocol": PROTOCOL, "client": "headless-client"})
    check(hello["protocol"] == PROTOCOL, "hello: the daemon speaks protocol 3")

    state = from_snapshot(conn.call("subscribe"))
    check(state["status"]["protocol"] == PROTOCOL and not state["repos"], "subscribe: a snapshot with status and no repos")

    conn.call("repo_add", {"path": repo_path}, timeout=60)
    state, ok = wait_until(conn, state, lambda s: any(r["path"] == repo_path for r in s["repos"].values()) and any(w["path"] == repo_path and w["is_main"] for w in s["worktrees"].values()))
    check(ok, "repo_add: repos_changed and worktrees_changed show the repo and its main worktree")
    wt = next(w["id"] for w in state["worktrees"].values() if w["path"] == repo_path)
    files_check(conn, wt, repo_path)

    tab = conn.call("tab_create", {"worktree_id": wt, "title": "headless"})
    state, ok = wait_until(conn, state, lambda s: tab["id"] in s["tabs"] and all(p in s["panes"] for p in leaf_ids(s["tabs"][tab["id"]]["layout"])))
    first = leaf_ids(tab["layout"])[0]
    check(ok and state["tabs"][tab["id"]]["layout"]["type"] == "leaf" and state["panes"][first]["live"] and state["panes"][first]["tab_id"] == tab["id"], "tab_create: tabs_changed and pane_changed show a tab with one live pane")

    split = conn.call("pane_split", {"pane_id": first, "direction": "horizontal", "command": None})
    second = split["pane"]["id"]
    state, ok = wait_until(conn, state, lambda s: sorted(leaf_ids(s["tabs"][tab["id"]]["layout"])) == sorted([first, second]) and second in s["panes"])
    layout = state["tabs"][tab["id"]]["layout"]
    check(ok and layout["type"] == "split" and layout["direction"] == "horizontal" and 0 < layout["ratio"] < 1, "pane_split: the tab layout is a horizontal split of the two panes")
    state = converges(conn, state, "after the split")

    spawn = conn.call("agent_spawn", {"kind": "claude", "worktree_id": wt, "cwd": None, "tab_id": tab["id"], "split_from": None, "resume": None, "new_tab": False, "extra_args": []})
    agent = spawn["pane"]["id"]
    state, ok = wait_until(conn, state, lambda s: s["agents"].get(agent, {}).get("state") == "idle" and s["agents"][agent]["authority"] == "lifecycle" and s["agents"][agent]["session_ref"])
    check(ok, "agent_spawn: agent_changed shows the fake agent idle with lifecycle authority and a session", json.dumps(state["agents"].get(agent)))
    check(attached_text(conn, agent, "fake-agent session"), "pane_attach: pane_output carries the terminal bytes of the agent")

    conn.call("pane_send", {"pane_id": agent, "data_base64": base64.b64encode(b"wait\r").decode()})
    waiting_item = lambda s: next((a for a in s["attention"].values() if a["pane_id"] == agent and a["kind"] == "waiting"), None)
    state, ok = wait_until(conn, state, lambda s: s["agents"][agent]["state"] == "waiting" and waiting_item(s))
    check(ok and needs_me(waiting_item(state), state["agents"]), "pane_send: the agent waits, attention_added opens a waiting item that needs me")
    state = converges(conn, state, "while the agent waits")

    item = waiting_item(state)
    conn.call("attention_view", {"id": item["id"]})
    state, ok = wait_until(conn, state, lambda s: s["attention"][item["id"]]["viewed_at_ms"] is not None)
    check(ok and not needs_me(state["attention"][item["id"]], state["agents"]), "attention_view: attention_viewed marks the item, and a viewed waiting item no longer needs me")

    cp = conn.call("checkpoint_create", {"message": "review the headless client", "worktree_id": wt, "pane_id": agent})
    state, ok = wait_until(conn, state, lambda s: cp["id"] in s["attention"])
    check(ok and state["attention"][cp["id"]]["kind"] == "checkpoint" and needs_me(state["attention"][cp["id"]], state["agents"]), "checkpoint_create: attention_added shows a checkpoint that needs me")
    conn.call("checkpoint_resolve", {"id": cp["id"]})
    state, ok = wait_until(conn, state, lambda s: cp["id"] not in s["attention"])
    check(ok, "checkpoint_resolve: attention_resolved removes the checkpoint")
    listed = conn.call("attention_list")
    check({a["id"] for a in listed} == set(state["attention"]), "attention_list: the daemon list matches the client state")

    status = conn.call("status")
    panes = state["panes"].values()
    check(
        (status["repos"], status["worktrees"], status["panes"], status["live_panes"], status["agents"]) == (len(state["repos"]), len(state["worktrees"]), len(panes), sum(p["live"] for p in panes), len(state["agents"])),
        "status: repo, worktree, pane, live pane, and agent counts match the client state",
        json.dumps({k: status[k] for k in ("repos", "worktrees", "panes", "live_panes", "agents")}),
    )
    state = converges(conn, state, "after attention changes")

    conn.call("pane_close", {"pane_id": second, "force": True})
    state, ok = wait_until(conn, state, lambda s: second not in s["panes"] and second not in leaf_ids(s["tabs"][tab["id"]]["layout"]))
    check(ok, "pane_close: tabs_changed removes the pane from the layout and the pane list")
    conn.call("tab_close", {"tab_id": tab["id"], "force": True})
    state, ok = wait_until(conn, state, lambda s: tab["id"] not in s["tabs"] and agent not in s["panes"] and agent not in s["agents"])
    check(ok, "tab_close: the tab, its panes, and its agent leave the client state")
    converges(conn, state, "after the close")
    conn.close()


def main():
    try:
        run(os.path.realpath(sys.argv[1]))
    except (RpcError, OSError, KeyError, StopIteration, TypeError) as e:
        check(False, "headless client stopped", f"{type(e).__name__}: {e}")
    sys.exit(1 if FAILED else 0)


if __name__ == "__main__":
    main()
