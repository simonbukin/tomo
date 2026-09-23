#!/bin/bash
# Deterministic "busy Tomo" soak: many repos, panes, fake agents, process trees; samples resource use.
# Usage: scripts/soak/busy.sh [duration_s] [report_path]
set -u
. "$(dirname "$0")/../torture/lib.sh"
DURATION="${1:-300}"; REPORT="${2:-/tmp/tomo-soak-report.md}"; INTERVAL=10

daemon_fresh "[agents.claude]
command = \"$FIX/fake-agent\"
args = [\"--tomo\", \"$T\"]"
TAGS=(lr engine ui infra japanese)
WTS=()
for r in 1 2 3 4 5; do
  R=$(new_repo); $T repo add "$R" >/dev/null
  for w in 1 2 3 4; do $T worktree create --repo "$R" --branch "feat/w$w" --new >/dev/null; done
done
WTS=($($T worktree list --json | jq_ "print(' '.join(w['id'] for w in d))"))
i=0
for wt in "${WTS[@]}"; do
  $T worktree metadata set "$wt" --tags "${TAGS[$((i % 5))]},${TAGS[$(((i+1) % 5))]}" >/dev/null 2>&1
  i=$((i+1))
done
echo "worktrees: ${#WTS[@]}"

PANES=()
for k in 0 1 2 3 4 5 6 7 8 9; do PANES+=("$($T pane create --worktree "${WTS[$((k % ${#WTS[@]}))]}")"); done
sleep 2
for k in 0 1 2 3 4 5; do $T agent spawn claude --worktree "${WTS[$k]}" >/dev/null; done
sleep 4
AGENTS=($($T agent list --json | jq_ "print(' '.join(a['pane_id'] for a in d))"))
$RPC send "${PANES[0]}" "$FIX/fake-playwright-tree $((DURATION + 30))\r"
for k in 1 2 3; do $RPC send "${PANES[$k]}" "while true; do echo dev-server-$k \$(date +%s); sleep 1; done\r"; done
$RPC send "${PANES[4]}" "yes scrollback-filler | head -c 5000000; echo filled\r"
$RPC send "${PANES[5]}" "$FIX/memory-hog 200 $((DURATION + 30)) &\r"
echo "panes: ${#PANES[@]} agents: ${#AGENTS[@]}"

pid=$(pgrep -f "$TOMO_DAEMON_BIN" | head -1)
ms() { python3 -c 'import time; print(int(time.time()*1000))'; }
sample() { local t0 t1; t0=$(ms); $T ps --json >/dev/null; t1=$(ms); PS_MS=$((t1 - t0)); t0=$(ms); $T worktree list --json >/dev/null; t1=$(ms); WL_MS=$((t1 - t0)); RSS_KB=$(ps -o rss= -p "$pid" | tr -d ' '); CPU=$(ps -o %cpu= -p "$pid" | tr -d ' '); }

echo "| t (s) | tomod RSS MB | tomod CPU % | ps ms | worktree list ms | events/10s |" > "$REPORT"
echo "|---|---|---|---|---|---|" >> "$REPORT"
FIRST_RSS=""; LAST_RSS=""; n=0; elapsed=0
$RPC events "$DURATION" > /tmp/tomo-soak-events.txt &
while [ "$elapsed" -lt "$DURATION" ]; do
  k=$((n % ${#AGENTS[@]})); $RPC send "${AGENTS[$k]}" "work 3\r" 2>/dev/null
  [ $((n % 3)) = 0 ] && $RPC send "${AGENTS[$(((k+1) % ${#AGENTS[@]}))]}" "wait\r" 2>/dev/null
  [ $((n % 4)) = 0 ] && $T worktree metadata set "${WTS[$((n % ${#WTS[@]}))]}" --tags "${TAGS[$((n % 5))]},${TAGS[$(((n+2) % 5))]}" >/dev/null 2>&1
  sleep "$INTERVAL"; elapsed=$((elapsed + INTERVAL)); n=$((n+1))
  sample
  [ "$elapsed" -ge 60 ] && [ -z "$FIRST_RSS" ] && FIRST_RSS=$RSS_KB
  LAST_RSS=$RSS_KB
  echo "| $elapsed | $((RSS_KB/1024)) | $CPU | $PS_MS | $WL_MS | - |" >> "$REPORT"
  echo "t=${elapsed}s rss=$((RSS_KB/1024))MB cpu=$CPU% ps=${PS_MS}ms list=${WL_MS}ms"
done
wait
EVENTS=$(cat /tmp/tomo-soak-events.txt 2>/dev/null || echo 0)
{
  echo; echo "events during run: $EVENTS"
  python3 - "$REPORT" <<'EOF'
import sys, re
rows=[l for l in open(sys.argv[1]) if l.startswith('| ') and not l.startswith('| t')]
cols=[[float(c.strip()) for c in r.strip('|\n').split('|')[1:5]] for r in rows]
names=["tomod RSS MB","tomod CPU %","ps ms","worktree list ms"]
for i,nm in enumerate(names):
    v=[c[i] for c in cols]; print(f"- {nm}: min {min(v):.0f}, max {max(v):.0f}, last {v[-1]:.0f}")
EOF
} >> "$REPORT"
cat "$REPORT"
daemon_stop
if [ -n "$FIRST_RSS" ] && [ "$LAST_RSS" -gt $((FIRST_RSS * 13 / 10)) ]; then echo "FAIL tomod RSS grew ${FIRST_RSS}KB -> ${LAST_RSS}KB (>30%)"; exit 1; fi
echo "PASS tomod RSS bounded (${FIRST_RSS:-n/a}KB at 60s -> ${LAST_RSS}KB)"
