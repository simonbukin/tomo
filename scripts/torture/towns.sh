#!/bin/bash
# Town history: the facts for an unlocked town before archive, after archive, and after a daemon restart.
set -u
. "$(dirname "$0")/lib.sh"

daemon_fresh
R=$(new_repo); $T repo add "$R" >/dev/null

read -r W P S < <($T worktree create --repo "$R" --branch feat/town --new --json | jq_ "print(d[0]['id'], d[0]['path'], d[0]['town_slug'])")
[ "$S" != None ] && check 0 "new worktree gets a town" || check 1 "town assigned" "$S"

hist() { $RPC call town_history "{\"slug\":\"$S\"}"; }
has() { echo "$1" | jq_ "import sys; sys.exit(0 if $2 else 1)"; }

HEAD=$(git -C "$P" rev-parse HEAD)
o=$(hist)
has "$o" "d['status']=='active' and d['branch']=='feat/town' and d['unlock']['worktree_id']=='$W' and d['final_commit']=='$HEAD' and d['repo_name'] and d['archived_at_ms'] is None" \
  && check 0 "active town shows branch, repo, and head" || check 1 "active history" "$o"

echo change > "$P/x.txt"
$T worktree archive "$W" --json >/dev/null 2>&1
C=$(git -C "$R" rev-parse feat/town)
o=$(hist)
has "$o" "d['status']=='archived' and d['archived_at_ms'] and d['final_commit']=='$C' and d['branch']=='feat/town'" \
  && check 0 "archived town shows the checkpoint and archive date" || check 1 "archived history" "$o"

$T towns list --unlocked --json | jq_ "import sys; sys.exit(0 if any(r['town']['slug']=='$S' for r in d) else 1)" \
  && check 0 "archive keeps the unlock" || check 1 "unlock after archive"

daemon_restart
o=$(hist)
has "$o" "d['status']=='archived' and d['final_commit']=='$C'" && check 0 "history survives a daemon restart" || check 1 "history after restart" "$o"

o=$($RPC call town_history '{"slug":"no-such-town"}' 2>&1); rc=$?
[ $rc != 0 ] && case "$o" in *not_found*|*"not unlocked"*) check 0 "a locked town has no history";; *) check 1 "locked town" "$o";; esac || check 1 "locked town" "rc=0 $o"

daemon_stop
summary
