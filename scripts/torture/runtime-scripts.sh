#!/bin/bash
# A server that a package script started outside its Action: the endpoint takes the script's name, and the Action
# adopts the pane that runs it, so a run shows that pane and starts no second copy.
set -u
. "$(dirname "$0")/lib.sh"

command -v pnpm >/dev/null || { known "pnpm is not installed"; summary; exit 0; }
daemon_fresh
R=$(new_repo); $T repo add "$R" >/dev/null
read -r WT P < <($T worktree create --repo "$R" --branch feat/scripts --new --json | jq_ "print(d[0]['id'], d[0]['path'])")
PORT=$(python3 -c 'import socket; s=socket.socket(); s.bind(("", 0)); print(s.getsockname()[1])')
printf '{ "name": "@demo/web", "scripts": { "serve": "python3 -m http.server %s --bind 127.0.0.1" } }\n' "$PORT" > "$P/package.json"
printf '[[actions]]\nid = "web"\nlabel = "Web"\ncommand = "pnpm serve"\nshow = "topbar"\n' > "$P/.tomo.toml"
wait_for "$T action list $WT --json | grep -q '\"web\"'" 6

# `tomo runtime` polls first when the last poll is old; with no client attached the daemon polls every 15 s.
label() { $T runtime "$WT" --json | jq_ "m=[e for e in d if e['port']==$PORT]; print(m[0]['label'] if m else 'none')"; }
adopted() { $T runtime "$WT" >/dev/null; $T action list "$WT" --json | jq_ "print((d.get('adopted') or {}).get('web', 'none'))"; }

X=$($T pane create --worktree "$WT"); sleep 1
$RPC send "$X" "pnpm serve\r"
wait_for "[ \"\$(label)\" != none ]" 15 && [ "$(label)" = "web serve" ] && check 0 "a server from a package script is named after the package and the script" || check 1 "script label" "$(label)"
wait_for "[ \"\$(adopted)\" = $X ]" 8 && check 0 "the Action adopts the pane that already runs its script" || check 1 "adopted" "$(adopted)"
before=$($T pane list --worktree "$WT" --json | jq_ "print(len(d))")
$T action run web "$WT" --json | jq_ "import sys; sys.exit(0 if d['reused'] and d['pane']['id']=='$X' else 1)" && check 0 "a run of the adopted Action shows that pane" || check 1 "adopted run" "$($T action run web "$WT" --json)"
[ "$($T pane list --worktree "$WT" --json | jq_ "print(len(d))")" = "$before" ] && check 0 "the run starts no second copy" || check 1 "second copy"
$RPC send "$X" $'\x03'
wait_for "[ \"\$(adopted)\" = none ]" 10 && check 0 "the Action lets go when the server stops" || check 1 "release" "$(adopted)"

daemon_stop
summary
