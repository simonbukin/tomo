#!/bin/bash
# Terminal and PTY torture against a scratch daemon. No LLM tokens, no GUI.
set -u
. "$(dirname "$0")/lib.sh"

daemon_fresh
R=$(new_repo); $T repo add "$R" >/dev/null
WT=$(wt_id "$R")
P=$($T pane create --worktree "$WT"); sleep 1.5
send() { $RPC send "$P" "$1"; }
out() { $RPC attach "$P" "${1:-2}"; }
resize() { $RPC call pane_resize "{\"pane_id\":\"$P\",\"cols\":$1,\"rows\":$2}" >/dev/null; }
resize 120 40

# 1. 20 MB burst
send 'yes abcdefghijklmnopqrstuvwxyz0123456789 | head -c 20000000; echo BURST-DONE\r'
sleep 6
o=$(out 2); case "$o" in *BURST-DONE*) check 0 "20 MB burst finishes and tail is visible";; *) check 1 "20 MB burst" "marker missing";; esac
size=$($RPC raw "$P" 1 | wc -c); [ "$size" -le 1310720 ] && check 0 "scrollback capped at 1 MB (+25%) after burst: $size bytes" || check 1 "scrollback cap" "$size bytes"
$T status >/dev/null && check 0 "daemon responsive after burst" || check 1 "daemon after burst"

# 2. very long line
send 'printf "L%.0s" $(seq 1 200000); echo; echo LONG-DONE\r'; sleep 3
o=$(out 1); case "$o" in *LONG-DONE*) check 0 "200k-char line";; *) check 1 "200k-char line";; esac

# 3. truecolor + unicode
send 'printf "\033[38;2;255;100;0mTC\033[0m 日本語テスト 🗻 é\u0301 ｶﾀｶﾅ\n"; echo UNI-DONE\r'; sleep 2
o=$(out 1); case "$o" in *"日本語テスト"*🗻*UNI-DONE*) check 0 "truecolor, Japanese, emoji, combining survive";; *) check 1 "unicode" "$(echo "$o" | tail -c 120)";; esac

# 4. alternate screen programs
send 'seq 1 500 > /tmp/tomo-harness-less.txt; less /tmp/tomo-harness-less.txt\r'; sleep 1.5
send 'q'; sleep 1; send 'echo LESS-BACK\r'; sleep 1
o=$(out 1); case "$o" in *LESS-BACK*) check 0 "less enters and leaves alternate screen";; *) check 1 "less";; esac
send 'vim -u NONE /tmp/tomo-harness-less.txt\r'; sleep 2; send ':q!\r'; sleep 1; send 'echo VIM-BACK\r'; sleep 1
o=$(out 1); case "$o" in *VIM-BACK*) check 0 "vim opens and quits";; *) check 1 "vim";; esac
send 'top -l 1 | head -3; echo TOP-DONE\r'; sleep 4
o=$(out 1); case "$o" in *TOP-DONE*) check 0 "top -l 1";; *) check 1 "top";; esac

# 5. resize storm
for i in $(seq 1 50); do resize $((60 + i)) $((20 + i % 10)); done
send 'echo COLS=$COLUMNS\r'; sleep 1
o=$(out 1); case "$o" in *COLS=110*) check 0 "50 resizes settle on the last size";; *) check 1 "resize storm" "$(echo "$o" | grep -o 'COLS=[0-9]*' | tail -1)";; esac

# 6. rapid pane create/close during a flood
send 'yes flood | head -c 30000000 > /dev/null & sleep 0.1; yes FLOOD | head -c 8000000; echo FLOOD-DONE\r'
ok=0; for i in $(seq 1 10); do q=$($T pane create --worktree "$WT") && $T pane close "$q" --force >/dev/null 2>&1 && ok=$((ok+1)); done
sleep 4; [ $ok = 10 ] && check 0 "10 panes created and closed during a flood" || check 1 "create/close during flood" "$ok/10"
o=$(out 1); case "$o" in *FLOOD-DONE*) check 0 "flood completes";; *) check 1 "flood";; esac

# 7. scrollback boundaries on fresh panes
Z=$($T pane create --worktree "$WT" -- /bin/sh -c 'sleep 30'); sleep 1
z=$($RPC raw "$Z" 1 | wc -c); [ "$z" -eq 0 ] && check 0 "0-byte scrollback replays nothing" || check 1 "0-byte scrollback" "$z bytes"
$T pane close "$Z" --force >/dev/null
# exactly 1 MB plus an escape split across the trim boundary and a split UTF-8 code point
B=$($T pane create --worktree "$WT"); sleep 1.5
$RPC send "$B" "python3 $FIX/boundary-output; echo BOUNDARY-DONE\r"
sleep 5
raw=$($RPC raw "$B" 1 | wc -c); [ "$raw" -ge 1000000 ] && [ "$raw" -le 1310720 ] && check 0 "replay after >1 MB stays within cap: $raw bytes" || check 1 "boundary replay size" "$raw"
$RPC send "$B" 'echo OK-AFTER-REPLAY\r'; sleep 1
o=$($RPC attach "$B" 1); case "$o" in *OK-AFTER-REPLAY*) check 0 "input works after a replay that starts mid-sequence";; *) check 1 "input after replay";; esac
$T pane close "$B" --force >/dev/null

# 8. reattach after >1 MB written while nobody is attached
D=$($T pane create --worktree "$WT"); sleep 1.5
$RPC send "$D" 'yes detached-output | head -c 3000000; echo DETACHED-DONE\r'; sleep 5
o=$($RPC attach "$D" 1); case "$o" in *DETACHED-DONE*) check 0 "reattach shows the tail after 3 MB detached output";; *) check 1 "detached reattach";; esac
$T pane close "$D" --force >/dev/null

# 9. daemon restart + 20 rapid reconnects
daemon_restart
ok=0; for i in $(seq 1 20); do $T status >/dev/null 2>&1 & done; wait
for i in $(seq 1 20); do $T status >/dev/null 2>&1 && ok=$((ok+1)); done
[ $ok = 20 ] && check 0 "20 rapid clients after restart" || check 1 "rapid reconnects" "$ok/20"
$T pane list --json | jq_ "print(len([p for p in d if p['origin']=='restored']))" | grep -q '^[1-9]' && check 0 "panes restored after daemon restart" || check 1 "restore after restart"

daemon_stop
summary
