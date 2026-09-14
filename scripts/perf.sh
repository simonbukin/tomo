#!/bin/bash
# Measures tomod start, discovery, subscribe, poll, and idle CPU against a copy of a data dir.
# Usage: TOMO_PERF_SOURCE=<data dir with repos> TOMOD=<tomod binary> scripts/perf.sh
set -u
D=${TOMO_PERF_DIR:-/tmp/tomo-perf}; rm -rf "$D"; mkdir -p "$D"
SRC=${TOMO_PERF_SOURCE:-/tmp/tomo-dev}; cp "$SRC/tomo.sqlite3" "$D/" 2>/dev/null; cp "$SRC/config.toml" "$D/" 2>/dev/null
export TOMO_DATA_DIR=$D
TOMOD=${TOMOD:-$HOME/.local/bin/tomod}; T=${T:-$HOME/.local/bin/tomo}
echo "binary: $TOMOD"
python3 - <<'EOF'
import subprocess, time, socket, os, json, base64
D=os.environ["TOMO_DATA_DIR"]; sock=D+"/tomod.sock"
t0=time.time()
p=subprocess.Popen([os.environ.get("TOMOD", os.path.expanduser("~/.local/bin/tomod"))], stderr=open(D+"/tomod.log","w"))
while not os.path.exists(sock):
    time.sleep(0.005)
s=None
while True:
    try:
        s=socket.socket(socket.AF_UNIX, socket.SOCK_STREAM); s.connect(sock); break
    except OSError: time.sleep(0.005)
t_sock=time.time()-t0
buf=b""; seq=[0]
def call(method, params=None):
    global buf
    seq[0]+=1; rid=seq[0]
    s.sendall((json.dumps({"id":rid,"method":method,"params":params} if params is not None else {"id":rid,"method":method})+"\n").encode())
    while True:
        while b"\n" in buf:
            line,buf=buf.split(b"\n",1)
            if not line.strip(): continue
            f=json.loads(line)
            if f.get("id")==rid: return f
        c=s.recv(1<<20)
        if not c: raise SystemExit("closed")
        buf+=c
t=time.time(); call("hello",{"protocol":1,"client":"perf"}); t_hello=time.time()-t
t=time.time(); r=call("subscribe"); t_sub=time.time()-t; size=len(json.dumps(r))
wts=len(r["result"]["worktrees"]); with_git=sum(1 for w in r["result"]["worktrees"] if w.get("git"))
while True:
    ws=call("worktree_list")["result"]
    if ws: break
    time.sleep(0.005)
t_visible=time.time()-t0
while True:
    ws=call("worktree_list")["result"]
    if all(w.get("git") for w in ws): break
    time.sleep(0.01)
t_summ=time.time()-t0
time.sleep(1.0)
t=time.time(); call("worktree_refresh"); t_refresh=time.time()-t
t=time.time(); call("ps",{"worktree_id":None}); t_ps=time.time()-t
t=time.time(); call("ps",{"worktree_id":None}); t_ps2=time.time()-t
t=time.time(); call("worktree_list"); t_list=time.time()-t
print(f"socket ready      {t_sock*1000:7.1f} ms")
print(f"hello             {t_hello*1000:7.1f} ms")
print(f"subscribe         {t_sub*1000:7.1f} ms  ({size/1024:.0f} KB, {wts} worktrees, {with_git} with git summary)")
print(f"worktrees visible {t_visible*1000:7.1f} ms after launch ({len(ws)} worktrees)")
print(f"summaries done    {t_summ*1000:7.1f} ms after launch")
print(f"worktree_refresh  {t_refresh*1000:7.1f} ms (quiet daemon)")
print(f"ps (fresh poll)   {t_ps*1000:7.1f} ms")
print(f"ps (cached)       {t_ps2*1000:7.1f} ms")
print(f"worktree_list     {t_list*1000:7.1f} ms")
# idle cpu over 20s with a subscribed client (poll every 2s)
import resource
def cpu(pid):
    out=subprocess.run(["ps","-o","cputime=,rss=","-p",str(pid)],capture_output=True,text=True).stdout.split()
    m,sec=out[0].split(":"); return int(m)*60+float(sec), int(out[1])
c0,_=cpu(p.pid); time.sleep(20); c1,rss=cpu(p.pid)
print(f"daemon idle cpu   {(c1-c0)/20*100:7.1f} %  (20 s with a subscribed client), rss {rss/1024:.0f} MB")
call("daemon_stop")
EOF
sleep 1; grep -E "WARN|ERROR" $D/tomod.log | head -3