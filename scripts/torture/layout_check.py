#!/usr/bin/env python3
"""Reads `tomo tab list --json` on stdin; exits 1 unless the tab's layout is a valid tree with N leaves."""
import json, sys
tabs = json.load(sys.stdin)
tab = [t for t in tabs if t["id"] == sys.argv[1]][0]
ids, bad = [], []
def walk(n):
    if n["type"] == "leaf":
        ids.append(n["pane_id"]); return
    if not 0.05 <= n["ratio"] <= 0.95: bad.append(n["ratio"])
    walk(n["first"]); walk(n["second"])
walk(tab["layout"])
expected = int(sys.argv[2])
if len(ids) != len(set(ids)) or len(ids) != expected or bad:
    print(f"invalid: ids={ids} expected={expected} bad_ratios={bad}"); sys.exit(1)
print("ok", len(ids))
