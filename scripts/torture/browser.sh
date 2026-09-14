#!/bin/bash
# Browser panes through the CLI and the raw socket: open, navigate, restore, close, and evidence to a fake agent. No GUI.
set -u
. "$(dirname "$0")/lib.sh"

daemon_fresh "[agents.claude]
command = \"$FIX/fake-agent\"
args = [\"--tomo\", \"$T\"]"
R=$(new_repo); $T repo add "$R" >/dev/null
WT=$(wt_id "$R")

pane_field() { $T pane list --json | jq_ "p=[x for x in d if x['id']=='$1']; print(p[0]['$2'] if p else 'none')"; }
tab_title() { $T tab list "$WT" --json | jq_ "t=[x for x in d if x['id']=='$1']; print(t[0]['title'] if t else 'none')"; }

# 1. open: a browser pane in a new tab titled Browser, live, no pid
B=$($T browser open "$WT" --url http://localhost:1420); sleep 0.3
[ "$(pane_field "$B" kind)" = browser ] && check 0 "browser open creates a browser pane" || check 1 "browser open" "$(pane_field "$B" kind)"
[ "$(pane_field "$B" url)" = "http://localhost:1420" ] && check 0 "pane carries the url" || check 1 "pane url" "$(pane_field "$B" url)"
[ "$(pane_field "$B" live)" = True ] && [ "$(pane_field "$B" pid)" = None ] && check 0 "browser pane is live without a pid" || check 1 "live/pid" "$(pane_field "$B" live) $(pane_field "$B" pid)"
TAB=$(pane_field "$B" tab_id)
[ "$(tab_title "$TAB")" = Browser ] && check 0 "new tab is titled Browser" || check 1 "tab title" "$(tab_title "$TAB")"
D=$($T browser open "$WT"); sleep 0.3
[ "$(pane_field "$D" url)" = "about:blank" ] && check 0 "open without --url defaults to about:blank" || check 1 "default url" "$(pane_field "$D" url)"
$T pane close "$D" >/dev/null

# 2. terminal calls are refused on a browser pane
$RPC send "$B" 'x' 2>&1 | grep -q bad_request && check 0 "pane_send on a browser pane is a bad request" || check 1 "pane_send guard"
$RPC call pane_resize "{\"pane_id\":\"$B\",\"cols\":10,\"rows\":10}" 2>&1 | grep -q bad_request && check 0 "pane_resize on a browser pane is a bad request" || check 1 "pane_resize guard"
$RPC call pane_attach "{\"pane_id\":\"$B\"}" 2>&1 | grep -q bad_request && check 0 "pane_attach on a browser pane is a bad request" || check 1 "pane_attach guard"
$T ps --worktree "$WT" >/dev/null && check 0 "process monitor tolerates a browser pane" || check 1 "ps with browser pane"

# 3. navigate persists
$RPC call browser_navigate "{\"pane_id\":\"$B\",\"url\":\"http://localhost:1420/#ui-torture\"}" >/dev/null
[ "$(pane_field "$B" url)" = "http://localhost:1420/#ui-torture" ] && check 0 "browser_navigate persists the url" || check 1 "navigate" "$(pane_field "$B" url)"
P=$($T pane create --worktree "$WT"); sleep 0.5
$RPC call browser_navigate "{\"pane_id\":\"$P\",\"url\":\"http://x\"}" 2>&1 | grep -q bad_request && check 0 "browser_navigate refuses a terminal pane" || check 1 "navigate guard"

# 4. restore keeps the browser pane and its url
daemon_restart; sleep 2
[ "$(pane_field "$B" kind)" = browser ] && [ "$(pane_field "$B" url)" = "http://localhost:1420/#ui-torture" ] && check 0 "restart restores the browser pane with its url" || check 1 "restore" "$(pane_field "$B" kind) $(pane_field "$B" url)"
[ "$(pane_field "$B" live)" = True ] && check 0 "restored browser pane is live" || check 1 "restored live"

# 5. evidence to a fake agent
A=$($T agent spawn claude --worktree "$WT" --json | jq_ "print(d['pane']['id'])")
wait_for "[ \"\$($T agent list --json | jq_ \"a=[x for x in d if x['pane_id']=='$A']; print(a[0]['state'] if a else 'none')\")\" = idle ]" 20
BUNDLE="{\"source\":\"browser annotation\",\"worktree_id\":\"$WT\",\"url\":\"http://localhost:1420/\",\"action_id\":null,\"instruction\":\"Review and address these annotations.\",\"annotations\":[{\"text\":\"wrong color\",\"url\":\"http://localhost:1420/\",\"selector\":\"#save\",\"element_text\":\"Save\",\"rect\":[1,2,3,4]},{\"text\":\"cut off\",\"url\":\"http://localhost:1420/\",\"selector\":\"main > p:nth-of-type(2)\",\"element_text\":\"Hello\",\"rect\":null}]}"
EV=$($RPC call annotations_send "{\"pane_id\":\"$A\",\"bundle\":$BUNDLE}")
echo "$EV" | jq_ "import sys; sys.exit(0 if d['kind']=='annotations_sent' and d['title']=='Sent 2 annotations → Claude' else 1)" && check 0 "annotations_send records an activity event" || check 1 "activity event" "$EV"
sleep 1
o=$($RPC attach "$A" 2)
case "$o" in *"Browser annotations from Tomo"*"[#save] \"Save\" — wrong color"*) check 0 "the evidence text arrives in the agent pane";; *) check 1 "evidence text" "$(echo "$o" | tail -c 200)";; esac
$RPC call annotations_send "{\"pane_id\":\"$B\",\"bundle\":$BUNDLE}" 2>&1 | grep -q bad_request && check 0 "annotations_send refuses a pane without an agent" || check 1 "annotations guard"

# 6. close
$T pane close "$B" >/dev/null
[ "$(pane_field "$B" kind)" = none ] && check 0 "browser pane closes" || check 1 "close"

daemon_stop
summary
