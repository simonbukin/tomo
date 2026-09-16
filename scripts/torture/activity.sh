#!/bin/bash
# Activity stream: what gets recorded, in what order, what needs me, and what resolves.
set -u
. "$(dirname "$0")/lib.sh"

daemon_fresh "[agents.claude]
command = \"$FIX/fake-agent\"
args = [\"--tomo\", \"$T\"]"
R=$(new_repo); $T repo add "$R" >/dev/null
read -r WT P < <($T worktree create --repo "$R" --branch feat/activity --new --json | jq_ "print(d[0]['id'], d[0]['path'])")
printf '%s\n' '[[actions]]
id = "serve"
label = "Serve"
command = "sleep 30"

[[actions]]
id = "crash"
label = "Crashy"
command = "exit 2"' > "$P/.tomo.toml"
wait_for "[ \"\$($T action list $WT --json | jq_ \"print(len(d['actions']))\")\" = 2 ]" 6

act() { $T activity --json "$@"; }
kinds() { act "$@" | jq_ "print(' '.join(e['kind'] for e in d))"; }
has_kind() { act | jq_ "import sys; sys.exit(0 if any(e['kind']=='$1' for e in d) else 1)"; }
field() { act | jq_ "m=[e for e in d if e['kind']=='$1']; print(m[0]['$2'] if m else 'none')"; }
agent_field() { $T agent list --json | jq_ "a=[x for x in d if x['pane_id']=='$1']; print(a[0]['$2'] if a else 'none')"; }

# 1. action start
$T action run serve "$WT" >/dev/null
wait_for "has_kind action_started" 4 && [ "$(field action_started title)" = "Serve started" ] && check 0 "action run records ActionStarted" || check 1 "action started" "$(kinds)"

# 2. agent spawn
A=$($T agent spawn claude --worktree "$WT" --json | jq_ "print(d['pane']['id'])")
wait_for "[ \"\$(agent_field $A state)\" = idle ]" 20
has_kind agent_started && [ "$(field agent_started pane_id)" = "$A" ] && [ "$(field agent_started agent_kind)" = claude ] && check 0 "agent spawn records AgentStarted with pane and kind" || check 1 "agent started" "$(act | head -20)"

# 3. agent waiting points at its attention item
$RPC send "$A" 'wait\r'
wait_for "has_kind agent_waiting" 8 && check 0 "waiting records AgentWaiting" || check 1 "agent waiting" "$(kinds)"
AID=$(field agent_waiting attention_id)
$T attention list --json | jq_ "import sys; sys.exit(0 if any(a['id']=='$AID' and a['pane_id']=='$A' and a['kind']=='waiting' for a in d) else 1)" && check 0 "AgentWaiting.attention_id points at the waiting item" || check 1 "waiting attention id" "$AID"
[ "$(kinds --needs-me)" = "agent_waiting" ] && check 0 "unviewed waiting item needs me" || check 1 "needs-me waiting" "$(kinds --needs-me)"
$RPC call attention_view "{\"id\":\"$AID\"}" >/dev/null
[ "$(kinds --needs-me)" = "" ] && check 0 "a viewed waiting item no longer needs me" || check 1 "needs-me after view" "$(kinds --needs-me)"

# 4. checkpoint from inside a pane infers worktree and pane from the environment
X=$($T pane create --worktree "$WT"); sleep 1.5
$RPC send "$X" "$T checkpoint \"Review me\" --url http://localhost:1\r"
wait_for "has_kind checkpoint_created" 12 && check 0 "tomo checkpoint inside a pane records CheckpointCreated" || check 1 "checkpoint" "$($RPC attach "$X" 1 | tail -5)"
[ "$(field checkpoint_created worktree_id)" = "$WT" ] && [ "$(field checkpoint_created pane_id)" = "$X" ] && [ "$(field checkpoint_created title)" = "Review me" ] && check 0 "checkpoint carries the pane's worktree, pane, and message" || check 1 "checkpoint fields" "$(act | head -20)"
CK=$(field checkpoint_created attention_id)
$T attention list --json | jq_ "import sys; sys.exit(0 if any(a['id']=='$CK' and a['kind']=='checkpoint' and a['url']=='http://localhost:1' and a['level']=='attention' for a in d) else 1)" && check 0 "checkpoint attention item has kind checkpoint and the url" || check 1 "checkpoint attention" "$($T attention list)"

# 5. crash, stop, exit, state, archive
$T action run crash "$WT" >/dev/null
wait_for "has_kind action_crashed" 10 && [ "$(field action_crashed detail)" = "exit code 2" ] && check 0 "exit 2 records ActionCrashed" || check 1 "crashed" "$(kinds)"
$T action stop serve "$WT" >/dev/null
wait_for "has_kind action_stopped" 4 && check 0 "action stop records ActionStopped" || check 1 "stopped" "$(kinds)"
$RPC send "$A" 'quit\r'
wait_for "has_kind agent_exited" 12 && check 0 "quit records AgentExited" || check 1 "agent exited" "$(kinds)"
$T worktree metadata set "$WT" --state active >/dev/null
[ "$(field state_changed title)" = "state → active" ] && check 0 "state change records 'state → active'" || check 1 "state changed" "$(field state_changed title)"
$T worktree archive "$WT" >/dev/null 2>&1
wait_for "has_kind archived" 6 && check 0 "archive records Archived" || check 1 "archived" "$(kinds)"

# 6. shape of the stream
act | python3 -c "
import json, sys
d = json.load(sys.stdin)
ts = [e['occurred_at_ms'] for e in d]
allowed = {'action_started','agent_started','agent_waiting','checkpoint_created','action_crashed','action_stopped','agent_exited','state_changed','archived'}
kinds = {e['kind'] for e in d}
sys.exit(0 if ts == sorted(ts, reverse=True) and kinds == allowed and all(e['worktree_id']=='$WT' for e in d) else 1)
" && check 0 "stream is newest first, only the listed kinds, no pane noise" || check 1 "stream shape" "$(kinds)"
[ "$(act)" = "$(act)" ] && check 0 "two reads give the same order" || check 1 "stable order"
[ "$(kinds --limit 2 | wc -w | tr -d ' ')" = 2 ] && [ "$(kinds --worktree "$WT")" = "$(kinds)" ] && check 0 "--limit and --worktree filter" || check 1 "filters" "$(kinds --limit 2)"
$T activity | grep -Eq '^[0-9]{2}:[0-9]{2}  Crashy crashed · exit code 2$' && check 0 "text output is HH:MM  title · detail" || check 1 "text output" "$($T activity | head -3)"
[ "$(kinds --needs-me)" = "action_crashed checkpoint_created" ] && check 0 "--needs-me lists only the crash and the checkpoint" || check 1 "needs-me" "$(kinds --needs-me)"

# 7. resolve
$T checkpoint resolve "$CK" >/dev/null && check 0 "checkpoint resolve succeeds" || check 1 "resolve"
[ "$(kinds --needs-me)" = "action_crashed" ] && [ "$(kinds | cut -d' ' -f1)" = checkpoint_resolved ] && check 0 "resolve leaves needs-me and adds CheckpointResolved on top" || check 1 "after resolve" "$(kinds --needs-me) / $(kinds | cut -d' ' -f1)"
[ "$(field checkpoint_resolved attention_id)" = "$CK" ] && check 0 "CheckpointResolved points at the same item" || check 1 "resolved id"
$T attention list --json | jq_ "import sys; sys.exit(0 if not any(a['id']=='$CK' for a in d) else 1)" && check 0 "resolved checkpoint leaves the attention list" || check 1 "attention after resolve"
$T checkpoint resolve "$CK" >/dev/null && [ "$(kinds | grep -o checkpoint_resolved | wc -l | tr -d ' ')" = 1 ] && check 0 "resolving twice is idempotent" || check 1 "double resolve"
$T checkpoint resolve nope >/dev/null 2>&1 && check 1 "unknown id accepted" || check 0 "unknown id is an error"

daemon_stop
summary
