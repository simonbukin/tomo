#!/bin/bash
# Runs every torture script against a scratch daemon and prints a summary.
cd "$(dirname "$0")/../.." || exit 1
cargo build -p tomod -p tomo-cli 2>&1 | grep -E "^error" && exit 1
export TOMO_DATA_DIR="${TOMO_DATA_DIR:-/tmp/tomo-harness}"
rc=0
for s in terminal agents provenance layout layout-move archive actions runtime activity browser; do
  echo "=== $s"
  bash "scripts/torture/$s.sh" || rc=1
done
echo "=== overall: $([ $rc = 0 ] && echo PASS || echo FAIL)"
exit $rc
