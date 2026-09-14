#!/usr/bin/env python3
"""Raw socket helper for the harnesses. Uses $TOMO_SOCKET or $TOMO_DATA_DIR/tomod.sock.

  tomo_rpc.py call <method> [json-params]         print the result JSON
  tomo_rpc.py attach <pane_id> <seconds>           print decoded pane output (escapes stripped)
  tomo_rpc.py raw <pane_id> <seconds>              print raw bytes as repr
  tomo_rpc.py send <pane_id> <text>                send text (python escapes like \\r allowed)
  tomo_rpc.py events <seconds>                     count events on a subscribed connection
"""
import base64, json, os, re, socket, sys, time

def sock_path():
    return os.environ.get("TOMO_SOCKET") or os.path.join(os.environ["TOMO_DATA_DIR"], "tomod.sock")

def connect():
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    s.connect(sock_path())
    return s

class Rpc:
    def __init__(self):
        self.s = connect(); self.buf = b""; self.n = 0
    def send(self, method, params=None):
        self.n += 1
        msg = {"id": self.n, "method": method}
        if params is not None: msg["params"] = params
        self.s.sendall((json.dumps(msg) + "\n").encode()); return self.n
    def frames(self, timeout):
        deadline = time.time() + timeout
        self.s.settimeout(0.2)
        while time.time() < deadline:
            while b"\n" in self.buf:
                line, self.buf = self.buf.split(b"\n", 1)
                if line.strip(): yield json.loads(line)
            try: c = self.s.recv(1 << 20)
            except socket.timeout: continue
            if not c: return
            self.buf += c
    def call(self, method, params=None, timeout=30):
        rid = self.send(method, params)
        for f in self.frames(timeout):
            if f.get("id") == rid:
                if "error" in f: raise SystemExit("rpc error: " + json.dumps(f["error"]))
                return f.get("result")
        raise SystemExit("rpc timeout: " + method)

STRIP = re.compile(rb"\x1b\[[0-9;?>=]*[A-Za-z@]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)|\x1b[()][A-Za-z0-9]|\x1b[=>78]|\x1bP[^\x1b]*\x1b\\|\r")

def main():
    cmd = sys.argv[1]
    r = Rpc()
    if cmd == "call":
        params = json.loads(sys.argv[3]) if len(sys.argv) > 3 else None
        print(json.dumps(r.call(sys.argv[2], params)))
    elif cmd in ("attach", "raw"):
        pane, secs = sys.argv[2], float(sys.argv[3])
        r.send("pane_attach", {"pane_id": pane})
        out = b""
        for f in r.frames(secs):
            if f.get("event") == "pane_output" and f["data"]["pane_id"] == pane:
                out += base64.b64decode(f["data"]["data_base64"])
        if cmd == "raw":
            sys.stdout.buffer.write(out)
        else:
            sys.stdout.write(STRIP.sub(b"", out).decode("utf8", "replace"))
    elif cmd == "send":
        text = sys.argv[3].encode("utf8").decode("unicode_escape").encode("latin1", "replace") if "\\" in sys.argv[3] else sys.argv[3].encode("utf8")
        r.call("pane_send", {"pane_id": sys.argv[2], "data_base64": base64.b64encode(text).decode()})
    elif cmd == "events":
        r.call("subscribe")
        n = 0
        for f in r.frames(float(sys.argv[2])):
            if "event" in f: n += 1
        print(n)

if __name__ == "__main__":
    main()
