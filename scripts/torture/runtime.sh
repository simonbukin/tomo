#!/bin/bash
# Runtime endpoints and crash matrix: discovery, attribution, isolation, restart debounce, crash vs stop vs completion.
set -u
. "$(dirname "$0")/lib.sh"

EVLOG=/tmp/tomo-harness-runtime-events.log; rm -f "$EVLOG"
HOOK="printf '%s\\\\n' \\\"\$TOMO_EVENT_JSON\\\" >> $EVLOG"
daemon_fresh "[[hooks]]
event = \"runtime.endpoint_discovered\"
command = \"$HOOK\"

[[hooks]]
event = \"runtime.endpoint_removed\"
command = \"$HOOK\"

[[hooks]]
event = \"action.crashed\"
command = \"$HOOK\""
$T config check >/dev/null 2>&1 && check 0 "config check accepts runtime.* and action.crashed hooks" || check 1 "config check" "$($T config check 2>&1 | tail -3)"
R=$(new_repo); $T repo add "$R" >/dev/null
mk() { $T worktree create --repo "$R" --branch "$1" --new --json | jq_ "print(d[0]['id'], d[0]['path'])"; }
read -r WT P < <(mk feat/runtime)
FIXED=$(python3 -c 'import socket; s=socket.socket(); s.bind(("", 0)); print(s.getsockname()[1])')

ids() { $T action list "$1" --json | jq_ "print(' '.join(a['id'] for a in d['actions']))"; }
write_toml() { printf '%s\n' "$2" > "$1/.tomo.toml"; wait_for "[ \"\$(ids $3)\" = 'serve fixed crash raw ok' ]" 6; }
TOML="[[actions]]
id = \"serve\"
label = \"Serve\"
command = \"python3 $FIX/fake-server\"

[[actions]]
id = \"fixed\"
command = \"python3 $FIX/fake-server --port $FIXED\"

[[actions]]
id = \"crash\"
label = \"Crashy\"
command = \"python3 $FIX/fake-server --crash-after 3\"

[[actions]]
id = \"raw\"
command = \"python3 $FIX/fake-server --tcp\"

[[actions]]
id = \"ok\"
command = \"true\""
write_toml "$P" "$TOML" "$WT"

run() { $T action run "$2" "$1" --json | jq_ "print(d['pane']['id'] if d['pane'] else 'null')"; }
ep() { $T runtime "$1" --json | jq_ "m=[e for e in d if e['action_id']=='$2']; print(m[0]['$3'] if m else 'none')"; }
all_ports() { $T runtime --json | jq_ "print(' '.join(str(e['port']) for e in d))"; }
pane_exit() { $T pane list --worktree "$1" --json | jq_ "m=[p for p in d if p['id']=='$2']; print(m[0]['exit_code'] if m else 'gone')"; }
activity_of() { $T activity --json --worktree "$1" | jq_ "m=[e for e in d if e['kind']=='$2' and e['payload'].get('action_id')=='$3']; print(m[0]['$4'] if m else 'none')"; }
events() { python3 -c "import json; evs=[json.loads(l) for l in open('$EVLOG') if l.strip()]; print(sum(1 for e in evs if e['event']=='$1' and ($2)))" 2>/dev/null || echo 0; }

# 1. an owned listener is attributed to its pane and action within 3 s
S=$(run "$WT" serve)
wait_for "[ \"\$(ep $WT serve pane_id)\" = $S ]" 6 && check 0 "owned server appears with its pane and action within 3 s" || check 1 "discovery" "$($T runtime "$WT" --json)"
[ "$(ep "$WT" serve label)" = Serve ] && [ "$(ep "$WT" serve host)" = localhost ] && [ "$(ep "$WT" serve worktree_id)" = "$WT" ] && check 0 "endpoint carries the action label, localhost, and the worktree" || check 1 "endpoint fields" "$($T runtime "$WT" --json)"
wait_for "[ \"\$(ep $WT serve protocol)\" = http ]" 6 && check 0 "HEAD probe classifies the fake server as http" || check 1 "http probe" "$(ep "$WT" serve protocol)"
SPORT=$(ep "$WT" serve port)
$T runtime "$WT" | grep -Eq "^$SPORT +page 200 +[0-9]+ +[Pp]ython[^ ]* +serve +$S" && check 0 "text output prints port, what it serves, pid, process, action, and pane" || check 1 "text output" "$($T runtime "$WT")"
wait_for "[ \"\$(events runtime.endpoint_discovered \"e['action']['id']=='serve' and e['pane']['id']=='$S'\")\" = 1 ]" 6 && check 0 "runtime.endpoint_discovered fired once with pane and action" || check 1 "discovered hook" "$(cut -c1-200 "$EVLOG" 2>/dev/null)"
[ "$(activity_of "$WT" endpoint_discovered serve title)" != none ] && check 0 "activity records EndpointDiscovered" || check 1 "activity endpoint" "$($T activity --worktree "$WT")"

# 2. a plain TCP listener stays tcp
RW=$(run "$WT" raw)
wait_for "[ \"\$(ep $WT raw pane_id)\" = $RW ]" 6; sleep 2
[ "$(ep "$WT" raw protocol)" = tcp ] && check 0 "a non-HTTP listener stays tcp" || check 1 "tcp probe" "$(ep "$WT" raw protocol)"

# 3. a process started outside Tomo is never attributed
python3 "$FIX/fake-server" > /tmp/tomo-harness-stranger.out & STRANGER=$!
sleep 0.5; SPORT_OUT=$(sed -n 's/^PORT=//p' /tmp/tomo-harness-stranger.out)
sleep 2; $T runtime --json >/dev/null; sleep 2
case " $(all_ports) " in *" $SPORT_OUT "*) check 1 "stranger attributed" "port $SPORT_OUT listed";; *) check 0 "a listener outside every pane tree is not reported";; esac
kill $STRANGER 2>/dev/null; wait $STRANGER 2>/dev/null

# 4. two worktrees keep their endpoints apart
read -r WT2 P2 < <(mk feat/runtime-two)
write_toml "$P2" "$TOML" "$WT2"
S2=$(run "$WT2" serve)
wait_for "[ \"\$(ep $WT2 serve pane_id)\" = $S2 ]" 6 && check 0 "second worktree discovers its own server" || check 1 "second discovery" "$($T runtime "$WT2" --json)"
$T runtime "$WT" --json | jq_ "import sys; sys.exit(0 if all(e['worktree_id']=='$WT' for e in d) and len([e for e in d if e['action_id']=='serve'])==1 else 1)" \
  && $T runtime "$WT2" --json | jq_ "import sys; sys.exit(0 if all(e['worktree_id']=='$WT2' for e in d) and len(d)==1 else 1)" \
  && check 0 "endpoints are isolated per worktree" || check 1 "isolation" "$($T runtime --json)"
$T action stop serve "$WT2" >/dev/null

# 5. a restart on the same port inside the removal grace makes no event
F=$(run "$WT" fixed)
wait_for "[ \"\$(ep $WT fixed port)\" = $FIXED ]" 6 && check 0 "fixed-port server discovered" || check 1 "fixed discovery"
PID1=$(ep "$WT" fixed pid)
$T action restart fixed "$WT" >/dev/null
wait_for "[ \"\$(ep $WT fixed pid)\" != $PID1 ] && [ \"\$(ep $WT fixed pid)\" != none ]" 8 && check 0 "restart replaces the pid on the same port" || check 1 "restart pid" "$(ep "$WT" fixed pid) vs $PID1"
wait_for false 12
[ "$(events runtime.endpoint_discovered "e['action']['id']=='fixed'")" = 1 ] && [ "$(events runtime.endpoint_removed "e['action']['id']=='fixed'")" = 0 ] && check 0 "restart inside the grace fires no removed and no second discovered" || check 1 "restart debounce" "discovered=$(events runtime.endpoint_discovered "e['action']['id']=='fixed'") removed=$(events runtime.endpoint_removed "e['action']['id']=='fixed'")"
$T action stop fixed "$WT" >/dev/null
wait_for "[ \"\$(ep $WT fixed port)\" = none ]" 50 && check 0 "stopped server leaves the list after the grace period" || check 1 "removal" "$(ep "$WT" fixed port)"
wait_for "[ \"\$(events runtime.endpoint_removed \"e['action']['id']=='fixed' and e['worktree']['id']=='$WT'\")\" = 1 ]" 6 && check 0 "runtime.endpoint_removed fired once" || check 1 "removed hook" "$(cut -c1-200 "$EVLOG")"

# 6. a crash keeps the pane, raises attention, and records the exit code
C=$(run "$WT" crash)
wait_for "[ \"\$(ep $WT crash pane_id)\" = $C ]" 6 && check 0 "crashy server discovered before it dies" || check 1 "crash discovery"
wait_for "[ \"\$(pane_exit $WT $C)\" = 1 ]" 16 && check 0 "crashed action pane stays open with exit code 1" || check 1 "crash exit" "$(pane_exit "$WT" "$C")"
wait_for "[ \"\$(events action.crashed \"e['action']['id']=='crash' and e['pane']['id']=='$C' and e['attention']['kind']=='crash'\")\" = 1 ]" 6 && check 0 "action.crashed fired with pane and a crash attention item" || check 1 "crashed hook" "$(grep crashed "$EVLOG" | cut -c1-300)"
$T attention list --json | jq_ "import sys; sys.exit(0 if any(a['kind']=='crash' and a['pane_id']=='$C' and a['message']=='Crashy exited with code 1' and a['level']=='attention' and a['agent_kind'] is None for a in d) else 1)" && check 0 "attention item has kind crash and the exit message" || check 1 "crash attention" "$($T attention list)"
[ "$(activity_of "$WT" action_crashed crash payload)" != none ] && $T activity --json --worktree "$WT" | jq_ "import sys; m=[e for e in d if e['kind']=='action_crashed']; sys.exit(0 if m and m[0]['payload']['exit_code']==1 and m[0]['payload']['pane_id']=='$C' and m[0]['attention_id'] else 1)" && check 0 "activity ActionCrashed carries exit_code, pane_id, and the attention id" || check 1 "crash activity" "$($T activity --json --worktree "$WT" | head -30)"
wait_for "[ \"\$(ep $WT crash port)\" = none ]" 50 && check 0 "crashed server's endpoint is removed" || check 1 "crash removal"
$T pane close "$C" --force >/dev/null 2>&1

# 7. a stop is a stop, not a crash
$T action stop serve "$WT" >/dev/null; sleep 0.5
[ "$(activity_of "$WT" action_stopped serve title)" = "Serve stopped" ] && check 0 "tomo action stop records ActionStopped" || check 1 "stopped activity" "$($T activity --worktree "$WT")"
$T attention list --json | jq_ "import sys; sys.exit(0 if not any(a['kind']=='crash' and 'Serve' in a['message'] for a in d) else 1)" && check 0 "a stopped action raises no crash attention" || check 1 "stop attention" "$($T attention list)"
$T action stop raw "$WT" >/dev/null

# 8. exit 0 is a completion
run "$WT" ok >/dev/null
wait_for "[ \"\$(activity_of $WT action_completed ok title)\" = 'ok completed' ]" 10 && check 0 "exit 0 records ActionCompleted" || check 1 "completed activity" "$($T activity --worktree "$WT")"
$T attention list --json | jq_ "import sys; sys.exit(0 if not any(a['kind']=='crash' and a['message'].startswith('ok ') for a in d) else 1)" && check 0 "a completed action raises no attention" || check 1 "completed attention"

# 9. crash items resolve like checkpoints
CID=$($T attention list --json | jq_ "print([a['id'] for a in d if a['kind']=='crash'][0])")
$T checkpoint resolve "$CID" --json | jq_ "import sys; sys.exit(0 if d['resolved_at_ms'] else 1)" && check 0 "checkpoint resolve closes a crash item" || check 1 "resolve crash"
$T attention list --json | jq_ "import sys; sys.exit(0 if not any(a['id']=='$CID' for a in d) else 1)" && check 0 "resolved crash leaves the attention list" || check 1 "resolved list"

daemon_stop
summary
