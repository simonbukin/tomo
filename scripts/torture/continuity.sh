#!/bin/bash
# Continuity: reopen closed tabs, open file locations in a fake editor, and restore without rerunning Actions. No GUI.
set -u
. "$(dirname "$0")/lib.sh"

SCRATCH="$(mktemp -d /tmp/tomo-qol-os-continuity.XXXX)"
OUT="$SCRATCH/editor-args.txt"
FAKE_EDITOR="$SCRATCH/fake-editor"
cat > "$FAKE_EDITOR" <<EOF
#!/bin/sh
printf '%s\n' "\$@" > "$OUT.tmp" && mv "$OUT.tmp" "$OUT"
EOF
chmod +x "$FAKE_EDITOR"

daemon_fresh "editor_command = [\"$FAKE_EDITOR\", \"{path}\"]

[agents.claude]
command = \"$FIX/fake-agent\"
args = [\"--tomo\", \"$T\"]"
R=$(new_repo); $T repo add "$R" >/dev/null
WT=$(wt_id "$R")

tab_new() { $RPC call tab_create "{\"worktree_id\":\"$WT\",\"title\":\"$1\"}" | jq_ "print(d['id'])"; }
tab_close() { $RPC call tab_close "{\"tab_id\":\"$1\",\"force\":true}" >/dev/null; }
reopen() { $RPC call tab_reopen "{\"worktree_id\":\"$WT\"}" 2>&1; }
titles() { $T tab list "$WT" --json | jq_ "print(' '.join(t['title'] for t in d))"; }
tab_field() { $T tab list "$WT" --json | jq_ "t=[x for x in d if x['id']=='$1']; print(t[0]['$2'] if t else 'none')"; }
pane_field() { $T pane list --json | jq_ "p=[x for x in d if x['id']=='$1']; print(p[0]['$2'] if p else 'none')"; }
panes_of_tab() { $T pane list --worktree "$WT" --json | jq_ "print(' '.join(p['id'] for p in d if p['tab_id']=='$1'))"; }

# 1. a terminal tab comes back with its title, split, ratio, cwd, and place in the tab bar
tab_new first >/dev/null
T1=$(tab_new logs)
P1=$(tab_field "$T1" active_pane_id)
$RPC call pane_split "{\"pane_id\":\"$P1\",\"direction\":\"vertical\",\"command\":null}" >/dev/null
SPLIT=$($T tab list "$WT" --json | jq_ "print([t for t in d if t['id']=='$T1'][0]['layout']['id'])")
$RPC call layout_resize "{\"tab_id\":\"$T1\",\"split_id\":\"$SPLIT\",\"ratio\":0.3}" >/dev/null
tab_new after >/dev/null
[ "$(titles)" = "first logs after" ] && check 0 "three tabs in order" || check 1 "setup" "$(titles)"
tab_close "$T1"; sleep 0.3
[ "$(titles)" = "first after" ] && check 0 "tab_close removes the tab" || check 1 "close" "$(titles)"
RE=$(reopen)
echo "$RE" | jq_ "import sys; l=d['layout']; sys.exit(0 if d['title']=='logs' and l['type']=='split' and l['direction']=='vertical' and abs(l['ratio']-0.3)<1e-9 and d['is_active'] else 1)" && check 0 "reopen restores title, split direction, ratio, and focus" || check 1 "reopen layout" "$RE"
[ "$(titles)" = "first logs after" ] && check 0 "reopened tab returns to its old place" || check 1 "position" "$(titles)"
NT=$(echo "$RE" | jq_ "print(d['id'])")
$T pane list --worktree "$WT" --json | jq_ "import sys; p=[x for x in d if x['tab_id']=='$NT']; sys.exit(0 if len(p)==2 and all(x['cwd']=='$R' and x['live'] for x in p) else 1)" && check 0 "both panes are live shells in the old cwd" || check 1 "panes" "$(panes_of_tab "$NT")"

# 2. closing the last pane of a tab also records the tab
SOLO=$(tab_new solo)
$RPC call pane_close "{\"pane_id\":\"$(tab_field "$SOLO" active_pane_id)\",\"force\":true}" >/dev/null; sleep 0.3
echo "$(reopen)" | jq_ "import sys; sys.exit(0 if d['title']=='solo' else 1)" && check 0 "closing the last pane is reopenable" || check 1 "pane close record"

# 3. a browser tab comes back with its URL
$T browser open "$WT" --url http://localhost:5173/x >/dev/null; sleep 0.3
BT=$($T tab list "$WT" --json | jq_ "print([t['id'] for t in d if t['title']=='Browser'][0])")
tab_close "$BT"
NB=$(reopen | jq_ "print(d['active_pane_id'])")
[ "$(pane_field "$NB" kind)" = browser ] && [ "$(pane_field "$NB" url)" = "http://localhost:5173/x" ] && check 0 "browser tab reopens at the same URL" || check 1 "browser reopen" "$(pane_field "$NB" kind) $(pane_field "$NB" url)"

# 4. an agent tab resumes the same session
A=$($RPC call agent_spawn "{\"kind\":\"claude\",\"worktree_id\":\"$WT\",\"cwd\":null,\"tab_id\":null,\"split_from\":null,\"resume\":null,\"new_tab\":true,\"extra_args\":[]}" | jq_ "print(d['pane']['id'])")
agent_field() { $T agent list --json | jq_ "a=[x for x in d if x['pane_id']=='$1']; print(a[0]['$2'] if a else 'none')"; }
wait_for "[ \"\$(agent_field $A state)\" = idle ]" 20
SID=$(agent_field "$A" session_ref)
tab_close "$(pane_field "$A" tab_id)"; sleep 0.3
NA=$(reopen | jq_ "print(d['active_pane_id'])")
wait_for "[ \"\$(agent_field $NA state)\" = idle ]" 20
[ "$(agent_field "$NA" kind)" = claude ] && [ "$(agent_field "$NA" session_ref)" = "$SID" ] && check 0 "agent tab resumes session $SID" || check 1 "agent resume" "$(agent_field "$NA" kind) $(agent_field "$NA" session_ref)"
case "$($RPC attach "$NA" 2)" in *"fake-agent session $SID"*) check 0 "the resume command line reached the agent";; *) check 1 "resume line";; esac

# 5. an Action tab comes back as a shell with the Action label; the command does not run
printf '[[actions]]\nid = "serve"\nlabel = "Serve"\ncommand = "touch marker-serve; sleep 30"\n' > "$R/.tomo.toml"
wait_for "$T action list $WT --json | grep -q serve" 10
AT=$(tab_new actions)
SP=$($T action run serve "$WT" --json | jq_ "print(d['pane']['id'])")
wait_for "[ -f $R/marker-serve ]" 10; rm -f "$R/marker-serve"
[ "$(pane_field "$SP" tab_id)" = "$AT" ] || known "action pane landed outside the actions tab"
tab_close "$(pane_field "$SP" tab_id)"; sleep 0.3
NT=$(reopen | jq_ "print(d['id'])"); sleep 2
$T pane list --worktree "$WT" --json | jq_ "import sys; p=[x for x in d if x['tab_id']=='$NT']; sys.exit(0 if any(x['user_title']=='Serve' and x['action_id'] is None and x['live'] for x in p) else 1)" && check 0 "Action pane reopens as a shell titled Serve without action_id" || check 1 "action reopen" "$($T pane list --worktree "$WT" --json)"
[ ! -f "$R/marker-serve" ] && check 0 "reopen does not rerun the Action command" || check 1 "action reran on reopen"

# 6. the stack keeps the newest ten and walks back per worktree
for i in $(seq 1 12); do tab_close "$(tab_new "b$i")"; done
FIRST=$(reopen | jq_ "print(d['title'])")
n=1; while reopen | grep -q '"id"'; do n=$((n+1)); [ $n -gt 20 ] && break; done
[ "$FIRST" = b12 ] && [ $n = 10 ] && check 0 "stack holds ten tabs, newest first" || check 1 "stack bound" "first=$FIRST count=$n"
reopen | grep -q not_found && check 0 "an empty stack answers not_found" || check 1 "empty stack"

# 7. open_location starts the configured editor at path:line:col
mkdir -p "$R/lib"; echo "fn main() {}" > "$R/lib/a.rs"
$RPC call open_location "{\"path\":\"$R/lib/a.rs\",\"line\":12,\"col\":3}" >/dev/null
wait_for "[ -f $OUT ]" 10
[ "$(cat "$OUT" 2>/dev/null)" = "$R/lib/a.rs:12:3" ] && check 0 "fake editor got path:line:col" || check 1 "editor args" "$(cat "$OUT" 2>/dev/null)"
$RPC call open_location '{"path":"lib/a.rs","line":1}' 2>&1 | grep -q bad_request && check 0 "a relative path is a bad request" || check 1 "relative guard"
$RPC call open_location "{\"path\":\"$R/missing.rs\",\"line\":1}" 2>&1 | grep -q not_found && check 0 "a missing file is not_found" || check 1 "missing guard"

# 8. a daemon restart restores an Action pane as a shell and does not rerun the Action
SP2=$($T action run serve "$WT" --json | jq_ "print(d['pane']['id'])")
wait_for "[ -f $R/marker-serve ]" 10; rm -f "$R/marker-serve"
daemon_restart; sleep 2
[ "$(pane_field "$SP2" origin)" = restored ] && [ "$(pane_field "$SP2" action_id)" = None ] && check 0 "restart restores the Action pane without action_id" || check 1 "restore action" "$(pane_field "$SP2" origin) $(pane_field "$SP2" action_id)"
[ ! -f "$R/marker-serve" ] && check 0 "restart does not rerun the Action command" || check 1 "action reran on restart"
reopen | grep -q not_found && check 0 "the closed-tab stack does not survive a daemon restart" || check 1 "stack after restart"

daemon_stop
rm -rf "$SCRATCH"
summary
