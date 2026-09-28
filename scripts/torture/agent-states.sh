#!/bin/bash
# Agent states (docs/agent-states.md): hook events drive one pane's state over the socket, with no real agent.
# A turn ends done, seen turns it idle, idle_prompt ends an interrupted turn, an older hook cannot undo a newer
# one, the state survives a restart, and a Stop that fires while no daemon runs is replayed from the spool.
set -u
. "$(dirname "$0")/lib.sh"

daemon_fresh 'shell = "/bin/sh"'
R=$(new_repo); $T repo add "$R" >/dev/null
WT=$($T worktree list --json | jq_ "print(d[0]['id'])")
P=$($T pane create --worktree "$WT" --json -- /bin/sh -c "sleep 600" | jq_ "print(d['pane']['id'])")
state() { $T agent list --json | jq_ "a=[a for a in d if a['pane_id']=='$P']; print(a[0]['state'] if a else 'none')"; }
hook() { $RPC call agent_hook "{\"kind\":\"claude\",\"pane_id\":\"$P\",\"at_ms\":$2,\"payload\":$1}" >/dev/null; }
ev() { printf '{"hook_event_name":"%s","session_id":"s1"%s}' "$1" "${2:-}"; }
NOW=$(python3 -c "import time; print(int(time.time()*1000))")

hook "$(ev SessionStart)" $((NOW + 1)); [ "$(state)" = idle ] && check 0 "SessionStart is idle" || check 1 "start" "$(state)"
hook "$(ev UserPromptSubmit)" $((NOW + 2)); [ "$(state)" = working ] && check 0 "a prompt is working" || check 1 "prompt" "$(state)"
hook "$(ev Stop)" $((NOW + 3)); [ "$(state)" = done ] && check 0 "Stop is done" || check 1 "stop" "$(state)"
$RPC call agent_seen "{\"pane_id\":\"$P\"}" >/dev/null; [ "$(state)" = idle ] && check 0 "seeing a done pane makes it idle" || check 1 "seen" "$(state)"

# an interrupt sends no Stop; idle_prompt ends the turn, but never a done one
hook "$(ev UserPromptSubmit)" $((NOW + 4))
hook "$(ev Notification ',"notification_type":"idle_prompt"')" $((NOW + 5))
[ "$(state)" = idle ] && check 0 "idle_prompt ends an interrupted turn" || check 1 "idle_prompt" "$(state)"
hook "$(ev UserPromptSubmit)" $((NOW + 6)); hook "$(ev Stop)" $((NOW + 7))
hook "$(ev Notification ',"notification_type":"idle_prompt"')" $((NOW + 8))
[ "$(state)" = done ] && check 0 "idle_prompt leaves a done turn done" || check 1 "idle_prompt on done" "$(state)"

# hook processes can land in reverse order: the event that fired last wins
hook "$(ev UserPromptSubmit)" $((NOW + 20)); hook "$(ev Stop)" $((NOW + 22)); hook "$(ev PostToolUse)" $((NOW + 21))
[ "$(state)" = done ] && check 0 "an older PostToolUse cannot undo a newer Stop" || check 1 "order" "$(state)"

# a restart keeps the state: the holder keeps the pane, and the saved state comes back
$RPC call agent_seen "{\"pane_id\":\"$P\"}" >/dev/null
$T daemon stop >/dev/null; sleep 0.5; $T daemon start >/dev/null
[ "$(state)" = idle ] && check 0 "an idle agent is idle after a restart, not unknown" || check 1 "saved state" "$(state)"

# a turn that starts and ends while no daemon runs: tomo hook spools it, the next daemon replays it
hook "$(ev UserPromptSubmit)" $(($(python3 -c "import time; print(int(time.time()*1000))")))
$T daemon stop >/dev/null; sleep 0.5
printf '%s' "$(ev Stop)" | TOMO_PANE_ID="$P" $T hook claude
[ -s "$TOMO_DATA_DIR/hook-spool.jsonl" ] && check 0 "tomo hook spools an event when no daemon runs" || check 1 "spool written"
$T daemon start >/dev/null; sleep 0.5
[ "$(state)" = done ] && check 0 "the replayed Stop ends the turn after the restart" || check 1 "replay" "$(state)"
[ ! -e "$TOMO_DATA_DIR/hook-spool.jsonl" ] && [ ! -e "$TOMO_DATA_DIR/hook-spool.replaying" ] && check 0 "the replayed spool is gone" || check 1 "spool left"

daemon_stop
summary
