#!/bin/bash
# Process provenance torture: owned trees, observed strangers, reparenting, disappearance.
set -u
. "$(dirname "$0")/lib.sh"

daemon_fresh
R=$(new_repo); $T repo add "$R" >/dev/null
WT=$(wt_id "$R")
ps_json() { $T ps --worktree "$WT" --json; }
count_pid() { ps_json | jq_ "print(sum(1 for p in d if p['pid']==$1))"; }
own_of() { ps_json | jq_ "m=[p['ownership'] for p in d if p['pid']==$1]; print(m[0] if m else 'absent')"; }

# owned tree from a pane
P=$($T pane create --worktree "$WT"); sleep 1.5
$RPC send "$P" "$FIX/fake-playwright-tree 40\r"; sleep 4
TREE=$($RPC attach "$P" 1 | grep -o 'parent [0-9]* child [0-9]*' | tail -1)
PARENT=$(echo "$TREE" | awk '{print $2}'); CHILD=$(echo "$TREE" | awk '{print $4}')
[ -n "$PARENT" ] && check 0 "tree spawned (parent $PARENT)" || check 1 "tree spawn" "no pid line"
[ "$(own_of $PARENT)" = owned ] && [ "$(own_of $CHILD)" = owned ] && check 0 "parent and child are owned" || check 1 "ownership" "parent=$(own_of $PARENT) child=$(own_of $CHILD)"
grand=$(ps_json | jq_ "print(sum(1 for p in d if p['ppid']==$CHILD))")
[ "$grand" -ge 2 ] && check 0 "grandchildren under the child are visible ($grand)" || check 1 "grandchildren" "$grand"
dups=$(ps_json | jq_ "ids=[p['pid'] for p in d]; print(len(ids)-len(set(ids)))")
[ "$dups" = 0 ] && check 0 "no pid counted twice" || check 1 "duplicate pids" "$dups"
# reparented (setsid) sleepers: cwd is the worktree, ppid is 1 -> observed at most
orphans=$(ps_json | jq_ "print([p['ownership'] for p in d if p['ppid'] in (1,) and 'sleep' in p['cmd']])")
case "$orphans" in *owned*) check 1 "reparented child must not be owned" "$orphans";; *) check 0 "reparented child is observed or absent ($orphans)";; esac

# memory hog attribution
H=$($T pane create --worktree "$WT"); sleep 1.5
$RPC send "$H" "$FIX/memory-hog 300 40 &\r"
hog=0; for i in 1 2 3 4 5 6 7; do sleep 1.6; v=$(ps_json | jq_ "print(max([p['rss_bytes'] for p in d if p['name']=='perl'] or [0]))"); [ "$v" -gt "$hog" ] && hog=$v; done
[ "$hog" -ge 150000000 ] && check 0 "memory hog attributed (peak $((hog/1048576)) MB)" || check 1 "memory hog" "peak $hog bytes"
$RPC call ps '{"worktree_id":null}' | python3 -c "
import json,sys; d=json.load(sys.stdin); mine=[p for p in d if p['worktree_id']=='$WT']
hog=max([p['rss_bytes'] for p in mine if p['name']=='perl'] or [0]); total=sum(p['rss_bytes'] for p in mine)
sys.exit(0 if hog>0 and total>=hog else 1)" && check 0 "worktree total includes the hog" || check 1 "total"

# observed strangers entering and leaving the worktree cwd
"$FIX/cwd-wanderer" enter "$R" 30 & WIN=$!
"$FIX/cwd-wanderer" leave "$R" 30 & WOUT=$!
sleep 2; [ "$(own_of $WOUT)" = observed ] && check 0 "stranger inside the worktree is observed" || check 1 "stranger inside" "$(own_of $WOUT)"
sleep 5; [ "$(own_of $WIN)" = observed ] && check 0 "stranger that cd'd into the worktree becomes observed" || check 1 "stranger entering stays $(own_of $WIN)"
sleep 2; [ "$(own_of $WOUT)" = absent ] && check 0 "stranger that left is gone" || check 1 "stranger leaving stays $(own_of $WOUT)"
$T kill $WIN >/dev/null 2>&1 && check 1 "kill must refuse an observed pid" || check 0 "kill refuses an observed pid"
kill $WIN $WOUT 2>/dev/null; wait $WIN $WOUT 2>/dev/null

# disappearing children vanish
kill $PARENT 2>/dev/null; sleep 6
[ "$(count_pid $PARENT)" = 0 ] && check 0 "dead parent disappears within 6 s" || check 1 "dead parent lingers"

daemon_stop
summary
