# Shared helpers for the torture and soak harnesses. Source this file.
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
export TOMO_DATA_DIR="${TOMO_DATA_DIR:-/tmp/tomo-harness}"
export TOMO_DAEMON_BIN="${TOMO_DAEMON_BIN:-$ROOT/target/debug/tomod}"
export TOMO_BIN="${TOMO_BIN:-$ROOT/target/debug/tomo}"
T="$TOMO_BIN"
RPC="python3 $ROOT/scripts/torture/tomo_rpc.py"
FIX="$ROOT/scripts/fixtures"
PASS_COUNT=0; FAIL_COUNT=0

pass() { PASS_COUNT=$((PASS_COUNT+1)); echo "PASS $1"; }
fail() { FAIL_COUNT=$((FAIL_COUNT+1)); echo "FAIL $1"; }
known() { KNOWN_COUNT=$((${KNOWN_COUNT:-0}+1)); echo "KNOWN $1"; }
check() { if [ "$1" = 0 ]; then pass "$2"; else fail "$2${3:+ ($3)}"; fi; }
summary() { echo "== $PASS_COUNT passed, $FAIL_COUNT failed, ${KNOWN_COUNT:-0} known limitations"; [ "$FAIL_COUNT" = 0 ]; }

daemon_fresh() {
  $T daemon stop >/dev/null 2>&1; sleep 0.5
  rm -rf "$TOMO_DATA_DIR"; mkdir -p "$TOMO_DATA_DIR"
  [ -n "${1:-}" ] && printf '%s\n' "$1" > "$TOMO_DATA_DIR/config.toml"
  $T daemon start >/dev/null
}
daemon_restart() { $T daemon stop >/dev/null; sleep 1; until $T daemon status >/dev/null 2>&1; do $T daemon start >/dev/null 2>&1; sleep 0.5; done; }
daemon_stop() { $T daemon stop >/dev/null 2>&1; }

new_repo() { local d; d="$(mktemp -d /tmp/tomo-harness-repo.XXXX)"; d="$(cd "$d" && pwd -P)/repo"; git init -q "$d"; git -C "$d" commit -q --allow-empty -m init; echo "$d"; }
wt_id() { $T worktree list --json | python3 -c "import json,sys; print([w['id'] for w in json.load(sys.stdin) if w['path']=='$1'][0])"; }
pane_new() { $T pane create --worktree "$1" ${2:+-- $2}; }
jq_() { python3 -c "import json,sys; d=json.load(sys.stdin); $1"; }
wait_for() { local n=0; until eval "$1" >/dev/null 2>&1 || [ $n -ge "${2:-20}" ]; do sleep 0.5; n=$((n+1)); done; eval "$1" >/dev/null 2>&1; }
