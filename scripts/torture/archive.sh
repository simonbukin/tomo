#!/bin/bash
# Archive checkpoint matrix: what lands on the branch, what refuses, what survives.
set -u
. "$(dirname "$0")/lib.sh"

# A scratch home under /tmp, so the harness never writes a worktree into the real ~/tomo.
export HOME=$(cd "$(mktemp -d /tmp/tomo-home-XXXXXX)" && pwd -P)
export GIT_AUTHOR_NAME=tomo GIT_AUTHOR_EMAIL=tomo@example.com GIT_COMMITTER_NAME=tomo GIT_COMMITTER_EMAIL=tomo@example.com

daemon_fresh
R=$(new_repo); $T repo add "$R" >/dev/null

mk() { $T worktree create --repo "$R" --branch "$1" --new --json | jq_ "print(d[0]['id'], d[0]['path'])"; }
subject() { git -C "$R" log -1 --format=%s "$1"; }
count() { git -C "$R" rev-list --count "$1"; }
files() { git -C "$R" ls-tree -r --name-only "$1"; }
stat_of() { git -C "$R" show --stat --format= "$1"; }
archive() { $T worktree archive "$@" --json 2>&1; }
panes_in() { $T pane list --worktree "$1" --json | jq_ "print(len(d))"; }
gone() { [ ! -e "$1" ]; }

# 1. clean tree: no checkpoint, archived
read -r W P < <(mk feat/clean)
o=$(archive "$W"); c=$(echo "$o" | jq_ "print(d['checkpoint_commit'])")
[ "$c" = None ] && [ "$(count feat/clean)" = 1 ] && gone "$P" && check 0 "clean tree archives without a checkpoint" || check 1 "clean tree" "$o"

# 2. dirty tracked file lands in the checkpoint
read -r W P < <(mk feat/tracked)
echo base > "$P/t.txt"; git -C "$P" add t.txt; git -C "$P" commit -qm "add t"
echo changed > "$P/t.txt"
o=$(archive "$W"); c=$(echo "$o" | jq_ "print(d['checkpoint_commit'])")
[ "$(subject feat/tracked)" = "tomo: archive checkpoint" ] && stat_of "$c" | grep -q t.txt && [ "$(git -C "$R" show feat/tracked:t.txt)" = changed ] && gone "$P" && check 0 "dirty tracked file is in the checkpoint" || check 1 "tracked checkpoint" "$o"

# 3. untracked file is included
read -r W P < <(mk feat/untracked)
echo new > "$P/u.txt"
o=$(archive "$W"); c=$(echo "$o" | jq_ "print(d['checkpoint_commit'])")
files feat/untracked | grep -qx u.txt && stat_of "$c" | grep -q u.txt && gone "$P" && check 0 "untracked file is in the checkpoint" || check 1 "untracked checkpoint" "$o"

# 4. gitignored file is left out; archive still succeeds
read -r W P < <(mk feat/ignored)
echo ignored.txt > "$P/.gitignore"; git -C "$P" add .gitignore; git -C "$P" commit -qm "ignore"
echo secret > "$P/ignored.txt"; echo kept > "$P/kept.txt"
o=$(archive "$W"); c=$(echo "$o" | jq_ "print(d['checkpoint_commit'])")
[ "$c" != None ] && ! files feat/ignored | grep -qx ignored.txt && files feat/ignored | grep -qx kept.txt && gone "$P" && check 0 "gitignored file stays out of the checkpoint" || check 1 "ignored file" "$o $(files feat/ignored | tr '\n' ' ')"

# 5. --no-checkpoint refuses dirty, accepts clean
read -r W P < <(mk feat/noc)
echo dirty > "$P/d.txt"
o=$(archive "$W" --no-checkpoint); rc=$?
[ $rc != 0 ] && case "$o" in *uncommitted*) [ -d "$P" ] && [ "$(count feat/noc)" = 1 ] && check 0 "--no-checkpoint refuses a dirty tree and keeps it" || check 1 "--no-checkpoint dirty" "tree gone or commit made";; *) check 1 "--no-checkpoint dirty" "$o";; esac || check 1 "--no-checkpoint dirty" "rc=$rc $o"
rm "$P/d.txt"
o=$(archive "$W" --no-checkpoint); c=$(echo "$o" | jq_ "print(d['checkpoint_commit'])" 2>/dev/null)
[ "$c" = None ] && gone "$P" && check 0 "--no-checkpoint archives a clean tree" || check 1 "--no-checkpoint clean" "$o"

# 6. --discard throws changes away, no commit
read -r W P < <(mk feat/discard)
echo lost > "$P/lost.txt"
o=$(archive "$W" --discard); c=$(echo "$o" | jq_ "print(d['checkpoint_commit'])")
[ "$c" = None ] && [ "$(count feat/discard)" = 1 ] && ! files feat/discard | grep -qx lost.txt && gone "$P" && check 0 "--discard archives with no checkpoint" || check 1 "--discard" "$o"

# 7. detached HEAD refuses
read -r W P < <(mk feat/detached)
git -C "$P" checkout -q --detach
o=$(archive "$W"); rc=$?
[ $rc != 0 ] && case "$o" in *detached*) [ -d "$P" ] && check 0 "detached HEAD is refused" || check 1 "detached" "tree removed";; *) check 1 "detached" "$o";; esac || check 1 "detached" "rc=0 $o"

# 8. merge conflict refuses; abort then succeeds
read -r W P < <(mk feat/conflict)
echo a > "$P/c.txt"; git -C "$P" add c.txt; git -C "$P" commit -qm "a side"
echo b > "$R/c.txt"; git -C "$R" add c.txt; git -C "$R" commit -qm "b side"
git -C "$P" merge -q "$(git -C "$R" symbolic-ref --short HEAD)" >/dev/null 2>&1
git -C "$P" status --porcelain | grep -q '^AA\|^UU' || echo "setup: no conflict produced"
o=$(archive "$W"); rc=$?
[ $rc != 0 ] && case "$o" in *conflict*) [ -d "$P" ] && check 0 "merge conflict is refused and the tree stays" || check 1 "conflict" "tree removed";; *) check 1 "conflict" "$o";; esac || check 1 "conflict" "rc=0 $o"
git -C "$P" merge --abort
o=$(archive "$W"); c=$(echo "$o" | jq_ "print(d['checkpoint_commit'])" 2>/dev/null)
[ "$c" = None ] && gone "$P" && check 0 "archive succeeds after merge --abort" || check 1 "after abort" "$o"

# 10. open panes: gone after archive, kept after a refusal
read -r W P < <(mk feat/panes)
$T worktree open "$W" >/dev/null; sleep 1
[ "$(panes_in "$W")" = 1 ] || echo "setup: expected one pane"
git -C "$P" checkout -q --detach
archive "$W" >/dev/null 2>&1
[ "$(panes_in "$W")" = 1 ] && [ -d "$P" ] && check 0 "refused archive keeps the open pane" || check 1 "pane after refusal" "$(panes_in "$W") panes"
git -C "$P" checkout -q feat/panes; echo dirty > "$P/p.txt"
o=$(archive "$W"); sleep 0.5
[ "$(panes_in "$W")" = 0 ] && gone "$P" && files feat/panes | grep -qx p.txt && check 0 "archive with an open pane closes it and checkpoints" || check 1 "pane after archive" "$o"

# 11. restore brings the checkpointed file back
W=$($T worktree list --json | jq_ "print([w['id'] for w in d if w['branch']=='feat/tracked'][0])")
$T worktree restore "$W" >/dev/null && P=$($T worktree list --json | jq_ "print([w['path'] for w in d if w['id']=='$W'][0])")
[ -f "$P/t.txt" ] && [ "$(cat "$P/t.txt")" = changed ] && check 0 "restore brings the checkpointed file back" || check 1 "restore" "$P"

# 12. a worktree in an old location, beside its repository, still opens and archives
OLD=$(cd "$(mktemp -d /tmp/tomo-home-old.XXXXXX)" && pwd -P)
$T worktree create --repo "$R" --branch feat/old --new --path "$OLD/legacy" --json >/dev/null
W=$(wt_id "$OLD/legacy")
$T worktree open "$W" >/dev/null; sleep 1
o=$(archive "$W"); gone "$OLD/legacy" && check 0 "a worktree in an old location opens and archives" || check 1 "old location" "$o"

$T config check >/dev/null 2>&1 && check 0 "config check passes with no hooks" || check 1 "config check (no hooks)"

# 9. a before_archive hook that fails aborts before the checkpoint
daemon_fresh '[[hooks]]
event = "worktree.before_archive"
command = "echo gate-says-no; exit 1"
timeout_s = 5'
$T config check >/dev/null 2>&1 && check 0 "config check passes with the gate hook" || check 1 "config check (gate hook)"
R=$(new_repo); $T repo add "$R" >/dev/null
read -r W P < <(mk feat/gated)
echo dirty > "$P/g.txt"
o=$(archive "$W"); rc=$?
[ $rc != 0 ] && case "$o" in *gate-says-no*) [ -d "$P" ] && [ "$(count feat/gated)" = 1 ] && [ -z "$(git -C "$P" log --format=%s | grep checkpoint)" ] && check 0 "failing before_archive hook refuses before any checkpoint" || check 1 "gate" "tree gone or checkpoint made";; *) check 1 "gate" "$o";; esac || check 1 "gate" "rc=0 $o"
$T hooks log --json -n 1 | jq_ "import sys; sys.exit(0 if d and d[-1]['event']=='worktree.before_archive' and not d[-1]['ok'] else 1)" && check 0 "gate run is logged as failed" || check 1 "gate log"

daemon_stop
summary
