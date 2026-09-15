#!/bin/bash
# tab_move, pane_move, and pane_tail over the socket. Every step checks every tab of the worktree.
set -u
. "$(dirname "$0")/lib.sh"

daemon_fresh "max_panes_per_tab = 3"
R=$(new_repo); $T repo add "$R" >/dev/null
WT=$(wt_id "$R")
P1=$($T pane create --worktree "$WT"); sleep 0.5

tabs() { $T tab list "$WT" --json; }
tab_of() { $T pane list --json | jq_ "print([p for p in d if p['id']=='$1'][0]['tab_id'])"; }
leaves() { tabs | jq_ "
t=[x for x in d if x['id']=='$1']
def walk(n): return [n['pane_id']] if n['type']=='leaf' else walk(n['first'])+walk(n['second'])
print(' '.join(walk(t[0]['layout'])) if t else 'gone')"; }
root_dir() { tabs | jq_ "print([x for x in d if x['id']=='$1'][0]['layout'].get('direction','leaf'))"; }
titles() { tabs | jq_ "print(' '.join(t['title'] for t in sorted(d, key=lambda t: t['position'])))"; }
active_tab() { tabs | jq_ "print(' '.join(t['id'] for t in d if t['is_active']))"; }
move() { $RPC call pane_move "$1" >/dev/null; }
tail_of() { local params="{\"pane_id\":\"$1\",\"lines\":$2}"; $RPC call pane_tail "$params"; }
rpc_code() { $RPC call "$1" "$2" 2>&1 | grep -q "\"code\": \"$3\""; }
expect() { if [ "$2" = "$3" ]; then pass "$1"; else fail "$1 (got '$2', want '$3')"; fi; }
all_valid() { tabs | jq_ "
ids=[]; bad=[]
def walk(n):
    if n['type']=='leaf': ids.append(n['pane_id']); return
    if not 0.05 <= n['ratio'] <= 0.95: bad.append(n['ratio'])
    walk(n['first']); walk(n['second'])
for t in d: walk(t['layout'])
active=[t for t in d if t['is_active']]
ok = len(ids)==len(set(ids))==$1 and not bad and len(active)==1
print('ok' if ok else f'ids={ids} bad={bad} active={len(active)}'); sys.exit(0 if ok else 1)"; }
step() { local n="$1"; shift; local why; if why=$(all_valid "$n" 2>&1); then pass "$*"; else fail "$* ($why)"; fi; }

TAB=$(tab_of "$P1")
P2=$($T pane split "$P1" --right)
P3=$($T pane split "$P2" --down)
step 3 "setup: $P1 | ($P2 / $P3)"

move "{\"pane_id\":\"$P3\",\"target_pane_id\":\"$P1\",\"place\":\"left\"}"; step 3 "left of a pane"
expect "left split puts the pane first and collapses its old parent" "$(leaves "$TAB")" "$P3 $P1 $P2"
move "{\"pane_id\":\"$P3\",\"target_pane_id\":\"$P2\",\"place\":\"center\"}"; step 3 "center"
expect "center swaps" "$(leaves "$TAB")" "$P2 $P1 $P3"
move "{\"pane_id\":\"$P2\",\"target_pane_id\":\"$P3\",\"place\":\"bottom\"}"; step 3 "bottom"
expect "bottom split" "$(leaves "$TAB")" "$P1 $P3 $P2"
move "{\"pane_id\":\"$P1\",\"target_pane_id\":\"$P2\",\"place\":\"top\"}"; step 3 "top"
expect "top split" "$(leaves "$TAB")" "$P3 $P1 $P2"
move "{\"pane_id\":\"$P2\",\"target_pane_id\":\"$P3\",\"place\":\"right\"}"; step 3 "right"
expect "right split" "$(leaves "$TAB")" "$P3 $P2 $P1"
expect "the moved pane becomes the active pane" "$(tabs | jq_ "print([t for t in d if t['id']=='$TAB'][0]['active_pane_id'])")" "$P2"

before=$(tabs)
move "{\"pane_id\":\"$P1\",\"target_pane_id\":\"$P1\",\"place\":\"left\"}"
expect "drop on self changes nothing" "$(tabs)" "$before"

rpc_code pane_move "{\"pane_id\":\"nope\",\"target_pane_id\":\"$P1\",\"place\":\"left\"}" not_found && pass "stale pane id is not_found" || fail "stale pane id"
rpc_code pane_move "{\"pane_id\":\"$P1\",\"target_pane_id\":\"nope\",\"place\":\"left\"}" not_found && pass "stale target id is not_found" || fail "stale target id"
rpc_code pane_move "{\"pane_id\":\"$P1\",\"tab_id\":\"nope\",\"place\":\"left\"}" not_found && pass "stale tab id is not_found" || fail "stale tab id"
rpc_code pane_move "{\"pane_id\":\"$P1\",\"place\":\"left\"}" bad_request && pass "no target is bad_request" || fail "no target"
rpc_code tab_move "{\"tab_id\":\"nope\",\"position\":0}" not_found && pass "tab_move with a stale id is not_found" || fail "tab_move stale id"

move "{\"pane_id\":\"$P3\",\"tab_id\":\"$TAB\",\"place\":\"bottom\"}"; step 3 "edge of its own tab"
expect "own-tab edge move wraps the root in a vertical split" "$(root_dir "$TAB") $(leaves "$TAB" | awk '{print $3}')" "vertical $P3"

PANES=("$P1" "$P2" "$P3"); PLACES=(center left right top bottom); bad=0
for i in $(seq 1 40); do
  a=${PANES[$((RANDOM % 3))]}; b=${PANES[$((RANDOM % 3))]}; p=${PLACES[$((RANDOM % 5))]}
  move "{\"pane_id\":\"$a\",\"target_pane_id\":\"$b\",\"place\":\"$p\"}" || bad=$((bad+1))
  all_valid 3 >/dev/null || bad=$((bad+1))
done
expect "40 random moves keep one valid tree" "$bad" 0

$T tab rename "$TAB" Claude >/dev/null
new_tab() { $RPC call tab_create "{\"worktree_id\":\"$WT\",\"title\":\"$1\"}" | jq_ "print(d['id'])"; }
T2=$(new_tab App); T3=$(new_tab Terminal); sleep 0.5
step 5 "three tabs"
$RPC call tab_move "{\"tab_id\":\"$T3\",\"position\":1}" >/dev/null
expect "tab_move to the middle" "$(titles)" "Claude Terminal App"
$RPC call tab_move "{\"tab_id\":\"$T2\",\"position\":1}" >/dev/null
expect "scenario A: App between Claude and Terminal" "$(titles)" "Claude App Terminal"
$RPC call tab_move "{\"tab_id\":\"$TAB\",\"position\":99}" >/dev/null
expect "first tab to last (position clamps)" "$(titles)" "App Terminal Claude"
TABS=("$TAB" "$T2" "$T3")
for i in $(seq 1 25); do $RPC call tab_move "{\"tab_id\":\"${TABS[$((RANDOM % 3))]}\",\"position\":$((RANDOM % 4))}" >/dev/null; done
expect "rapid reorder keeps positions 0..n-1" "$(tabs | jq_ "print(sorted(t['position'] for t in d))")" "[0, 1, 2]"
$RPC call tab_move "{\"tab_id\":\"$T2\",\"position\":0}" >/dev/null
$RPC call tab_move "{\"tab_id\":\"$TAB\",\"position\":1}" >/dev/null
order=$(titles); layout=$(leaves "$TAB")
daemon_restart; sleep 1
expect "tab order survives a daemon restart" "$(titles)" "$order"
expect "moved layout survives a daemon restart" "$(leaves "$TAB")" "$layout"
step 5 "after restart"

Q2=$(leaves "$T2"); Q3=$(leaves "$T3")
move "{\"pane_id\":\"$P2\",\"tab_id\":\"$T2\",\"place\":\"right\"}"; step 5 "into another tab"
expect "drop on a tab adds the pane as a right split" "$(leaves "$T2")" "$Q2 $P2"
expect "the pane row follows" "$(tab_of "$P2")" "$T2"
expect "the destination tab becomes active" "$(active_tab)" "$T2"
move "{\"pane_id\":\"$P1\",\"target_pane_id\":\"$Q3\",\"place\":\"center\"}"; step 5 "center across tabs"
expect "center across tabs swaps tab membership" "$(tab_of "$P1") $(tab_of "$Q3")" "$T3 $TAB"
move "{\"pane_id\":\"$P1\",\"target_pane_id\":\"$P2\",\"place\":\"bottom\"}"; step 5 "last pane leaves its tab"
expect "the empty source tab closes" "$(leaves "$T3")" "gone"
expect "destination holds three panes" "$(leaves "$T2" | wc -w | tr -d ' ')" 3
rpc_code pane_move "{\"pane_id\":\"$Q3\",\"tab_id\":\"$T2\",\"place\":\"right\"}" conflict && pass "max_panes_per_tab blocks a move into a full tab" || fail "max panes"
move "{\"pane_id\":\"$Q3\",\"target_pane_id\":\"$Q2\",\"place\":\"center\"}"; step 5 "center swap into a full tab is allowed"

R2=$(new_repo); $T repo add "$R2" >/dev/null; WT2=$(wt_id "$R2")
X=$($T pane create --worktree "$WT2"); sleep 0.3
rpc_code pane_move "{\"pane_id\":\"$X\",\"target_pane_id\":\"$P2\",\"place\":\"left\"}" bad_request && pass "cross-worktree move is rejected" || fail "cross-worktree move"
step 5 "worktree unchanged after the rejected move"

H=$($T pane split "$P2" -- sh -c 'i=0; while [ $i -lt 20000 ]; do echo spam $i; i=$((i+1)); done; sleep 60')
bad=0
for p in left right top bottom center left top right bottom center; do
  move "{\"pane_id\":\"$H\",\"target_pane_id\":\"$Q3\",\"place\":\"$p\"}" || bad=$((bad+1))
  all_valid 6 >/dev/null || bad=$((bad+1))
done
expect "moves while a pane prints heavily" "$bad" 0
wait_for "tail_of $H 2 | grep -q 'spam 19999'" 40 && pass "pane_tail returns the newest lines" || fail "pane_tail heavy ($(tail_of "$H" 2))"

E=$($T pane create --worktree "$WT2" -- sh -c "printf '\033]0;t\007\033[1;32mready\033[0m on http://localhost:5173\r\n50%%\r100%%\r\n'; sleep 60")
wait_for "tail_of $E 8 | grep -q '100%'" 20
expect "pane_tail strips escapes and applies carriage returns" "$(tail_of "$E" 2)" '["ready on http://localhost:5173", "100%"]'
rpc_code pane_tail '{"pane_id":"nope"}' not_found && pass "pane_tail with a stale id is not_found" || fail "pane_tail stale id"

SPLIT=$(tabs | jq_ "print([t for t in d if t['id']=='$T2'][0]['layout']['id'])")
$RPC watch 3 tabs_changed > "$TOMO_DATA_DIR/resize-events" &
sleep 0.5
$RPC call layout_resize "{\"tab_id\":\"$T2\",\"split_id\":\"$SPLIT\",\"ratio\":0.5}" >/dev/null
wait
[ -s "$TOMO_DATA_DIR/resize-events" ] && pass "layout_resize emits tabs_changed" || fail "layout_resize emits tabs_changed"

daemon_stop
summary
