#!/bin/bash
# System stats: the system_stats call, its value ranges, the top worktree, the pushed event, and parallel calls.
set -u
. "$(dirname "$0")/lib.sh"

daemon_fresh
stats() { $RPC call system_stats; }

stats | jq_ "
import sys
ok = 0 <= d['cpu_percent'] <= 100 and 0 < d['memory_used_bytes'] <= d['memory_total_bytes'] and d['daemon_rss_bytes'] > 0 and d['at_ms'] > 0
sys.exit(0 if ok else 1)" && check 0 "cpu, memory, and daemon rss are in range" || check 1 "ranges" "$(stats)"

stats | jq_ "
import sys
g = d['gpu_percent']; u = d['vram_used_bytes']; t = d['vram_total_bytes']
ok = (g is None or 0 <= g <= 100) and ((u is None) == (t is None)) and (u is None or u <= t)
sys.exit(0 if ok else 1)" && check 0 "gpu is absent or 0-100; vram is absent or used <= total" || check 1 "gpu and vram" "$(stats)"

[ "$(uname)" = Darwin ] && [ "$(stats | jq_ "print(d['gpu_percent'] is not None)")" = True ] && check 0 "macOS reports GPU utilization" || { [ "$(uname)" = Darwin ] && known "no GPU utilization from ioreg on this Mac"; }

[ "$(stats | jq_ "print(d['top_worktree'])")" = None ] && check 0 "no worktree processes means no top worktree" || check 1 "top worktree on a fresh daemon" "$(stats)"

R=$(new_repo); $T repo add "$R" >/dev/null
WT=$(wt_id "$R")
P=$(pane_new "$WT" "sleep 60")
wait_for "[ \"\$(stats | jq_ \"t=d['top_worktree']; print(t and t['worktree_id'])\")\" = $WT ]" 40 && check 0 "top worktree is the one with processes" || check 1 "top worktree" "$(stats)"

N=$($RPC watch 12 system_stats | wc -l | tr -d ' ')
[ "$N" -ge 1 ] && [ "$N" -le 4 ] && check 0 "a subscribed client gets system_stats every few seconds ($N in 12 s)" || check 1 "system_stats cadence" "$N events in 12 s"

$RPC watch 7 system_stats | head -1 | jq_ "
import sys
sys.exit(0 if 0 <= d['stats']['cpu_percent'] <= 100 and d['stats']['memory_total_bytes'] > 0 else 1)" && check 0 "the event carries a full sample" || check 1 "event payload"

start=$(date +%s)
pids=""; for i in $(seq 1 20); do ( stats >/dev/null ) & pids="$pids $!"; done
bad=0; for p in $pids; do wait "$p" || bad=$((bad+1)); done
elapsed=$(( $(date +%s) - start ))
[ "$bad" = 0 ] && [ "$elapsed" -le 15 ] && check 0 "20 parallel calls succeed (${elapsed}s)" || check 1 "parallel calls" "$bad failed, ${elapsed}s"

daemon_stop
summary
