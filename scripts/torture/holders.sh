#!/bin/bash
# Pane holders: a pane keeps running across a daemon stop, a restart and a kill -9, with the same pid,
# a live background child and working input. Closing a pane, an orphan holder and stop --kill-panes end it.
set -u
. "$(dirname "$0")/lib.sh"

W="$(mktemp -d /tmp/tomo-harness-holders.XXXX)"; W="$(cd "$W" && pwd -P)"
alive() { kill -0 "$1" 2>/dev/null; }
ticks() { wc -l < "$W/ticks.log" | tr -d ' '; }
pane_row() { $T pane list --json | jq_ "p=[p for p in d if p['id']=='$1'][0]; print(p['pid'] or '', p['live'], p['origin'])"; }
new_pane() { $T pane create --worktree "$WT" --json -- /bin/sh -c "$1" | jq_ "print(d['pane']['id'])"; }

daemon_fresh 'shell = "/bin/sh"'
R=$(new_repo); $T repo add "$R" >/dev/null
WT=$($T worktree list --json | jq_ "print(d[0]['id'])")
TICKER=$(new_pane "sleep 600 & echo \$! > $W/child.pid; while :; do echo tick >> $W/ticks.log; sleep 0.2; done")
ECHO=$(new_pane "while read l; do echo \"got \$l\" >> $W/input.log; done")
wait_for "[ -s $W/child.pid ]" 10
read -r PID _ _ < <(pane_row "$TICKER"); CHILD=$(cat "$W/child.pid")
alive "$PID" && [ -S "$TOMO_DATA_DIR/pty/$TICKER.sock" ] && check 0 "a pane runs under a holder" || check 1 "holder" "pid=$PID"

# 1. a stop leaves the pane running, and a start reattaches the same process
$T daemon stop >/dev/null; sleep 1
before=$(ticks); sleep 1
alive "$PID" && alive "$CHILD" && [ "$(ticks)" -gt "$before" ] && check 0 "after a stop the pane and its child keep running" || check 1 "after stop"
$T daemon start >/dev/null; sleep 1
read -r PID2 LIVE2 ORIGIN2 < <(pane_row "$TICKER")
[ "$PID2" = "$PID" ] && [ "$LIVE2" = True ] && [ "$ORIGIN2" = live ] && check 0 "a restart reattaches the same pid" || check 1 "reattach" "$PID -> $PID2 $LIVE2 $ORIGIN2"
$T pane send "after-restart" --pane "$ECHO" >/dev/null
wait_for "grep -q 'got after-restart' $W/input.log" 10 && check 0 "input reaches a pane after a restart" || check 1 "input after restart"

# 2. kill -9 of the daemon
kill -9 "$(pgrep -fx "$TOMO_DAEMON_BIN" | head -1)"; sleep 1
alive "$PID" && alive "$CHILD" && check 0 "after kill -9 of the daemon the pane keeps running" || check 1 "after crash"
$T daemon start >/dev/null; sleep 1
read -r PID3 LIVE3 _ < <(pane_row "$TICKER")
[ "$PID3" = "$PID" ] && [ "$LIVE3" = True ] && check 0 "after a crash the daemon reattaches the same pid" || check 1 "reattach after crash" "$PID -> $PID3"
$T pane send "after-crash" --pane "$ECHO" >/dev/null
wait_for "grep -q 'got after-crash' $W/input.log" 10 && check 0 "input reaches a pane after a crash" || check 1 "input after crash"

# 3. closing a pane ends its process and its holder
$T pane close "$TICKER" --force >/dev/null
wait_for "! kill -0 $PID" 10 && check 0 "closing a pane ends its process" || check 1 "close"
wait_for "[ ! -e $TOMO_DATA_DIR/pty/$TICKER.sock ]" 10 && check 0 "closing a pane removes its holder socket" || check 1 "socket after close"
kill "$CHILD" 2>/dev/null

# 4. a holder that no pane owns is ended at start
read -r EPID _ _ < <(pane_row "$ECHO")
$T daemon stop >/dev/null; sleep 0.5
sqlite3 "$TOMO_DATA_DIR/tomo.sqlite3" "delete from panes where id='$ECHO'"
$T daemon start >/dev/null
wait_for "! kill -0 $EPID" 10 && check 0 "an orphan holder is ended at start" || check 1 "orphan"

# 5. stop --kill-panes ends every pane and every holder
LAST=$(new_pane "sleep 600"); sleep 0.5
read -r LPID _ _ < <(pane_row "$LAST")
$T daemon stop --kill-panes >/dev/null
wait_for "! kill -0 $LPID" 10 && check 0 "stop --kill-panes ends every pane" || check 1 "kill panes"
wait_for "! pgrep -f '$TOMO_DAEMON_BIN pty-holder'" 10 && check 0 "no holder is left" || check 1 "holders left" "$(pgrep -fl "$TOMO_DAEMON_BIN pty-holder")"

rm -rf "$W"
summary
