#!/bin/bash
# Config: config_set edits config.toml in place and keeps comments, disk edits reload live,
# and bad theme values fall back to Murasaki and show up in config_check.
set -u
. "$(dirname "$0")/lib.sh"

daemon_fresh '# my settings
shell = "/bin/sh" # keep me

[keybindings]
home = "mod+j" # muscle memory'
CFG="$TOMO_DATA_DIR/config.toml"
get() { $RPC call config_get | jq_ "$1"; }
set_() { $RPC call config_set "{\"key\":\"$1\",\"value\":$2}"; }
issue_keys() { $RPC call config_check | jq_ "print(' '.join(i['key'] for i in d))"; }
watch_config() { $RPC watch "$1" config_changed > "$2" & }

# 1. writes keep comments and the other keys
set_ theme.name '"paper"' >/dev/null
grep -q '^# my settings' "$CFG" && grep -q 'shell = "/bin/sh" # keep me' "$CFG" && grep -q 'home = "mod+j" # muscle memory' "$CFG" && check 0 "config_set keeps comments and other keys" || check 1 "comments kept" "$(cat "$CFG")"
[ "$(get "print(d['theme']['name'])")" = paper ] && check 0 "config_get reads the theme that config_set wrote" || check 1 "theme name" "$(get "print(d['theme'])")"
set_ keybindings.home '"mod+shift+h"' >/dev/null
grep -q 'home = "mod+shift+h" # muscle memory' "$CFG" && check 0 "a replaced value keeps its trailing comment" || check 1 "trailing comment" "$(cat "$CFG")"
set_ terminal.font_size 15 | jq_ "import sys; sys.exit(0 if d['font_size'] == 15 else 1)" && check 0 "config_set returns the reloaded config" || check 1 "font size result"
set_ keybindings.home null >/dev/null
[ "$(get "print(d['keybindings']['home'])")" = "mod+h" ] && check 0 "null removes the key and the default comes back" || check 1 "remove key" "$(cat "$CFG")"

# 2. refusals leave the file alone
BEFORE="$(cat "$CFG")"
set_ keybindings.home 5 >/dev/null 2>&1 && check 1 "a value with the wrong type is refused" || check 0 "a value with the wrong type is refused"
set_ sparkle true >/dev/null 2>&1 && check 1 "an unknown key is refused" || check 0 "an unknown key is refused"
set_ keybindings '"x"' >/dev/null 2>&1 && check 1 "a table cannot become a value" || check 0 "a table cannot become a value"
[ "$(cat "$CFG")" = "$BEFORE" ] && check 0 "refused writes do not change the file" || check 1 "file unchanged" "$(diff <(echo "$BEFORE") "$CFG")"

# 3. config_changed on a write
EV="$TOMO_DATA_DIR/events-set.txt"
watch_config 3 "$EV"; W=$!
sleep 0.8
set_ notifications.sounds true >/dev/null
wait $W
grep -q '"sounds": true' "$EV" && check 0 "config_set pushes config_changed" || check 1 "config_changed on set" "$(cat "$EV")"

# 4. an edit on disk reloads live; bad values fall back and are reported
EV="$TOMO_DATA_DIR/events-disk.txt"
watch_config 5 "$EV"; W=$!
sleep 0.8
python3 - "$CFG" <<'PY'
import sys
p = sys.argv[1]
text = open(p).read().replace('name = "paper"', 'name = "ink"\nbg = "blue"\nsparkle = "#fff"\naccent = "sora"')
open(p, "w").write(text)
PY
wait $W
grep -q '"name": "ink"' "$EV" && check 0 "an edit on disk reloads and pushes config_changed" || check 1 "disk edit event" "$(cat "$EV"; cat "$CFG")"
[ "$(get "print(sorted(d['theme']['colors'].items()))")" = "[('accent', 'sora')]" ] && check 0 "a malformed color is dropped and valid overrides stay" || check 1 "colors" "$(get "print(d['theme'])")"
KEYS="$(issue_keys)"
case "$KEYS" in *theme.bg*theme.sparkle*|*theme.sparkle*theme.bg*) check 0 "config_check reports the bad color and the unknown key" ;; *) check 1 "config_check theme issues" "$KEYS" ;; esac

# 5. a file that does not parse keeps the daemon up with defaults
printf 'this is [not toml\n' > "$CFG"
sleep 1.5
case "$(issue_keys)" in *config.toml*) check 0 "a broken file shows one config.toml issue" ;; *) check 1 "broken file issue" "$(issue_keys)" ;; esac
[ "$(get "print(d['theme']['name'])")" = system ] && check 0 "a broken file falls back to the system Murasaki theme" || check 1 "broken file theme" "$(get "print(d['theme'])")"
set_ theme.name '"ink"' >/dev/null 2>&1 && check 1 "config_set refuses to edit a file that does not parse" || check 0 "config_set refuses to edit a file that does not parse"

daemon_stop
summary
