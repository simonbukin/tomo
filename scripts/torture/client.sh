#!/bin/bash
# Client independence proof: a headless Python client reads and drives Tomo over the socket only.
set -u
. "$(dirname "$0")/lib.sh"

daemon_fresh "[agents.claude]
command = \"$FIX/fake-agent\"
args = [\"--tomo\", \"$T\"]"
R=$(new_repo)

while IFS= read -r line; do
  case "$line" in
    "PASS "*) pass "${line#PASS }" ;;
    "FAIL "*) fail "${line#FAIL }" ;;
    *) echo "$line" ;;
  esac
done < <(python3 "$ROOT/scripts/torture/headless_client.py" "$R")

daemon_stop
summary
