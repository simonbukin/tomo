#!/bin/bash
# Reattach of a full-screen program: a client that opens the pane after a long session and a resize gets the alternate
# screen and the mouse modes, and the program draws itself at the current size. A shell gets its modes back too, and
# a program that dies without cleanup leaves no mouse reporting behind.
set -u
. "$(dirname "$0")/lib.sh"

daemon_fresh
R=$(new_repo); $T repo add "$R" >/dev/null
WT=$(wt_id "$R")
TUI="python3 $FIX/fake-tui"
attach() { $RPC raw "$1" "${2:-2}" | python3 -c "import sys; print(sys.stdin.buffer.read().decode('utf8','replace'))"; }
size() { $RPC call pane_resize "{\"pane_id\":\"$1\",\"cols\":$2,\"rows\":$3}" >/dev/null; }
last_draw() { grep -o 'draw#[0-9]*#' | tr -dc '0-9\n' | sort -n | tail -1; }
# The mouse mode that a terminal ends in after it reads the bytes on stdin: 1 when reporting is on.
mouse_after() { python3 -c "import re,sys; s=sys.stdin.read(); m=re.findall(r'\x1b\[\?100[023]([hl])', s); print(1 if m and m[-1]=='h' else 0)"; }

# 1. a long session and a resize, then a new client
P=$($T pane create --worktree "$WT"); sleep 1.5
size "$P" 100 30
$RPC send "$P" "$TUI --spam 1600000\r"
wait_for "attach $P 0.3 | grep -q 'row 30 of 100x30'" 30 && check 0 "the full-screen program drew itself at 100x30" || check 1 "fake-tui start"
size "$P" 160 45
wait_for "attach $P 0.5 | grep -q 'row 45 of 160x45'" 10
BEFORE=$(attach "$P" 0.5 | last_draw)
OUT=$(attach "$P" 1.5)
case "$OUT" in $'\e[?2026l\e[0m\e[?1049h\e[2J\e[H'*) check 0 "a new client gets the alternate screen first, empty" ;; *) check 1 "alt frame first" "$(printf %q "${OUT:0:40}")" ;; esac
printf %s "$OUT" | grep -qF $'\e[?1003h' && printf %s "$OUT" | grep -qF $'\e[?1006h' && check 0 "it gets the mouse modes that the cut front had set" || check 1 "mouse modes"
printf %s "$OUT" | grep -q 'tick ' && check 1 "old frames" "the replay carries frames from before the resize" || check 0 "it gets none of the old frames"
AFTER=$(printf %s "$OUT" | last_draw)
[ "${AFTER:-0}" -gt "${BEFORE:-0}" ] && printf %s "$OUT" | grep -q 'row 45 of 160x45' && check 0 "the nudge makes the program draw itself again, at the current size" || check 1 "repaint" "draw before=$BEFORE after=$AFTER"
size_now=$($T pane list --json | jq_ "print([(p['cols'],p['rows']) for p in d if p['id']=='$P'][0])")
[ "$size_now" = "(160, 45)" ] && check 0 "the pane keeps its size after the nudge" || check 1 "size after nudge" "$size_now"

# 2. a resize during the nudge wins
$RPC raw "$P" 0.01 >/dev/null; size "$P" 120 40
wait_for "attach $P 0.5 | grep -q 'row 40 of 120x40'" 10 && check 0 "a resize during the nudge is the size that stays" || check 1 "resize during nudge"

# 3. a program that dies without cleanup: the shell gets no mouse reporting
Q=$($T pane create --worktree "$WT"); sleep 1.5
$RPC send "$Q" "$TUI --crash\r"
sleep 2; $T ps --json >/dev/null
wait_for "attach $Q 0.5 | grep -qF \$'\\e[?1003l'" 10
OUT=$(attach "$Q" 1)
printf %s "$OUT" | grep -qF $'\e[?1049h\e[2J' && check 1 "dead program" "the shell pane is still treated as full-screen" || check 0 "after the program died, the pane is a shell again"
[ "$(printf %s "$OUT" | mouse_after)" = 0 ] && check 0 "its mouse reporting is off for the shell" || check 1 "mouse left on"

# 4. a plain shell pane still replays its output
S=$($T pane create --worktree "$WT"); sleep 1.5
$RPC send "$S" 'echo hello-from-the-shell\r'
wait_for "attach $S 0.5 | grep -q hello-from-the-shell" 10 && check 0 "a shell pane replays its output" || check 1 "shell replay"

daemon_stop
summary
