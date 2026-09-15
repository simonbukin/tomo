#!/bin/bash
# Usage: TOMO_USAGE_MOCK replaces every provider, so no check reads a real login or calls the network.
# The daemon fetches on demand, sends usage_changed only on a change, warns once per threshold crossing,
# records an unavailable provider as a diagnostic, and polls in the background only with a subscriber.
set -u
. "$(dirname "$0")/lib.sh"

MOCK="$(mktemp -d /tmp/tomo-harness-usage.XXXX)/usage.json"
export TOMO_USAGE_MOCK="$MOCK"
FAR=9999999999999
# mock <claude weekly> <fable weekly> <fetched_at_ms> [codex json]
mock() {
  local codex="{\"provider\":\"codex\",\"available\":false,\"reason\":\"no Codex login\",\"buckets\":[],\"fetched_at_ms\":$3}"
  [ -n "${4:-}" ] && codex="$4"
  cat > "$MOCK" <<EOF
[{"provider":"claude","available":true,"reason":null,"fetched_at_ms":$3,"buckets":[
   {"label":"5-hour","fraction_used":0.36,"resets_at_ms":null,"detail":null},
   {"label":"weekly","fraction_used":$1,"resets_at_ms":null,"detail":null},
   {"label":"weekly","fraction_used":$2,"resets_at_ms":null,"detail":"warning","scope":"fable"}]},
 $codex]
EOF
}
NO_PARAMS='{}'
get() { $RPC call usage_get "${1:-$NO_PARAMS}"; }
weekly() { jq_ "print(next((b['fraction_used'] for s in d if s['provider']=='claude' for b in s['buckets'] if b['label']=='weekly' and not b.get('scope')), None))"; }
lines() { [ -s "$1" ] && wc -l < "$1" | tr -d ' ' || echo 0; }

mock 0.47 0.66 $FAR
daemon_fresh

# 1. the first usage_get fetches, because the daemon has no result yet
o=$(get)
echo "$o" | jq_ "import sys; c, x = d; sys.exit(0 if c['provider']=='claude' and c['available'] and [b.get('scope') for b in c['buckets']]==[None, None, 'fable'] and x['provider']=='codex' and not x['available'] and x['reason']=='no Codex login' else 1)" \
  && check 0 "usage_get fetches when the daemon has no result" || check 1 "first usage_get" "$o"

# 2. the CLI prints the same data; the text form does not show a scope
EXPECTED="claude   5-hour    36%
         weekly    47%
         weekly    66%     warning
codex    unavailable · no Codex login"
[ "$($T usage | sed 's/ *$//')" = "$EXPECTED" ] && check 0 "tomo usage prints one line per bucket" || check 1 "tomo usage text" "$($T usage)"
[ "$($T usage --json | jq_ "print(json.dumps(d, sort_keys=True))")" = "$(get | jq_ "print(json.dumps(d, sort_keys=True))")" ] \
  && check 0 "tomo usage --json is the usage_get list" || check 1 "tomo usage --json" "$($T usage --json)"

# 3. the subscribe snapshot carries the list in a top-level usage field
$RPC call subscribe | jq_ "import sys; sys.exit(0 if [s['provider'] for s in d['usage']]==['claude', 'codex'] else 1)" \
  && check 0 "the subscribe snapshot has usage" || check 1 "snapshot usage" "$($RPC call subscribe | head -c 300)"

# 4. refresh false returns the last result and does not fetch
mock 0.83 0.66 $FAR
[ "$(get | weekly)" = 0.47 ] && check 0 "usage_get without refresh keeps the last result" || check 1 "cached usage" "$(get)"

# 5. refresh true fetches, pushes usage_changed, and warns once for the crossing
EV="$TOMO_DATA_DIR/usage-changed.txt"; NO="$TOMO_DATA_DIR/usage-notice.txt"
watch_refresh() {
  $RPC watch 3 usage_changed > "$EV" & local a=$!
  $RPC watch 3 notice > "$NO" & local b=$!
  sleep 0.8
  get '{"refresh":true}' > /dev/null
  wait $a $b
}
watch_refresh
[ "$(get | weekly)" = 0.83 ] && check 0 "usage_get with refresh fetches again" || check 1 "refreshed usage" "$(get)"
[ "$(lines "$EV")" = 1 ] && jq_ "import sys; sys.exit(0 if len(d['snapshots'])==2 else 1)" < "$EV" && check 0 "a change pushes one usage_changed" || check 1 "usage_changed" "$(cat "$EV")"
[ "$(cat "$NO")" = '{"level": "warning", "message": "Claude weekly allowance 83%"}' ] && check 0 "a crossing pushes one warning notice" || check 1 "crossing notice" "$(cat "$NO")"

# 6. the same data with a new fetch time is not a change and does not warn again
mock 0.83 0.66 $((FAR - 1))
watch_refresh
[ "$(lines "$EV")" = 0 ] && [ "$(lines "$NO")" = 0 ] && check 0 "no change, no event, no repeated notice" || check 1 "unchanged refresh" "$(cat "$EV" "$NO")"

# 7. a scoped bucket names its model in the notice
mock 0.83 0.96 $FAR
watch_refresh
[ "$(cat "$NO")" = '{"level": "warning", "message": "Claude fable weekly allowance 96%"}' ] && check 0 "a scoped crossing names the model" || check 1 "scoped notice" "$(cat "$NO")"

# 8. an unavailable provider records one diagnostic, and its return records ok again
usage_diag() { $RPC call diagnostics_list '{}' | jq_ "print(sum(1 for x in d if x['source']=='usage' and x['level']=='$1' and x['message']=='$2'))"; }
[ "$(usage_diag warning 'codex usage: no Codex login')" = 1 ] && check 0 "an unavailable provider records one usage diagnostic" || check 1 "usage diagnostic" "$($RPC call diagnostics_list '{}')"
mock 0.83 0.96 $FAR '{"provider":"codex","available":true,"reason":null,"fetched_at_ms":1,"buckets":[{"label":"weekly","fraction_used":0.07,"resets_at_ms":null,"detail":null}]}'
get '{"refresh":true}' > /dev/null
[ "$(usage_diag info 'codex usage: ok again')" = 1 ] && check 0 "a provider that returns records ok again" || check 1 "ok again" "$($RPC call diagnostics_list '{}')"

# 9. a mock file that does not parse gives an empty list
echo 'not json' > "$MOCK"
[ "$(get '{"refresh":true}')" = "[]" ] && check 0 "a broken mock file gives no snapshots" || check 1 "broken mock" "$(get)"

# 10. background polling: a stale result is fetched again only while a client is subscribed
mock 0.50 0.10 0
get '{"refresh":true}' > /dev/null
mock 0.60 0.10 0
sleep 22
[ "$(get | weekly)" = 0.5 ] && check 0 "no subscriber, no background fetch" || check 1 "background fetch without subscriber" "$(get)"
$RPC watch 23 usage_changed > "$EV"
grep -q '"fraction_used": 0.6,' "$EV" && check 0 "a subscriber gets a background fetch of a stale result" || check 1 "background fetch with subscriber" "$(cat "$EV")"

daemon_stop
rm -rf "$(dirname "$MOCK")"
summary
