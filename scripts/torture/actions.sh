#!/bin/bash
# Actions matrix: .tomo.toml parsing, pane and external runs, hooks, reload, and hook edge cases.
set -u
. "$(dirname "$0")/lib.sh"

EVLOG=/tmp/tomo-harness-actions-events.log; rm -f "$EVLOG"
daemon_fresh "[[hooks]]
event = \"action.started\"
command = \"printf '%s\\\\n' \\\"\$TOMO_EVENT_JSON\\\" >> $EVLOG\"

[[hooks]]
event = \"action.exited\"
command = \"printf '%s\\\\n' \\\"\$TOMO_EVENT_JSON\\\" >> $EVLOG\""
$T config check >/dev/null 2>&1 && check 0 "config check accepts action.* hooks" || check 1 "config check" "$($T config check 2>&1 | tail -3)"
R=$(new_repo); $T repo add "$R" >/dev/null
read -r WT P < <($T worktree create --repo "$R" --branch feat/actions --new --json | jq_ "print(d[0]['id'], d[0]['path'])")

ids() { $T action list "$WT" --json | jq_ "print(' '.join(a['id'] for a in d))"; }
list_text() { $T action list "$WT" 2>&1; }
write_toml() { printf '%s\n' "$1" > "$P/.tomo.toml"; wait_for "[ \"\$(ids)\" = \"$2\" ]" 4; }
run() { $T action run "$1" "$WT" --json 2>&1; }
pane_field() { echo "$1" | jq_ "print(d['pane']['$2'] if d['pane'] else 'null')"; }
action_panes() { $T pane list --worktree "$WT" --json | jq_ "print(' '.join(p['id'] for p in d if p['action_id']))"; }
pane_exit() { $T pane list --worktree "$WT" --json | jq_ "m=[p for p in d if p['id']=='$1']; print(m[0]['exit_code'] if m else 'gone')"; }

# parsing
[ "$(ids)" = "" ] && list_text | grep -q "no actions" && check 0 "no .tomo.toml means no actions" || check 1 "no file" "$(list_text)"

write_toml '[[actions]]
id = "quick"
label = "Quick"
command = "echo quick-ran"
show = "topbar"

[[actions]]
id = "serve"
command = "sleep 30"

[[actions]]
id = "mark"
command = "touch marker-ext"
mode = "external"' "quick serve mark"
$T action list "$WT" --json | jq_ "import sys
a={x['id']:x for x in d}
ok=len(d)==3 and a['quick']['label']=='Quick' and a['quick']['show']=='topbar' and a['quick']['mode']=='pane' and a['serve']['label']=='serve' and a['serve']['show']=='menu' and a['mark']['mode']=='external'
sys.exit(0 if ok else 1)" && check 0 "three valid entries with defaults" || check 1 "valid file" "$(list_text)"
sleep 2; [ -z "$(action_panes)" ] && check 0 "nothing runs on its own after the file appears" || check 1 "autorun" "$(action_panes)"

write_toml '[[actions]]
command = "echo no-id"

[[actions]]
id = "ok"
command = "true"' "ok"
list_text | grep -q "warning: $P/.tomo.toml: actions\[0\] id is required" && check 0 "missing id is dropped with a warning that names the file" || check 1 "missing id" "$(list_text)"

write_toml '[[actions]]
id = "dup"
command = "true"

[[actions]]
id = "dup"
command = "false"' "dup"
list_text | grep -q "warning: $P/.tomo.toml: actions\[1\] duplicate id" && check 0 "duplicate id is dropped with a warning" || check 1 "duplicate id" "$(list_text)"

write_toml '[[actions]]
id = "weird"
command = "true"
mode = "sideways"

[[actions]]
id = "fine"
command = "true"' "fine"
list_text | grep -q "warning: $P/.tomo.toml: actions\[0\] weird: mode \"sideways\"" && check 0 "bad mode is dropped with a warning" || check 1 "bad mode" "$(list_text)"

write_toml 'this is not = [[[ toml' ""
list_text | grep -q "warning: $P/.tomo.toml:" && [ "$($T action list "$WT" --json)" = "[]" ] && check 0 "invalid TOML gives zero actions and a warning" || check 1 "invalid toml" "$(list_text)"
$T worktree open "$WT" >/dev/null 2>&1 && check 0 "worktree still opens with an invalid .tomo.toml" || check 1 "open with invalid toml"

# runs
write_toml '[[actions]]
id = "quick"
label = "Quick"
command = "echo quick-ran"
show = "topbar"

[[actions]]
id = "serve"
command = "sleep 30"

[[actions]]
id = "fail"
command = "exit 3"

[[actions]]
id = "mark"
command = "touch marker-ext"
mode = "external"' "quick serve fail mark"

o=$(run serve); S1=$(pane_field "$o" id)
[ "$(pane_field "$o" action_id)" = serve ] && [ "$(echo "$o" | jq_ "print(d['reused'])")" = False ] && check 0 "pane action starts with action_id provenance" || check 1 "run pane" "$o"
echo "$o" | jq_ "import sys; sys.exit(0 if d['pane']['source']=={'kind':'action','id':'serve','label':'serve'} else 1)" && check 0 "the pane source names the action kind, id, and label" || check 1 "pane source" "$o"
o=$(run serve); S2=$(pane_field "$o" id)
[ "$S1" = "$S2" ] && [ "$(echo "$o" | jq_ "print(d['reused'])")" = True ] && check 0 "second run reuses the live pane" || check 1 "reuse" "$S1 vs $S2 $o"
$T action stop serve "$WT"; sleep 0.5
[ "$(pane_exit "$S1")" = gone ] && check 0 "stop removes the action pane" || check 1 "stop" "$(pane_exit "$S1")"
o=$(run serve); S3=$(pane_field "$o" id)
[ -n "$S3" ] && [ "$S3" != "$S1" ] && [ "$(echo "$o" | jq_ "print(d['reused'])")" = False ] && check 0 "run after stop gives a new pane" || check 1 "run after stop" "$o"
o=$($T action restart serve "$WT" --json); S4=$(pane_field "$o" id)
[ -n "$S4" ] && [ "$S4" != "$S3" ] && [ "$(pane_exit "$S3")" = gone ] && check 0 "restart gives a different pane id" || check 1 "restart" "$S3 -> $S4"
$T action stop serve "$WT"

o=$(run fail); F=$(pane_field "$o" id)
wait_for "[ \"\$(pane_exit $F)\" = 3 ]" 10 && check 0 "non-zero exit keeps the pane with exit_code 3" || check 1 "exit 3" "$(pane_exit "$F")"
$T pane close "$F" --force >/dev/null 2>&1

o=$(run quick); Q=$(pane_field "$o" id)
wait_for "[ \"\$(pane_exit $Q)\" = gone ]" 10 && check 0 "exit 0 removes the pane" || check 1 "exit 0" "$(pane_exit "$Q")"

rm -f "$P/marker-ext"
o=$(run mark)
[ "$(pane_field "$o" id)" = null ] && wait_for "[ -f '$P/marker-ext' ]" 6 && [ -z "$(action_panes)" ] && check 0 "external action writes its marker and opens no pane" || check 1 "external" "$o"

o=$(run nope); rc=$?
[ $rc != 0 ] && case "$o" in *NotFound*) check 0 "unknown action is NotFound";; *) check 1 "unknown action" "$o";; esac || check 1 "unknown action" "rc=0"

# hook events
python3 - "$EVLOG" <<'EOF' && check 0 "action.started then action.exited with action and pane payload" || check 1 "hook events" "$(cut -c1-160 "$EVLOG" 2>/dev/null)"
import json, sys
evs = [json.loads(l) for l in open(sys.argv[1]) if l.strip()]
quick = [e for e in evs if e.get("action", {}) and e["action"]["id"] == "quick"]
names = [e["event"] for e in quick]
ok = names == ["action.started", "action.exited"] and all(e["action"]["label"] == "Quick" and e["pane"] for e in quick)
ext = [e for e in evs if e.get("action") and e["action"]["id"] == "mark"]
ok = ok and [e["event"] for e in ext] == ["action.started"] and ext[0]["pane"] is None
sys.exit(0 if ok else 1)
EOF
$T hooks log --json -n 40 | jq_ "import sys; ev=[r['event'] for r in d if r['event'].startswith('action.')]; sys.exit(0 if 'action.started' in ev and 'action.exited' in ev and all(r['ok'] for r in d if r['event'].startswith('action.')) else 1)" && check 0 "hooks log records action.* runs as ok" || check 1 "hooks log"

# reload on edit
printf '\n[[actions]]\nid = "late"\ncommand = "true"\n' >> "$P/.tomo.toml"
wait_for "[ \"\$(ids)\" = 'quick serve fail mark late' ]" 4 && check 0 "an added action shows within 2 s" || check 1 "reload" "$(ids)"

# the repository file, and the worktree override
write_repo_toml() { printf '%s\n' "$1" > "$R/.tomo.toml"; wait_for "[ \"\$(ids)\" = \"$2\" ]" 8; }
rm -f "$P/.tomo.toml"
write_repo_toml '[[actions]]
id = "repo-wide"
command = "true"' "repo-wide"
[ "$(ids)" = "repo-wide" ] && check 0 "a sibling worktree sees the repository .tomo.toml" || check 1 "repo fallback" "$(ids)"

printf '[[actions]]\nid = "local-only"\ncommand = "true"\n' > "$P/.tomo.toml"
wait_for "[ \"\$(ids)\" = 'local-only' ]" 8
[ "$(ids)" = "local-only" ] && check 0 "a worktree file wins whole over the repository file" || check 1 "worktree override" "$(ids)"

rm -f "$P/.tomo.toml"; wait_for "[ \"\$(ids)\" = 'repo-wide' ]" 8
write_repo_toml '[[actions]]
command = "true"' ""
list_text | grep -q "warning: $R/.tomo.toml: actions\[0\] id is required" && check 0 "a bad repository file names its own path" || check 1 "repo file error path" "$(list_text)"
rm -f "$R/.tomo.toml"

# hook timeout kills the tree; hook output keeps UTF-8 intact
daemon_fresh "[[hooks]]
event = \"pane.created\"
command = \"sh -c '(sleep 60 &) ; sleep 60'\"
timeout_s = 1

[[hooks]]
event = \"pane.closed\"
command = \"python3 -c \\\"print('日本語😀'*800)\\\"\""
R=$(new_repo); $T repo add "$R" >/dev/null; WT=$(wt_id "$R")
before=$(pgrep -f "sleep 60" | wc -l)
X=$($T pane create --worktree "$WT"); sleep 2.5
after=$(pgrep -f "sleep 60" | wc -l)
[ "$after" -le "$before" ] && check 0 "timed-out hook leaves no sleep 60 behind" || check 1 "hook timeout" "$after sleepers (baseline $before)"
$T hooks log --json -n 1 | jq_ "import sys; r=d[-1]; sys.exit(0 if r['event']=='pane.created' and not r['ok'] and 'killed' in r['output_tail'] else 1)" && check 0 "hooks log shows the killed run" || check 1 "killed log" "$($T hooks log -n 1)"
$T pane close "$X" --force >/dev/null; sleep 1.5
$T hooks log --json -n 1 | jq_ "import sys; r=d[-1]; t=r['output_tail']; sys.exit(0 if r['event']=='pane.closed' and r['ok'] and '�' not in t and t.endswith('日本語😀') and len(t.encode())>3000 else 1)" && check 0 "multi-byte hook output tail is valid UTF-8 and ends with the last characters" || check 1 "utf-8 tail" "$($T hooks log --json -n 1 | tail -c 200)"

daemon_stop
summary
