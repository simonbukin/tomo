#!/bin/bash
# Agent lifecycle torture with the fake agent. No model calls.
set -u
. "$(dirname "$0")/lib.sh"

daemon_fresh "[agents.claude]
command = \"$FIX/fake-agent\"
args = [\"--tomo\", \"$T\"]"
R=$(new_repo); $T repo add "$R" >/dev/null
WT=$(wt_id "$R")

agent_field() { $T agent list --json | jq_ "a=[x for x in d if x['pane_id']=='$1']; print(a[0]['$2'] if a else 'none')"; }
spawn() { $T agent spawn claude --worktree "$WT" --json | jq_ "print(d['pane']['id'])"; }

# 1. spawn -> SessionStart -> idle with a session ref
A=$(spawn)
wait_for "[ \"\$(agent_field $A state)\" = idle ]" 20 && check 0 "fake agent reports idle after SessionStart" || check 1 "spawn -> idle" "$(agent_field $A state)"
[ "$(agent_field $A session_ref)" != none ] && [ "$(agent_field $A session_ref)" != None ] && check 0 "session ref captured" || check 1 "session ref"
[ "$(agent_field $A authority)" = lifecycle ] && check 0 "authority is lifecycle" || check 1 "authority" "$(agent_field $A authority)"

# 2. working -> idle
$RPC send "$A" 'work 3\r'
wait_for "[ \"\$(agent_field $A state)\" = working ]" 6 && check 0 "UserPromptSubmit -> working" || check 1 "working" "$(agent_field $A state)"
wait_for "[ \"\$(agent_field $A state)\" = idle ]" 16 && check 0 "Stop -> idle" || check 1 "idle after work" "$(agent_field $A state)"

# 3. waiting + attention
$RPC send "$A" 'wait\r'
wait_for "[ \"\$(agent_field $A state)\" = waiting ]" 6 && check 0 "permission_prompt -> waiting" || check 1 "waiting" "$(agent_field $A state)"
$T attention list --json | jq_ "import sys; sys.exit(0 if any(i['pane_id']=='$A' and i['viewed_at_ms'] is None for i in d) else 1)" && check 0 "waiting creates an attention item" || check 1 "attention item"

# 3b. answering the agent resolves its waiting item and tells subscribers
WID=$($T attention list --json | jq_ "a=[i['id'] for i in d if i['pane_id']=='$A' and i['kind']=='waiting']; print(a[0] if a else 'none')")
EV=$(mktemp /tmp/tomo-harness-events.XXXX)
$RPC watch 20 attention_resolved > "$EV" & WATCH=$!
sleep 0.5
$RPC send "$A" 'work 3\r'
wait_for "[ \"\$(agent_field $A state)\" = working ]" 6 && check 0 "answered agent leaves waiting" || check 1 "waiting -> working" "$(agent_field $A state)"
$T attention list --json | jq_ "import sys; sys.exit(0 if '$WID' != 'none' and not any(i['id']=='$WID' for i in d) else 1)" && check 0 "leaving waiting resolves the waiting item" || check 1 "waiting item still listed" "$WID"
wait_for "grep -q '\"$WID\"' '$EV'" 6 && check 0 "subscribers get attention_resolved for the item" || check 1 "attention_resolved event" "$(cat "$EV")"
kill $WATCH 2>/dev/null; wait $WATCH 2>/dev/null; rm -f "$EV"
wait_for "[ \"\$(agent_field $A state)\" = idle ]" 16
$RPC send "$A" 'wait\r'
wait_for "[ \"\$(agent_field $A state)\" = waiting ]" 6 && check 0 "a second wait opens a new item" || check 1 "waiting again" "$(agent_field $A state)"

# 4. authority races through agent_report
now=$(python3 -c 'import time; print(int(time.time()*1000))')
$RPC call agent_report "{\"pane_id\":\"$A\",\"kind\":\"claude\",\"state\":\"working\",\"session_ref\":null,\"authority\":\"heuristic\",\"at_ms\":$now}" >/dev/null
[ "$(agent_field $A state)" = waiting ] && check 0 "heuristic working does not overwrite fresh lifecycle waiting" || check 1 "heuristic race" "$(agent_field $A state)"
$RPC call agent_report "{\"pane_id\":\"$A\",\"kind\":\"claude\",\"state\":\"idle\",\"session_ref\":null,\"authority\":\"lifecycle\",\"at_ms\":$((now - 600000))}" >/dev/null
[ "$(agent_field $A state)" = waiting ] && check 0 "old lifecycle event cannot rewind" || check 1 "stale lifecycle" "$(agent_field $A state)"
$RPC call agent_report "{\"pane_id\":\"$A\",\"kind\":\"claude\",\"state\":\"working\",\"session_ref\":null,\"authority\":\"heuristic\",\"at_ms\":$((now + 16*60*1000))}" >/dev/null
[ "$(agent_field $A state)" = working ] && check 0 "heuristic accepted once lifecycle is stale" || check 1 "stale threshold" "$(agent_field $A state)"
$RPC call agent_report "{\"pane_id\":\"$A\",\"kind\":\"claude\",\"state\":\"idle\",\"session_ref\":null,\"authority\":\"lifecycle\",\"at_ms\":$((now + 17*60*1000))}" >/dev/null

# 5. two same-kind agents in one worktree are independent
B=$(spawn)
wait_for "[ \"\$(agent_field $B state)\" = idle ]" 20 || true
$RPC send "$B" 'work 4\r'
wait_for "[ \"\$(agent_field $B state)\" = working ]" 6
[ "$(agent_field $B state)" = working ] && [ "$(agent_field $A state)" = idle ] && check 0 "two agents tracked per pane" || check 1 "two agents" "A=$(agent_field $A state) B=$(agent_field $B state)"
wait_for "[ \"\$(agent_field $B state)\" = idle ]" 16

# 6. resume after daemon restart keeps the session ref
SESS=$(agent_field $A session_ref)
daemon_restart; sleep 8
$T pane list --json | jq_ "import sys; p=[x for x in d if x['id']=='$A']; sys.exit(0 if p and p[0]['origin']=='resumed' else 1)" && check 0 "agent pane comes back as resumed" || check 1 "resumed origin"
wait_for "[ \"\$(agent_field $A state)\" = idle ]" 20 && [ "$(agent_field $A session_ref)" = "$SESS" ] && check 0 "resumed fake agent reports the same session" || check 1 "resume session" "$(agent_field $A session_ref) vs $SESS"

# 7. exit detection
$RPC send "$A" 'quit\r'
wait_for "[ \"\$(agent_field $A state)\" = exited ] || [ \"\$(agent_field $A state)\" = none ]" 12 && check 0 "quit -> exited (or pane closed on exit 0)" || check 1 "exit detection" "$(agent_field $A state)"

daemon_stop
summary
