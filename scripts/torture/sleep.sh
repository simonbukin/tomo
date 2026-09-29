#!/bin/bash
# Sleeping agents (docs/sleeping-agents.md) with the fake Claude provider and a 3 s idle period: an idle agent
# sleeps, input that was not sent, a child process, or a pane on screen keeps it awake, `tomo pane wake` and
# `tomo pane send` resume the same session, a sleeping pane stays asleep through a restart
# and a cold restart, and an agent that ignores SIGTERM stays awake.
set -u
. "$(dirname "$0")/lib.sh"

NODE=$(command -v node) || { known "node is not installed: the provider fixture cannot run"; summary; exit 0; }
FAKE="$FIX/fake-provider"
export TOMO_SLEEP_AFTER_MS=3000
daemon_fresh "$(printf '[agents.claude]\ncommand = "%s"\nargs = ["%s", "claude"]\n' "$NODE" "$FAKE")"
R=$(new_repo); $T repo add "$R" >/dev/null
WT=$(wt_id "$R")
$RPC events 900 >/dev/null 2>&1 & SUBSCRIBER=$!

agent_field() { $T agent list --json | jq_ "a=[x for x in d if x['pane_id']=='$1']; print(a[0].get('$2') if a else 'none')"; }
pane_field() { $T pane list --json | jq_ "p=[x for x in d if x['id']=='$1']; print(p[0]['$2'] if p else 'none')"; }
phase() { $T agent list --json | jq_ "a=[x for x in d if x['pane_id']=='$1']; print((a[0].get('sleep') or 'awake') if a else 'none')"; }
spawn() { $RPC call agent_spawn "{\"kind\":\"claude\",\"worktree_id\":\"$WT\",\"cwd\":null,\"tab_id\":null,\"split_from\":null,\"resume\":null,\"new_tab\":true,\"extra_args\":[]}" | jq_ "print(d['pane']['id'])"; }
state_is() { wait_for "[ \"\$(agent_field $1 state)\" = $2 ]" "${3:-20}"; }
phase_is() { wait_for "[ \"\$(phase $1)\" = $2 ]" "${3:-30}"; }
screen() { $RPC attach "$1" 0.5; }
agent_pid() { wait_for "$T ps >/dev/null; [ \"\$(agent_field $1 pid)\" != None ]" 10; agent_field "$1" pid | grep -v None; }
diagnosed() { $RPC call diagnostics_list '{"limit":200}' | grep -qF -- "$1"; }

# Every agent starts and is idle; all but DRAFT finish a turn and are done. Then only the rule under test differs.
A=$(spawn); DRAFT=$(spawn); CHILD=$(spawn); SHOWN=$(spawn); STUBBORN=$(spawn)
for p in $A $DRAFT $CHILD $SHOWN $STUBBORN; do state_is "$p" idle; done
S=$(agent_field "$A" session_ref)
A_PID=$(agent_pid "$A"); CHILD_PID=$(agent_pid "$CHILD"); STUBBORN_PID=$(agent_pid "$STUBBORN")
$RPC send "$DRAFT" 'half a prompt'
$RPC send "$CHILD" 'child\r'
$RPC send "$STUBBORN" 'ignore-term\r'
[ -n "$A_PID" ] && [ -n "$CHILD_PID" ] && [ -n "$STUBBORN_PID" ] && check 0 "five fake agents start and reach idle" || { check 1 "fake agents" "$A_PID $CHILD_PID $STUBBORN_PID"; daemon_stop; summary; exit 1; }
$RPC attach "$SHOWN" 16 >/dev/null & SHOWING=$!
for p in $A $CHILD $SHOWN $STUBBORN; do $RPC send "$p" 'work 1\r'; done
for p in $A $CHILD $SHOWN $STUBBORN; do state_is "$p" done; done

# 1. the idle period ends: the agent process ends, the done mark stays, and the snapshot holds the screen
phase_is "$A" asleep && check 0 "an idle agent sleeps after the idle period" || check 1 "sleep after idle" "$(phase "$A")"
wait_for "! kill -0 $A_PID" 10 && check 0 "the sleep ends the agent process" || check 1 "agent process after sleep" "pid $A_PID"
[ "$(agent_field "$A" state)" = done ] && check 0 "a done agent sleeps and keeps its done mark" || check 1 "state while asleep" "$(agent_field "$A" state)"
[ "$(pane_field "$A" live)" = True ] && check 0 "the pane's shell stays live" || check 1 "pane live while asleep"
$RPC call pane_snapshot "{\"pane_id\":\"$A\"}" | jq_ "import base64; print(base64.b64decode(d['data_base64']).decode('utf8','replace'))" | grep -qF "fake-provider claude session $S" \
  && check 0 "the snapshot holds the terminal of the agent" || check 1 "snapshot content"
[ -s "$TOMO_DATA_DIR/scrollback/$A.snapshot" ] && check 0 "the snapshot is saved in the data dir" || check 1 "snapshot file"
$RPC call activity_list '{"limit":200}' | grep -q "Claude exited" && check 1 "a sleep records no exit" || check 0 "a sleep records no exit"

# 2. the rules that keep an agent awake
[ "$(phase "$DRAFT")" = awake ] && [ "$(agent_field "$DRAFT" state)" = idle ] && check 0 "input that was not sent keeps the agent awake" || check 1 "draft" "$(phase "$DRAFT")"
[ "$(phase "$CHILD")" = awake ] && [ "$(agent_field "$CHILD" state)" = done ] && check 0 "a child process keeps the agent awake" || check 1 "child" "$(phase "$CHILD")"
$T pane sleep "$CHILD" 2>&1 | grep -q "child process" && check 0 "tomo pane sleep refuses an agent with a child process" || check 1 "pane sleep with a child"
[ "$(phase "$SHOWN")" = awake ] && [ "$(agent_field "$SHOWN" state)" = done ] && check 0 "a pane on screen stays awake" || check 1 "on screen" "$(phase "$SHOWN")"
wait "$SHOWING"
phase_is "$SHOWN" asleep && check 0 "the pane sleeps once no client shows it" || check 1 "off screen" "$(phase "$SHOWN")"

# 3. an agent that ignores SIGTERM: the sleep is cancelled after 5 s, and no SIGKILL
wait_for "diagnosed 'pane $STUBBORN: the agent did not end 5 s after SIGTERM'" 40 && check 0 "an ignored SIGTERM cancels the sleep" || check 1 "cancelled sleep"
phase_is "$STUBBORN" awake 4 && kill -0 "$STUBBORN_PID" && check 0 "the agent that ignored SIGTERM still runs, awake" || check 1 "after cancel" "$(phase "$STUBBORN") pid $STUBBORN_PID"
[ ! -e "$TOMO_DATA_DIR/scrollback/$STUBBORN.snapshot" ] && check 0 "a cancelled sleep leaves no snapshot" || check 1 "snapshot after cancel"
$T pane keep-awake "$STUBBORN"
[ "$(pane_field "$STUBBORN" keep_awake)" = True ] && check 0 "keep awake is saved on the pane" || check 1 "keep awake flag"

# 4. tomo pane wake resumes the same session with no model flag
T0=$(python3 -c "import time; print(time.time())")
$T pane wake "$A"
phase_is "$A" awake 30 && check 0 "tomo pane wake wakes the agent" || check 1 "wake" "$(phase "$A")"
echo "wake to first hook: $(python3 -c "import time; print(round(time.time() - $T0, 2))") s"
state_is "$A" idle && [ "$(agent_field "$A" session_ref)" = "$S" ] && check 0 "the woken agent reports the same session" || check 1 "session after wake" "$(agent_field "$A" session_ref)"
screen "$A" | grep "fake-provider claude session $S" | grep -F -- "--resume $S" | grep -qv -- "--model" && check 0 "the wake types the resume line with no model flag" || check 1 "resume line" "$(screen "$A" | grep 'argv:' | tail -1)"

# 5. text sent to a sleeping pane wakes it and reaches the agent after its first hook
A_PID=$(agent_pid "$A")
$T pane sleep "$A" && phase_is "$A" asleep 10 && check 0 "tomo pane sleep puts an idle agent to sleep" || check 1 "pane sleep" "$(phase "$A")"
wait_for "! kill -0 $A_PID" 10
$T pane send "work 1" --pane "$A"
state_is "$A" working 30 && state_is "$A" done 15 && check 0 "text sent to a sleeping pane runs in the woken agent" || check 1 "send wakes" "$(agent_field "$A" state) $(phase "$A")"

# 6. a sleeping pane stays asleep through a restart and a cold restart, and no resume line is typed
A_PID=$(agent_pid "$A")
$T pane sleep "$A"; phase_is "$A" asleep 10
wait_for "! kill -0 $A_PID" 10
daemon_restart
$RPC events 900 >/dev/null 2>&1 & SUBSCRIBER2=$!
[ "$(phase "$A")" = asleep ] && check 0 "a sleeping pane is asleep after a restart" || check 1 "asleep after restart" "$(phase "$A")"
daemon_restart_cold; sleep 4
$RPC events 900 >/dev/null 2>&1 & SUBSCRIBER3=$!
[ "$(phase "$A")" = asleep ] && [ "$(pane_field "$A" origin)" = restored ] && check 0 "a sleeping pane is asleep after a cold restart" || check 1 "asleep after cold restart" "$(phase "$A") $(pane_field "$A" origin)"
$T ps >/dev/null; [ "$(pane_field "$A" process_cmd)" = None ] && check 0 "a cold restart types no resume line into a sleeping pane" || check 1 "resumed while asleep"
$RPC call pane_snapshot "{\"pane_id\":\"$A\"}" >/dev/null && check 0 "the snapshot survives a cold restart" || check 1 "snapshot after cold restart"
$T pane wake "$A"
state_is "$A" idle 30 && [ "$(phase "$A")" = awake ] && [ "$(agent_field "$A" session_ref)" = "$S" ] && check 0 "a wake after a cold restart resumes the session" || check 1 "wake after cold restart" "$(phase "$A")"

kill "$SUBSCRIBER" "$SUBSCRIBER2" "$SUBSCRIBER3" 2>/dev/null
kill "$STUBBORN_PID" 2>/dev/null; pkill -P "$CHILD_PID" sleep 2>/dev/null
daemon_stop
summary
