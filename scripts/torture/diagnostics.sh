#!/bin/bash
# Diagnostics: config reloads and config problems go to diagnostics_list, not Activity.
# A problem that stays the same records once, and a new config error is also a notice.
set -u
. "$(dirname "$0")/lib.sh"

GOOD='shell = "/bin/sh"'
daemon_fresh "$GOOD"
CFG="$TOMO_DATA_DIR/config.toml"
sleep 1
diags() { $RPC call diagnostics_list '{}'; }
broken() { diags | jq_ "print(sum(1 for x in d if x['source'] == 'config' and x['level'] == 'warning' and 'Tomo uses the defaults' in x['message']))"; }
reloads() { diags | jq_ "print(sum(1 for x in d if x['source'] == 'config' and x['level'] == 'info' and x['message'] == 'config reloaded'))"; }

# 1. a file that does not parse records one config warning
printf 'this is [not toml\n' > "$CFG"
wait_for '[ "$(broken)" -ge 1 ]'
[ "$(broken)" = 1 ] && check 0 "a broken config.toml records a config warning" || check 1 "broken config warning" "$(diags)"

# 2. the same problem again records nothing new
printf 'this is [not toml\n\n' > "$CFG"
sleep 1.5
[ "$(broken)" = 1 ] && check 0 "a repeated problem records one diagnostic only" || check 1 "repeated problem" "$(diags)"

# 3. a fixed file records an info reload entry
BEFORE="$(reloads)"
printf '%s\n' "$GOOD" > "$CFG"
wait_for '[ "$(reloads)" -gt "$BEFORE" ]'
[ "$(reloads)" -gt "$BEFORE" ] && check 0 "a fixed config.toml records an info reload entry" || check 1 "reload entry" "$(diags)"
diags | jq_ "import sys; sys.exit(0 if d and d[0]['at_ms'] >= d[-1]['at_ms'] else 1)" && check 0 "diagnostics_list is newest first" || check 1 "newest first" "$(diags)"
[ "$($RPC call diagnostics_list '{"limit":1}' | jq_ "print(len(d))")" = 1 ] && check 0 "diagnostics_list honors the limit" || check 1 "limit"

# 4. a new config error is also a notice
EV="$TOMO_DATA_DIR/events-notice.txt"
$RPC watch 4 notice > "$EV" & W=$!
sleep 0.8
printf 'this is [not toml\n' > "$CFG"
wait $W
grep -q 'config problem' "$EV" && check 0 "a new config error pushes one notice" || check 1 "config notice" "$(cat "$EV")"

# 5. none of this is Activity
$RPC call activity_list '{"limit":200}' | jq_ "import sys; events = d if isinstance(d, list) else d.get('events', []); sys.exit(1 if any('config' in e['title'] for e in events) else 0)" && check 0 "config reloads and problems stay out of Activity" || check 1 "activity has config entries"

daemon_stop
summary
