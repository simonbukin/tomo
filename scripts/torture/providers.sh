#!/bin/bash
# Provider torture: Claude, Codex, and Pi through scripts/fixtures/fake-provider. No model calls.
# HOME points at a scratch directory next to the data dir, so ~/.claude, ~/.codex, and ~/.pi stay untouched.
set -u
. "$(dirname "$0")/lib.sh"

NODE=$(command -v node) || { known "node is not installed: the provider fixture cannot run"; summary; exit 0; }
FAKE="$FIX/fake-provider"
SCRATCH_HOME="${TOMO_DATA_DIR%/}-home"
case "$SCRATCH_HOME" in /tmp/?*|/private/tmp/?*) ;; *) echo "refusing to use $SCRATCH_HOME as HOME"; exit 1 ;; esac
rm -rf "$SCRATCH_HOME"; mkdir -p "$SCRATCH_HOME"; touch "$SCRATCH_HOME/.zshrc"
export HOME="$SCRATCH_HOME"
export GIT_AUTHOR_NAME=tomo GIT_AUTHOR_EMAIL=tomo@example.invalid GIT_COMMITTER_NAME=tomo GIT_COMMITTER_EMAIL=tomo@example.invalid

CONFIG=$(for p in claude codex pi; do printf '[agents.%s]\ncommand = "%s"\nargs = ["%s", "%s"]\n' "$p" "$NODE" "$FAKE" "$p"; done)
export CLAUDECODE=1 CLAUDE_CODE_ENTRYPOINT=cli CODEX_THREAD_ID=parent ORCA_PANE=1 PI_CODING_AGENT=true CODEX_SANDBOX=seatbelt
daemon_fresh "$CONFIG"
unset CLAUDECODE CLAUDE_CODE_ENTRYPOINT CODEX_THREAD_ID ORCA_PANE PI_CODING_AGENT CODEX_SANDBOX
R=$(new_repo); $T repo add "$R" >/dev/null
WT=$(wt_id "$R")

agent_field() { $T agent list --json | jq_ "a=[x for x in d if x['pane_id']=='$1']; print(a[0]['$2'] if a else 'none')"; }
pane_field() { $T pane list --json | jq_ "p=[x for x in d if x['id']=='$1']; print(p[0]['$2'] if p else 'none')"; }
spawn() { $RPC call agent_spawn "{\"kind\":\"$1\",\"worktree_id\":\"$WT\",\"cwd\":null,\"tab_id\":null,\"split_from\":null,\"resume\":null,\"new_tab\":true,\"extra_args\":[]}" | jq_ "print(d['pane']['id'])"; }
state_is() { wait_for "[ \"\$(agent_field $1 state)\" = $2 ]" "${3:-20}"; }
screen() { $RPC attach "$1" 0.5; }
on_screen() { screen "$1" | grep -qF -- "$2"; }
agent_line() { screen "$1" | grep "fake-provider $2 session .* argv:" | grep -qF -- "$3"; }
poll() { $T ps --json >/dev/null; }
waiting_item() { $T attention list --json | jq_ "import sys; sys.exit(0 if any(i['pane_id']=='$1' and i['kind']=='waiting' for i in d) else 1)"; }
session_listed() { $RPC call session_list "{\"worktree_id\":\"$WT\",\"limit\":50}" | jq_ "import sys; sys.exit(0 if any(s['id']=='$1' for s in d) else 1)"; }
level() { $T integrations status --json | jq_ "print([s['level'] for s in d if s['kind']=='$1'][0])"; }
resume_flags() { case $1 in claude) echo "--resume $2" ;; codex) echo "resume $2" ;; pi) echo "--session $2" ;; esac; }

# 0. a pane drops the markers of the agent that started tomod
E=$($T pane create --worktree "$WT"); sleep 1.5
$RPC send "$E" "env > $HOME/pane-env\r"
wait_for "[ -s $HOME/pane-env ]" 20
for v in CLAUDECODE CLAUDE_CODE_ENTRYPOINT CODEX_THREAD_ID ORCA_PANE; do
  grep -q "^$v=" "$HOME/pane-env" && check 1 "pane env drops $v" || check 0 "pane env drops $v"
done
for v in PI_CODING_AGENT CODEX_SANDBOX; do
  grep -q "^$v=" "$HOME/pane-env" && known "pane env keeps $v: inherited_env_to_remove names no Pi or Codex sandbox marker" || check 0 "pane env drops $v"
done

# 1. an agent started by hand, with no integration, is found by the process monitor
for p in claude codex pi; do
  H=$($T pane create --worktree "$WT"); sleep 1.5
  $RPC send "$H" "$NODE $FAKE $p\r"
  wait_for "on_screen $H 'fake-provider $p session'" 20
  poll
  wait_for "[ \"\$(agent_field $H pid)\" != None ]" 6
  [ "$(agent_field "$H" kind)" = "$p" ] && [ "$(agent_field "$H" authority)" = heuristic ] && [ "$(agent_field "$H" pid)" != None ] \
    && check 0 "$p by hand: the process monitor labels the pane" || check 1 "$p by hand: detection" "kind=$(agent_field "$H" kind) authority=$(agent_field "$H" authority)"
  case "$(pane_field "$H" process_cmd)" in "$p"*) check 0 "$p by hand: the pane shows the agent command" ;; *) check 1 "$p by hand: process_cmd" "$(pane_field "$H" process_cmd)" ;; esac
  $RPC send "$H" 'quit\r'
  wait_for "poll; [ \"\$(agent_field $H state)\" = exited ]" 10 && check 0 "$p by hand: the process monitor sees the exit" || check 1 "$p by hand: exit" "$(agent_field "$H" state)"
  eval "HAND_$p=$H"
done

# 2. integration install and Codex trust, all inside the scratch HOME
[ "$(level codex)" = process_only ] && check 0 "codex without hooks is process_only" || check 1 "codex level before install" "$(level codex)"
$T integrations install >/dev/null
grep -q 'hook claude' "$HOME/.claude/settings.json" && grep -q 'hook codex' "$HOME/.codex/hooks.json" && [ -f "$HOME/.pi/agent/extensions/tomo-status.ts" ] \
  && check 0 "integrations install writes the three provider files" || check 1 "integrations install files"
[ "$(level codex)" = partial ] && check 0 "installed but untrusted codex hooks are partial" || check 1 "codex level after install" "$(level codex)"

U=$(spawn codex)
wait_for "on_screen $U 'fake-provider codex session'" 20; sleep 1
[ "$(agent_field "$U" state)" = unknown ] && [ "$(agent_field "$U" session_ref)" = None ] && check 0 "untrusted codex: no hook runs, so no state and no session" || check 1 "untrusted codex" "$(agent_field "$U" state) $(agent_field "$U" session_ref)"
poll
wait_for "[ \"\$(agent_field $U pid)\" != None ]" 6 && check 0 "untrusted codex: the process monitor still records it" || check 1 "untrusted codex pid"

python3 -c "
import json, sys
d = sys.argv[1]; hooks = json.load(open(d + '/hooks.json'))['hooks']
snake = lambda e: ''.join('_' + c.lower() if c.isupper() and i else c.lower() for i, c in enumerate(e))
open(d + '/config.toml', 'w').write(''.join(f'\"{d}/hooks.json:{snake(e)}:{i}:0\" = \"trusted\"\n' for e, l in hooks.items() for i, x in enumerate(l) if 'hook codex' in json.dumps(x)))
" "$HOME/.codex"
[ "$(level codex)" = full ] && check 0 "trusted codex hooks are full" || check 1 "codex level after trust" "$(level codex)"

# 3. spawn, lifecycle, session identity, attention, and process detection per provider
for p in claude codex pi; do
  A=$(spawn "$p")
  state_is "$A" idle && check 0 "$p: agent_spawn reaches idle through the lifecycle hook" || check 1 "$p: spawn -> idle" "$(agent_field "$A" state)"
  [ "$(agent_field "$A" authority)" = lifecycle ] && check 0 "$p: authority is lifecycle" || check 1 "$p: authority" "$(agent_field "$A" authority)"
  S=$(agent_field "$A" session_ref)
  [ "$S" != None ] && on_screen "$A" "fake-provider $p session $S " && check 0 "$p: the recorded session is the one the agent runs" || check 1 "$p: session identity" "ref=$S"

  $RPC send "$A" 'work 2\r'
  state_is "$A" working 10 && check 0 "$p: a prompt -> working" || check 1 "$p: working" "$(agent_field "$A" state)"
  state_is "$A" idle 16 && check 0 "$p: the end of the turn -> idle" || check 1 "$p: idle after work" "$(agent_field "$A" state)"
  if [ "$p" = pi ]; then
    S=$(agent_field "$A" session_ref)
    case "$S" in "$HOME"/.pi/agent/sessions/*.jsonl) [ -f "$S" ] && check 0 "pi: the session ref becomes the session file after the first message" || check 1 "pi: session file missing" "$S" ;; *) check 1 "pi: session file ref" "$S" ;; esac
    session_listed "$(basename "$S" .jsonl | sed 's/.*_//')" && check 0 "session_list finds the pi session" || known "session_list reads no Pi sessions: features/sessions.rs covers Claude and Codex only"
  else
    session_listed "$S" && check 0 "session_list finds the $p session" || check 1 "$p: session_list" "$S"
  fi

  $RPC send "$A" 'wait\r'
  state_is "$A" waiting 10 && waiting_item "$A" && check 0 "$p: waiting opens an attention item" || check 1 "$p: waiting" "$(agent_field "$A" state)"
  $RPC send "$A" 'work 1\r'
  state_is "$A" working 10 && ! waiting_item "$A" && check 0 "$p: answering resolves the waiting item" || check 1 "$p: answer" "$(agent_field "$A" state)"
  state_is "$A" idle 12

  poll
  wait_for "[ \"\$(agent_field $A pid)\" != None ]" 6 && [ "$(agent_field "$A" kind)" = "$p" ] && check 0 "$p: the process monitor records the agent pid" || check 1 "$p: pid" "$(agent_field "$A" pid)"
  case "$(pane_field "$A" process_cmd)" in "$p"*) check 0 "$p: the pane shows the agent command" ;; *) check 1 "$p: process_cmd" "$(pane_field "$A" process_cmd)" ;; esac
  eval "A_$p=$A; S_$p='$S'"
done

for p in claude pi; do
  N=$(spawn "$p"); state_is "$N" idle
  eval "FRESH_$p=$N"
done
X=$(spawn claude); state_is "$X" idle
$RPC send "$X" 'work 1\r'; state_is "$X" working 6; state_is "$X" idle 10
$RPC send "$X" 'quit\r'; state_is "$X" exited 10

# 4. a daemon restart resumes each agent with its provider's resume command line
daemon_restart; sleep 8
for p in claude codex pi; do
  eval "A=\$A_$p; S=\$S_$p"
  FLAGS=$(resume_flags "$p" "$S")
  [ "$(pane_field "$A" origin)" = resumed ] && check 0 "$p: the pane comes back as resumed" || check 1 "$p: origin" "$(pane_field "$A" origin)"
  wait_for "agent_line $A $p '$FLAGS'" 20 && check 0 "$p: restart runs '$FLAGS'" || check 1 "$p: resume command line" "$(screen "$A" | grep 'fake-provider' | tail -1)"
  state_is "$A" idle 10 && [ "$(agent_field "$A" session_ref)" = "$S" ] && check 0 "$p: the resumed agent reports the same session" || check 1 "$p: resumed session" "$(agent_field "$A" session_ref) vs $S"
done

wait_for "screen $U | grep 'fake-provider codex session' | grep -qF -- 'argv: resume --last'" 20 && check 0 "codex without a session ref resumes with 'resume --last'" || check 1 "codex --last" "$(screen "$U" | grep fake-provider | tail -1)"
state_is "$U" idle 10
[ "$(agent_field "$U" session_ref)" = "$S_codex" ] && known "two Codex panes in one worktree: 'resume --last' gives the untrusted pane the newest session, which belongs to the other pane" || check 1 "codex --last session" "$(agent_field "$U" session_ref) vs $S_codex"

wait_for "on_screen $FRESH_claude 'No conversation found with session ID'" 20 && known "claude: a session with no message has no transcript, so '--resume' fails after restart" || check 1 "claude fresh resume" "$(screen "$FRESH_claude" | tail -2)"
wait_for "on_screen $FRESH_pi 'No session found matching'" 20 && known "pi: a session with no message has no session file, so '--session <id>' fails after restart" || check 1 "pi fresh resume" "$(screen "$FRESH_pi" | tail -2)"
[ "$(pane_field "$X" origin)" = resumed ] && known "claude: restore resumes an agent that had exited before the restart (reopen skips exited agents)" || check 0 "an exited claude is not resumed"
[ "$(pane_field "$HAND_codex" origin)" = resumed ] && known "codex: a pane whose hand-started Codex had exited is resumed with 'resume --last' after restart" || check 0 "an exited hand-started codex is not resumed"

# 5. reopen of a closed tab uses the same resume command line
for p in claude codex pi; do
  eval "A=\$A_$p; S=\$S_$p"
  FLAGS=$(resume_flags "$p" "$S")
  $T tab close "$(pane_field "$A" tab_id)" --force >/dev/null
  NT=$($RPC call tab_reopen "{\"worktree_id\":\"$WT\"}" | jq_ "print(d['id'])")
  N=$($T pane list --json | jq_ "a=[x['id'] for x in d if x['tab_id']=='$NT']; print(a[0] if a else 'none')")
  wait_for "agent_line $N $p '$FLAGS'" 20 && check 0 "$p: reopen runs '$FLAGS'" || check 1 "$p: reopen command line" "$(screen "$N" | grep 'fake-provider' | tail -1)"
  state_is "$N" idle 10 && [ "$(agent_field "$N" session_ref)" = "$S" ] && check 0 "$p: the reopened agent reports the same session" || check 1 "$p: reopened session" "$(agent_field "$N" session_ref)"
  eval "N_$p=$N"
done

# 6. exit
for p in claude codex pi; do
  eval "N=\$N_$p"
  poll; wait_for "[ \"\$(agent_field $N pid)\" != None ]" 6
  $RPC send "$N" 'quit\r'
  if [ "$p" = codex ]; then
    wait_for "on_screen $N bye" 10; sleep 1
    [ "$(agent_field "$N" state)" = idle ] && check 0 "codex: no installed hook reports the exit" || check 1 "codex: state right after quit" "$(agent_field "$N" state)"
    wait_for "poll; [ \"\$(agent_field $N state)\" = exited ]" 10 && check 0 "codex: the process monitor turns the exit into exited" || check 1 "codex: exit" "$(agent_field "$N" state)"
  else
    state_is "$N" exited 10 && [ "$(agent_field "$N" authority)" = lifecycle ] && check 0 "$p: the exit hook -> exited" || check 1 "$p: exit" "$(agent_field "$N" state)"
  fi
done

daemon_stop
summary
