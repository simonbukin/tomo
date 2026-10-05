#!/bin/bash
# Editor panes and fs_read / fs_write through the raw socket: containment, conflicts, atomic writes,
# binary refusal, the file watch, and restore. No GUI.
set -u
. "$(dirname "$0")/lib.sh"

daemon_fresh
R=$(new_repo); $T repo add "$R" >/dev/null
WT=$(wt_id "$R")
mkdir -p "$R/src"; printf 'fn main() {}\n' > "$R/src/main.rs"
OUT="$(dirname "$R")/outside"; mkdir -p "$OUT"; echo secret > "$OUT/secret"

pane_field() { $T pane list --json | jq_ "p=[x for x in d if x['id']=='$1']; print(p[0]['$2'] if p else 'none')"; }
read_() { $RPC call fs_read "{\"worktree_id\":\"$WT\",\"path\":\"$1\"}" 2>&1; }
field() { jq_ "print(d['$1'])"; }
write_() { $RPC call fs_write "{\"worktree_id\":\"$WT\",\"path\":\"$1\",\"content\":$2,\"expected_version\":$3}" 2>&1; }

# 1. open: an editor pane in a new tab named after the file, live, no pid
E=$($RPC call editor_open "{\"worktree_id\":\"$WT\",\"path\":\"src/main.rs\",\"line\":3,\"col\":2}" | jq_ "print(d['pane']['id'])")
[ "$(pane_field "$E" kind)" = editor ] && check 0 "editor_open creates an editor pane" || check 1 "editor_open" "$(pane_field "$E" kind)"
[ "$(pane_field "$E" live)" = True ] && [ "$(pane_field "$E" pid)" = None ] && check 0 "editor pane is live without a pid" || check 1 "live/pid"
[ "$(pane_field "$E" title)" = main.rs ] && check 0 "editor pane is titled with the file name" || check 1 "title" "$(pane_field "$E" title)"
$RPC call editor_open "{\"worktree_id\":\"$WT\",\"path\":\"$R/src/main.rs\"}" | jq_ "import sys; sys.exit(0 if d['pane']['editor']['path']=='src/main.rs' else 1)" && check 0 "an absolute path inside the worktree becomes relative" || check 1 "absolute path"
$RPC send "$E" 'x' 2>&1 | grep -q bad_request && check 0 "pane_send on an editor pane is a bad request" || check 1 "pane_send guard"

# 2. containment
for p in "../outside/secret" "src/../../outside/secret" "$OUT/secret"; do
  read_ "$p" | grep -q "outside the worktree" && check 0 "fs_read refuses $p" || check 1 "fs_read containment $p" "$(read_ "$p")"
done
for p in "../outside/secret" "src/../../outside/secret"; do
  $RPC call editor_open "{\"worktree_id\":\"$WT\",\"path\":\"$p\"}" 2>&1 | grep -q bad_request && check 0 "editor_open refuses $p" || check 1 "editor_open containment $p"
done
REAL_SECRET=$(cd "$OUT" && pwd -P)/secret
$RPC call editor_open "{\"worktree_id\":\"$WT\",\"path\":\"$OUT/secret\"}" | jq_ "import sys; sys.exit(0 if d['pane']['editor']['path']=='$REAL_SECRET' else 1)" && check 0 "editor_open views an outside file by its real absolute path" || check 1 "editor_open outside file"
$RPC call editor_open "{\"worktree_id\":\"$WT\",\"path\":\"$OUT\"}" 2>&1 | grep -q bad_request && check 0 "editor_open refuses an outside folder" || check 1 "editor_open outside folder"
ln -s "$OUT/secret" "$R/leak"; ln -s "$OUT" "$R/leakdir"
read_ leak | grep -q "outside the worktree" && check 0 "fs_read refuses a symlink that leaves the worktree" || check 1 "symlink file"
write_ leakdir/new '"x"' null | grep -q "outside the worktree" && [ ! -e "$OUT/new" ] && check 0 "fs_write refuses a folder symlink that leaves the worktree" || check 1 "symlink dir"
[ "$(cat "$OUT/secret")" = secret ] && check 0 "the outside file is untouched" || check 1 "outside file changed"

# 3. binary, size, missing
printf 'a\0b' > "$R/nul.bin"; python3 -c "open('$R/big.txt','w').write('a'*(2*1024*1024+1))"
read_ nul.bin | grep -q "binary file" && check 0 "fs_read refuses a file with NUL bytes" || check 1 "binary" "$(read_ nul.bin)"
read_ big.txt | grep -q "up to 2 MB" && check 0 "fs_read refuses a file over 2 MB" || check 1 "size" "$(read_ big.txt)"
read_ nope.rs | grep -q not_found && check 0 "fs_read of a missing file is not_found" || check 1 "missing"

# 4. versions and conflicts
V=$(read_ src/main.rs | field version)
W=$(write_ src/main.rs '"fn main() { mine(); }\n"' "\"$V\"")
V2=$(echo "$W" | field version)
[ "$(cat "$R/src/main.rs")" = "fn main() { mine(); }" ] && check 0 "fs_write with the current version saves" || check 1 "save" "$W"
[ "$(read_ src/main.rs | field version)" = "$V2" ] && check 0 "fs_write returns the new version" || check 1 "new version"
printf 'fn main() { agent(); }\n' > "$R/src/main.rs"
write_ src/main.rs '"lost"' "\"$V2\"" | grep -q conflict && check 0 "fs_write with a stale version is a conflict" || check 1 "conflict"
grep -q agent "$R/src/main.rs" && check 0 "a conflict leaves the agent's text on disk" || check 1 "conflict wrote"
write_ src/main.rs '"x"' null | grep -q "already exists" && check 0 "fs_write with a null version refuses an existing file" || check 1 "null version"
V3=$(read_ src/main.rs | field version); rm "$R/src/main.rs"
write_ src/main.rs '"x"' "\"$V3\"" | grep -q "was deleted" && check 0 "fs_write to a deleted file is a conflict" || check 1 "deleted"
write_ src/main.rs '"back\n"' null >/dev/null && [ "$(cat "$R/src/main.rs")" = back ] && check 0 "fs_write with a null version recreates a deleted file" || check 1 "recreate"

# 5. atomic write keeps the mode, and a reader never sees half a file
printf '#!/bin/sh\n' > "$R/run.sh"; chmod 751 "$R/run.sh"
python3 - "$R/run.sh" > "$TOMO_DATA_DIR/reader.out" <<'EOF' &
import sys, time
end = time.time() + 4; bad = 0
while time.time() < end:
    s = open(sys.argv[1]).read()
    if s != "#!/bin/sh\n" and not (len(s) == 1 << 18 and s == s[0] * len(s)): bad += 1
print(bad)
EOF
READER=$!
for c in a b c d e f g h i j; do
  V=$(read_ run.sh | field version)
  write_ run.sh "\"$(python3 -c "print('$c'*(1<<18), end='')")\"" "\"$V\"" >/dev/null
done
wait $READER
[ "$(cat "$TOMO_DATA_DIR/reader.out")" = 0 ] && check 0 "a reader never sees a partial file during 10 writes of 256 KB" || check 1 "partial reads" "$(cat "$TOMO_DATA_DIR/reader.out")"
[ "$(stat -f %Lp "$R/run.sh")" = 751 ] && check 0 "fs_write keeps the file mode" || check 1 "mode" "$(stat -f %Lp "$R/run.sh")"
ls -a "$R" | grep -q '\.tmp$' && check 1 "temporary files left behind" || check 0 "no temporary file is left behind"

# 6. the watch reports an outside change to the open file, and its deletion
$RPC watch 4 file_changed > "$TOMO_DATA_DIR/events" &
WATCH=$!; sleep 1
printf 'fn main() { agent(); }\n' > "$R/src/tmp.rs" && mv "$R/src/tmp.rs" "$R/src/main.rs"
sleep 1; rm "$R/src/main.rs"
wait $WATCH
grep -q '"path": "src/main.rs"' "$TOMO_DATA_DIR/events" && check 0 "file_changed reports a rename over the open file" || check 1 "watch" "$(cat "$TOMO_DATA_DIR/events")"
[ "$(grep -c main.rs "$TOMO_DATA_DIR/events")" -ge 2 ] && check 0 "file_changed reports the deletion" || check 1 "watch delete" "$(cat "$TOMO_DATA_DIR/events")"

# 7. cursor and restore
$RPC call editor_cursor "{\"pane_id\":\"$E\",\"line\":7,\"col\":5}" >/dev/null
daemon_restart; sleep 1
$T pane list --json | jq_ "import sys; p=[x for x in d if x['id']=='$E']; sys.exit(0 if p and p[0]['kind']=='editor' and p[0]['editor']=={'path':'src/main.rs','line':7,'col':5} else 1)" \
  && check 0 "restart restores the editor pane with its file and cursor" || check 1 "restore" "$($T pane list --json | head -c 400)"

daemon_stop
summary
