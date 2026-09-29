#!/bin/bash
# Search torture: file names, pane scrollback, a Claude session in a scratch HOME, cancellation, and the file cache.
set -u
. "$(dirname "$0")/lib.sh"

daemon_fresh
R=$(new_repo)
mkdir -p "$R/src" && echo x > "$R/src/searchable_widget.rs" && echo y > "$R/alpha.txt" && echo ignored.txt > "$R/.gitignore" && echo z > "$R/ignored.txt"
$T repo add "$R" >/dev/null
WT=$(wt_id "$R")

SESSIONS="$HOME/.claude/projects/$(printf '%s' "$R" | tr '/.' '--')"
mkdir -p "$SESSIONS"
cat > "$SESSIONS/s1.jsonl" <<'EOF'
{"type":"user","message":{"role":"user","content":"please fix the zebra crossing timer"},"gitBranch":"main"}
{"type":"assistant","message":{"content":[{"type":"thinking","thinking":"the okapi plan"},{"type":"text","text":"The zebra crossing timer is fixed."},{"type":"tool_use","input":{"cmd":"grep narwhal"}}]}}
{"type":"user","message":{"content":[{"type":"tool_result","content":"narwhal.rs:1: fn narwhal()"}]}}
{"type":"ai-title","aiTitle":"Crossing timer fix"}
EOF

P=$(pane_new "$WT"); sleep 1.5
$RPC send "$P" "echo quokka-\$((40+2))\r"
wait_for "$RPC attach $P 0.5 | grep -q quokka-42" 20

search() { $RPC search "$@"; }
field() { python3 -c "import json,sys; d=json.loads(sys.argv[1]); print(eval(sys.argv[2]))" "$1" "$2"; }

OUT=$(search searchable '["file"]')
[ "$(field "$OUT" "[h[0] for h in d['file']['hits']]")" = "['src/searchable_widget.rs']" ] && check 0 "a file name matches" || check 1 "file hit" "$OUT"
OUT=$(search "widget.rs:7" '["file"]')
[ "$(field "$OUT" "d['file']['hits'][0][2]['line']")" = 7 ] && check 0 "path:line opens at the line" || check 1 "path:line" "$OUT"
OUT=$(search ignored '["file"]')
[ "$(field "$OUT" "d['file']['total']")" = 0 ] && check 0 "an ignored file is not listed" || check 1 "ignored file" "$OUT"

OUT=$(search quokka-42 '["terminal"]')
[ "$(field "$OUT" "d['terminal']['hits'][0][2]['pane_id']")" = "$P" ] && check 0 "scrollback of a pane matches, with the pane as the target" || check 1 "terminal hit" "$OUT"
OUT=$(search qu '["terminal"]')
[ "$(field "$OUT" "d['terminal']['total']")" = 0 ] && check 0 "a query under three characters does not scan scrollback" || check 1 "short terminal query" "$OUT"

OUT=$(search zebra '["session"]')
[ "$(field "$OUT" "(d['session']['hits'][0][0], d['session']['hits'][0][2]['session_id'], d['session']['hits'][0][2]['pane_id'])")" = "('Crossing timer fix', 's1', None)" ] \
  && check 0 "a session matches by message text, with its title, and resumes when no pane runs it" || check 1 "session hit" "$OUT"
case "$(field "$OUT" "d['session']['hits'][0][1]")" in *"zebra crossing timer is fixed"*) check 0 "the snippet is the newest matching message" ;; *) check 1 "session snippet" "$OUT" ;; esac
for word in narwhal okapi; do
  OUT=$(search $word '["session"]')
  [ "$(field "$OUT" "d['session']['total']")" = 0 ] && check 0 "tool output and thinking do not match ($word)" || check 1 "$word in session" "$OUT"
done
OUT=$(search crossing '["session"]')
[ "$(field "$OUT" "d['session']['hits'][0][1] is not None")" = True ] && check 0 "a title match also carries its message snippet" || check 1 "title match" "$OUT"
echo '{"type":"user","message":{"content":"now the pelican bridge"}}' >> "$SESSIONS/s1.jsonl"
OUT=$(search pelican '["session"]')
[ "$(field "$OUT" "d['session']['total']")" = 1 ] && check 0 "a line added to a session is found at the next search" || check 1 "appended line" "$OUT"

OUT=$(search quokka-42 null zebra searchable)
[ "$(field "$OUT" "d['terminal']['total']")" = 1 ] && check 0 "the newest query answers after two earlier ones on the connection" || check 1 "newest query" "$OUT"
[ "$(field "$OUT" "all(k in d for k in ['file','terminal','session','activity'])")" = True ] && check 0 "every source finishes" || check 1 "sources done" "$OUT"
echo "INFO stale frames of cancelled queries: $(field "$OUT" "len(d.get('stale', []))"); timings: $(field "$OUT" "[(k, v['first_ms'], v['done_ms']) for k, v in d.items() if isinstance(v, dict)]")"

echo y > "$R/brand_new_file.txt"; git -C "$R" add brand_new_file.txt
found=1
for _ in 1 2 3 4 5 6 7 8 9 10; do
  sleep 0.6
  [ "$(field "$(search brand_new '["file"]')" "d['file']['total']")" = 1 ] && { found=0; break; }
done
check $found "a Git change reads the file list again"

daemon_stop
summary
