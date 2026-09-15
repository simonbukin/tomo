#!/bin/bash
# GitHub: pr_status, its cache, pr_changed, the pr_merged activity, the town history PR, and the remote in Repo.
# A fake `gh` answers from files, so no run reaches GitHub.
set -u
. "$(dirname "$0")/lib.sh"

GHD=$(cd "$(mktemp -d /tmp/tomo-harness-gh.XXXX)" && pwd -P)
mkdir -p "$GHD/bin"
cat > "$GHD/bin/gh" <<EOF
#!/bin/bash
echo "\$(basename "\$PWD") \$*" >> "$GHD/calls"
name=\$(basename "\$PWD")
if [ -f "$GHD/\$name.json" ]; then cat "$GHD/\$name.json"; exit 0; fi
if [ -f "$GHD/\$name.none" ]; then echo "no pull requests found for branch \"x\"" >&2; exit 1; fi
printf 'gh: could not reach the host\nsecond line\n' >&2; exit 1
EOF
chmod +x "$GHD/bin/gh"
export PATH="$GHD/bin:/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:$PATH"

daemon_fresh
R=$(new_repo); git -C "$R" remote add origin git@github.com:acme/holly.git; $T repo add "$R" >/dev/null
has() { echo "$1" | jq_ "import sys; sys.exit(0 if $2 else 1)"; }
touch "$GHD/calls"
calls() { grep -c "^$1 " "$GHD/calls" || true; }
pr() { $RPC call pr_status "{\"worktree_id\":\"$1\"}"; }
new_wt() { $T worktree create --repo "$R" --branch "$1" --new --json | jq_ "print(d[0]['id'], d[0]['path'])"; }
pr_json() { printf '{"number":%s,"title":"%s","url":"https://github.com/acme/holly/pull/%s","state":"%s","isDraft":%s,"reviewDecision":"%s","mergeable":"%s","statusCheckRollup":[{"__typename":"CheckRun","status":"COMPLETED","conclusion":"SUCCESS"},{"__typename":"CheckRun","status":"IN_PROGRESS","conclusion":""},{"__typename":"StatusContext","state":"FAILURE"}]}' "$@"; }

o=$($T repo list --json)
has "$o" "d[0]['remote_url']=='git@github.com:acme/holly.git' and 'github' not in d[0]" && check 0 "repo list keeps the remote url, and core adds no GitHub field" || check 1 "repo list" "$o"
has "$($RPC call subscribe)" "d['repos'][0]['remote_url']=='git@github.com:acme/holly.git' and 'github' not in d['repos'][0]" && check 0 "the snapshot repo has the same remote fields" || check 1 "snapshot repo" "$($RPC call subscribe | head -c 400)"

read -r W1 P1 < <(new_wt feat/open); N1=$(basename "$P1")
pr_json 12 "Add kobe" 12 OPEN true CHANGES_REQUESTED CONFLICTING > "$GHD/$N1.json"
EV="$TOMO_DATA_DIR/pr-events"; $RPC watch 120 pr_changed > "$EV" & WATCH=$!; sleep 1

o=$(pr "$W1")
[ "$(calls "$N1")" = 1 ] || { fail "the daemon did not run the fake gh; stopping before a real gh runs"; daemon_stop; summary; exit 1; }
has "$o" "d['available'] and d['reason'] is None and d['pr']['number']==12 and d['pr']['state']=='open' and d['pr']['draft'] and d['pr']['review_decision']=='changes_requested' and d['pr']['mergeable']=='conflicting' and (d['pr']['checks_passed'],d['pr']['checks_failed'],d['pr']['checks_pending'])==(1,1,1) and d['pr']['fetched_at_ms']>0" \
  && check 0 "pr_status parses state, draft, review, mergeable, and checks" || check 1 "pr_status parse" "$o"
grep -q "^$N1 pr view --json number,title,url,state,isDraft,reviewDecision,mergeable,statusCheckRollup$" "$GHD/calls" && check 0 "gh runs pr view in the worktree directory" || check 1 "gh args" "$(cat "$GHD/calls")"

o2=$(pr "$W1")
[ "$(calls "$N1")" = 1 ] && [ "$o2" = "$o" ] && check 0 "a pull request fetched less than 60 s ago comes from the cache" || check 1 "cache" "calls=$(calls "$N1") $o2"

t=$($T pr "$W1")
[ "$t" = "$(printf '#12 Add kobe  open (draft)  changes_requested\nchecks  1 passed  1 failed  1 pending\nhttps://github.com/acme/holly/pull/12')" ] && check 0 "tomo pr prints the pull request" || check 1 "tomo pr text" "$t"
has "$($T pr "$W1" --json)" "d['pr']['number']==12 and d['available']" && check 0 "tomo pr --json prints the pr_status result" || check 1 "tomo pr json"

read -r W2 P2 < <(new_wt feat/none); N2=$(basename "$P2"); touch "$GHD/$N2.none"
o=$(pr "$W2"); pr "$W2" >/dev/null
has "$o" "d['available'] and d['reason'] is None and d['pr'] is None" && [ "$(calls "$N2")" = 2 ] && check 0 "no pull request is available, not cached, and asked again" || check 1 "no pr" "calls=$(calls "$N2") $o"
[ "$($T pr "$W2")" = "no pull request for this branch" ] && check 0 "tomo pr says when the branch has no pull request" || check 1 "tomo pr none" "$($T pr "$W2")"

read -r W3 P3 < <(new_wt feat/broken); N3=$(basename "$P3")
o=$(pr "$W3")
has "$o" "not d['available'] and d['reason']=='gh: could not reach the host' and d['pr'] is None" && check 0 "a gh error is unavailable with its first line" || check 1 "gh error" "$o"
[ "$($T pr "$W3")" = "unavailable: gh: could not reach the host" ] && check 0 "tomo pr prints the reason" || check 1 "tomo pr unavailable" "$($T pr "$W3")"

read -r W4 P4 < <(new_wt feat/merged); N4=$(basename "$P4")
pr_json 7 "Ship it" 7 MERGED false APPROVED UNKNOWN > "$GHD/$N4.json"
pr "$W4" >/dev/null; pr "$W4" >/dev/null
merged() { $T activity --json --worktree "$1" | jq_ "m=[e for e in d if e['kind']=='pr_merged']; print(json.dumps(m))"; }
has "$(merged "$W4")" "len(d)==1 and d[0]['title']=='PR #7 merged' and d[0]['detail']=='Ship it' and d[0]['payload']=={'number':7,'url':'https://github.com/acme/holly/pull/7'}" \
  && check 0 "a merged pull request records one pr_merged activity" || check 1 "pr_merged" "$(merged "$W4")"
has "$(merged "$W1")" "len(d)==0" && check 0 "an open pull request records no activity" || check 1 "open pr activity"

sleep 1; kill $WATCH 2>/dev/null; wait $WATCH 2>/dev/null
got=$(python3 -c "import json; print([(e['worktree_id'], (e['pr'] or {}).get('number')) for e in map(json.loads, open('$EV'))])")
[ "$got" = "[('$W1', 12), ('$W2', None), ('$W3', None), ('$W4', 7)]" ] \
  && check 0 "pr_changed fires on the first answer of each worktree, not for a cached pull request or a repeated none" || check 1 "pr_changed events" "$got"

slug_of() { $T towns list --unlocked --json | jq_ "print(next((r['town']['slug'] for r in d if r['unlock']['worktree_id']=='$1'), None))"; }
hist() { $RPC call town_history "{\"slug\":\"$(slug_of "$1")\"}"; }
has "$(hist "$W1")" "d['pr']=={'number':12,'url':'https://github.com/acme/holly/pull/12','state':'open'}" && check 0 "town history shows the cached pull request" || check 1 "town pr open" "$(hist "$W1")"
has "$(hist "$W2")" "d['pr'] is None" && check 0 "town history has no pull request when the branch has none" || check 1 "town pr none" "$(hist "$W2")"

daemon_restart
has "$(hist "$W4")" "d['pr']=={'number':7,'url':'https://github.com/acme/holly/pull/7','state':'merged'}" && check 0 "after a restart, town history takes the pull request from the pr_merged event" || check 1 "town pr from event" "$(hist "$W4")"
has "$(hist "$W1")" "d['pr'] is None" && check 0 "after a restart, the cache is empty" || check 1 "cache after restart" "$(hist "$W1")"
pr "$W4" >/dev/null
[ "$(calls "$N4")" = 2 ] && check 0 "after a restart, pr_status runs gh again" || check 1 "gh after restart" "calls=$(calls "$N4")"
has "$(merged "$W4")" "len(d)==2" && known "a restart forgets the cache, so the next pr_status records pr_merged again" || check 1 "pr_merged after restart" "$(merged "$W4")"

daemon_stop
rm -rf "$GHD"
summary
