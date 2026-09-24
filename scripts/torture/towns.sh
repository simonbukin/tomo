#!/bin/bash
# Town history: the facts for an unlocked town before archive, after archive, and after a daemon restart.
set -u
. "$(dirname "$0")/lib.sh"

# A scratch home under /tmp, so the harness never writes a worktree into the real ~/tomo.
export HOME=$(cd "$(mktemp -d /tmp/tomo-home-XXXXXX)" && pwd -P)
export GIT_AUTHOR_NAME=tomo GIT_AUTHOR_EMAIL=tomo@example.com GIT_COMMITTER_NAME=tomo GIT_COMMITTER_EMAIL=tomo@example.com

daemon_fresh
R=$(new_repo); $T repo add "$R" >/dev/null

slug_of() { $T towns list --unlocked --json | jq_ "print(next((r['town']['slug'] for r in d if r['unlock']['worktree_id']=='$1'), None))"; }
read -r W P < <($T worktree create --repo "$R" --branch feat/town --new --json | jq_ "print(d[0]['id'], d[0]['path'])")
S=$(slug_of "$W")
[ "$S" != None ] && [ "$(basename "$P")" = "$S" ] && check 0 "new worktree gets a town" || check 1 "town assigned" "$S $P"

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

name_of() { $T worktree list --json | jq_ "print(next((w['name'] for w in d if w['id']=='$1'), None))"; }
town_name() { $T towns list --unlocked --json | jq_ "print(next((r['town']['name'] for r in d if r['town']['slug']=='$1'), None))"; }
parent_dir() { printf 'worktree_parent_dir = "%s"\n' "$1" > "$TOMO_DATA_DIR/config.toml"; daemon_restart; }

# Restore at a new path gives the worktree a new id. The unlock and the town name must follow it.
A=$(cd "$(mktemp -d /tmp/tomo-harness-wts.XXXX)" && pwd -P); B=$(cd "$(mktemp -d /tmp/tomo-harness-wts.XXXX)" && pwd -P)
parent_dir "$A"
read -r W2 P2 < <($T worktree create --repo "$R" --branch feat/restored --new --json | jq_ "print(d[0]['id'], d[0]['path'])")
S2=$(slug_of "$W2")
[ "$P2" = "$A/$S2" ] && check 0 "worktree_parent_dir still decides where a new worktree goes" || check 1 "override parent" "$P2"
$T worktree archive "$W2" --json >/dev/null 2>&1
rm -rf "$A"
parent_dir "$B"
$T worktree restore "$W2" >/dev/null 2>&1
N2=$(wt_id "$B/$S2" 2>/dev/null)
[ -n "$N2" ] && [ "$N2" != "$W2" ] && [ "$(slug_of "$N2")" = "$S2" ] && check 0 "restore at a new path moves the unlock to the new worktree" || check 1 "unlock after restore at a new path" "old=$W2 new=$N2 unlock=$(slug_of "$N2")"
[ -n "$N2" ] && [ "$(name_of "$N2")" = "$(town_name "$S2")" ] && check 0 "restore at a new path keeps the town name" || check 1 "name after restore" "$(name_of "$N2")"
has "$($RPC call town_history "{\"slug\":\"$S2\"}")" "d['status']=='active' and d['branch']=='feat/restored'" && check 0 "restored town history is active" || check 1 "history after restore" "$($RPC call town_history "{\"slug\":\"$S2\"}")"

# A worktree moved with git keeps its unlock and its activity rows.
read -r W3 P3 < <($T worktree create --repo "$R" --branch feat/moved --new --json | jq_ "print(d[0]['id'], d[0]['path'])")
S3=$(slug_of "$W3")
$T checkpoint "before the move" --worktree "$W3" >/dev/null
git -C "$R" worktree move "$P3" "$P3-moved"
$T worktree refresh >/dev/null
N3=$(wt_id "$P3-moved" 2>/dev/null)
[ -n "$N3" ] && [ "$(slug_of "$N3")" = "$S3" ] && check 0 "a moved worktree keeps its unlock" || check 1 "unlock after move" "old=$W3 new=$N3 unlock=$(slug_of "$N3")"
[ -n "$N3" ] && $T activity --json --worktree "$N3" | jq_ "import sys; sys.exit(0 if any(e['kind']=='checkpoint_created' for e in d) else 1)" && check 0 "a moved worktree keeps its activity" || check 1 "activity after move" "$($T activity --json --worktree "$N3" 2>&1 | head -5)"

# No override: a new worktree goes to the worktree home, ~/tomo/worktrees/<repo>/<name>.
rm -f "$TOMO_DATA_DIR/config.toml"; daemon_restart
read -r W4 P4 < <($T worktree create --repo "$R" --branch feat/home --new --json | jq_ "print(d[0]['id'], d[0]['path'])")
[ "$P4" = "$HOME/tomo/worktrees/$(basename "$R")/$(slug_of "$W4")" ] && check 0 "a new worktree goes under the worktree home" || check 1 "worktree home" "$P4"

# A create with no branch gets <branch_prefix><town>, and a branch that exists refuses.
printf 'branch_prefix = "simon/"\n' > "$TOMO_DATA_DIR/config.toml"; daemon_restart
read -r W5 P5 < <($T worktree create --repo "$R" --json | jq_ "print(d[0]['id'], d[0]['path'])")
S5=$(slug_of "$W5"); B5=$(git -C "$P5" rev-parse --abbrev-ref HEAD)
[ "$B5" = "simon/$S5" ] && check 0 "a create with no branch gets branch_prefix and the town" || check 1 "default branch" "$B5"
o=$($T worktree create --repo "$R" --branch "simon/$S5" --new --json 2>&1); rc=$?
[ $rc != 0 ] && check 0 "a branch that exists already fails in git worktree add" || check 1 "branch collision" "$o"

# branch_list: one row for each name, newest commit first, origin folded into the local branch.
git -C "$P5" commit -q --allow-empty -m newest
git -C "$R" remote add origin "$R" 2>/dev/null; git -C "$R" fetch -q origin
RID=$($T repo list --json | jq_ "print(d[0]['id'])")
o=$($RPC call branch_list "{\"repo_id\":\"$RID\"}")
has "$o" "d[0]['name']=='simon/$S5' and len([b for b in d if b['name']=='simon/$S5'])==1 and d[0]['remote'] is None and all(not b['name'].startswith('origin/') for b in d)" \
  && check 0 "branch_list puts the newest branch first and folds origin into the local branch" || check 1 "branch list" "$o"

daemon_stop
summary
