#!/bin/bash
# Agentation through the raw socket: annotations_send from a browser pane to a fake agent. No GUI.
set -u
. "$(dirname "$0")/lib.sh"

daemon_fresh "[agents.claude]
command = \"$FIX/fake-agent\"
args = [\"--tomo\", \"$T\"]"
R=$(new_repo); $T repo add "$R" >/dev/null
WT=$(wt_id "$R")
B=$($T browser open "$WT" --url http://localhost:1420); sleep 0.3

# 1. evidence to a fake agent
A=$($T agent spawn claude --worktree "$WT" --json | jq_ "print(d['pane']['id'])")
wait_for "[ \"\$($T agent list --json | jq_ \"a=[x for x in d if x['pane_id']=='$A']; print(a[0]['state'] if a else 'none')\")\" = idle ]" 20
BUNDLE="{\"source\":\"browser annotation\",\"worktree_id\":\"$WT\",\"url\":\"http://localhost:1420/\",\"action_id\":null,\"instruction\":\"Review and address these annotations.\",\"annotations\":[{\"text\":\"wrong color\",\"url\":\"http://localhost:1420/\",\"selector\":\"#save\",\"element_text\":\"Save\",\"rect\":[1,2,3,4]},{\"text\":\"cut off\",\"url\":\"http://localhost:1420/\",\"selector\":\"main > p:nth-of-type(2)\",\"element_text\":\"Hello\",\"rect\":null}]}"
EV=$($RPC call annotations_send "{\"pane_id\":\"$A\",\"bundle\":$BUNDLE}")
echo "$EV" | jq_ "import sys; sys.exit(0 if d['kind']=='annotations_sent' and d['title']=='Sent 2 annotations → Claude' else 1)" && check 0 "annotations_send records an activity event" || check 1 "activity event" "$EV"
sleep 1
o=$($RPC attach "$A" 2)
case "$o" in *"Browser feedback from Tomo"*"[#save] \"Save\" — wrong color"*) check 0 "the evidence text arrives in the agent pane";; *) check 1 "evidence text" "$(echo "$o" | tail -c 200)";; esac
MD_BUNDLE="{\"source\":\"browser feedback\",\"worktree_id\":\"$WT\",\"url\":\"http://localhost:1420/\",\"action_id\":null,\"instruction\":\"Review and address this feedback.\",\"annotations\":[],\"markdown\":\"## Tomo (http://localhost:1420/)\\n\\n1. button \`main > button\`\\n   too dim\",\"note_count\":3}"
EV=$($RPC call annotations_send "{\"pane_id\":\"$A\",\"bundle\":$MD_BUNDLE}")
echo "$EV" | jq_ "import sys; sys.exit(0 if d['title']=='Sent 3 notes → Claude' else 1)" && check 0 "a markdown bundle is titled by its note count" || check 1 "markdown title" "$EV"
sleep 1
o=$($RPC attach "$A" 2)
case "$o" in *"1. button \`main > button\`"*"too dim"*) check 0 "the markdown body arrives in the agent pane";; *) check 1 "markdown body" "$(echo "$o" | tail -c 200)";; esac
$RPC call annotations_send "{\"pane_id\":\"$B\",\"bundle\":$BUNDLE}" 2>&1 | grep -q bad_request && check 0 "annotations_send refuses a pane without an agent" || check 1 "annotations guard"

daemon_stop
summary
