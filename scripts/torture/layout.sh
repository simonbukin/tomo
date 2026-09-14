#!/bin/bash
# Layout torture through the CLI: every step must leave a valid split tree.
set -u
. "$(dirname "$0")/lib.sh"

daemon_fresh
R=$(new_repo); $T repo add "$R" >/dev/null
WT=$(wt_id "$R")
P1=$($T pane create --worktree "$WT"); sleep 0.5
TAB=$($T pane list --json | jq_ "print([p for p in d if p['id']=='$P1'][0]['tab_id'])")

valid() { $T tab list "$WT" --json | python3 "$ROOT/scripts/torture/layout_check.py" "$TAB" "$1"; }
step() { local n="$1"; shift; local why; if why=$(valid "$n" 2>&1); then pass "$* -> $why"; else fail "$* ($why)"; fi; }

P2=$($T pane split "$P1" --right); step 2 "split right"
P3=$($T pane split "$P2" --down); step 3 "split down"
P4=$($T pane split "$P3" --right); step 4 "split right again"
P5=$($T pane split "$P1" --down); step 5 "split down from first"
$T pane swap "$P1" "$P4" >/dev/null; step 5 "swap"
$T tab equalize "$TAB" >/dev/null; step 5 "equalize"
$T tab list "$WT" --json | jq_ "
t=[x for x in d if x['id']=='$TAB'][0]
def ratios(n): return [] if n['type']=='leaf' else [n['ratio']]+ratios(n['first'])+ratios(n['second'])
import sys; sys.exit(0 if all(abs(r-0.5)<1e-9 or abs(r-1/3)<1e-9 or abs(r-2/3)<1e-9 or abs(r-0.25)<1e-9 or abs(r-0.4)<1e-9 for r in ratios(t['layout'])) else 1)" && pass "equalize ratios are leaf-count fractions" || fail "equalize ratios"
$T pane focus "$P3" >/dev/null; $T tab rotate "$TAB" >/dev/null; step 5 "rotate around focused pane"
$RPC call layout_resize "{\"tab_id\":\"$TAB\",\"split_id\":\"nope\",\"ratio\":0.99}" >/dev/null; step 5 "resize unknown split is a no-op"
$T pane close "$P4" --force >/dev/null; step 4 "close a pane"
$T pane close "$P1" --force >/dev/null; step 3 "close another"
$T pane swap "$P2" "$P5" >/dev/null; step 3 "swap after removals"
$T tab equalize "$TAB" >/dev/null; step 3 "equalize after removals"
$T pane close "$P2" --force >/dev/null; $T pane close "$P3" --force >/dev/null; step 1 "down to one pane"

# degenerate layouts are avoided for agent spawns: after max_panes_per_tab, a new tab appears
daemon_fresh "max_panes_per_tab = 3
[agents.claude]
command = \"$FIX/fake-agent\"
args = [\"--tomo\", \"$T\"]"
R=$(new_repo); $T repo add "$R" >/dev/null; WT=$(wt_id "$R")
for i in 1 2 3 4 5; do $T agent spawn claude --worktree "$WT" >/dev/null; done; sleep 1
tabs=$($T tab list "$WT" --json | jq_ "print(len(d))")
[ "$tabs" -ge 2 ] && pass "5 spawns with max_panes_per_tab=3 use $tabs tabs" || fail "layout policy" "$tabs tabs"

daemon_stop
summary
