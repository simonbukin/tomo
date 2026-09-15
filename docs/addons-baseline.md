# Addon refactor baseline

This document records the performance and the test counts of Tomo before the
Core / Client / Addon refactor. Every later milestone measures again with the
same commands and compares its numbers with this file. See
[addons.md](addons.md) for the refactor itself.

## Conditions

| Item | Value |
|---|---|
| Tree | master at `4ff28d3`, no local changes |
| Date | 2026-09-15 |
| Machine | Apple Silicon Mac, macOS (Darwin 25.6.0). The owner used the machine during the runs, so expect noise. |
| Daemon build for timings | `cargo build --release -p tomod -p tomo-cli` |
| Daemon build for soak and harness | debug (`target/debug`), because `scripts/torture/lib.sh` uses it |
| Data dirs | `/tmp/tomo-addons-m0-*` only. No run touched the default data dir or the installed daemon. |

Each timing ran at least 3 times. A "trial median" is the median of the
samples in one trial. The tables give the median of the trial medians, the
spread of the trial medians, and the smallest and largest single sample.

## Not measured

| Metric | Result |
|---|---|
| GUI cold launch | not measured (no GUI allowed) |
| GUI idle RSS | not measured (no GUI allowed) |

The architecture document has older app numbers: window created about 240 ms
and first daemon request about 430 ms after the process starts.

## Fixture

`scripts/addons-bench.py setup` makes a realistic daemon:

- 5 repositories, each with 40 committed files
- 25 linked worktrees (5 for each repository) plus 5 main worktrees, 30 in total
- 12 terminal panes in 12 linked worktrees
- about 1 MB of scrollback in each pane (`seq 1 150000`, at the 1 MB cap)
- a snapshot of 35 KB

```bash
W=<worktree root>
export TOMO_DATA_DIR=/tmp/tomo-addons-m0-bench TOMO_BIN=$W/target/release/tomo TOMO_DAEMON_BIN=$W/target/release/tomod
python3 $W/scripts/addons-bench.py setup
python3 $W/scripts/addons-bench.py ops 3
python3 $W/scripts/addons-bench.py idle 60 0    # 3 times
python3 $W/scripts/addons-bench.py idle 60 1    # 3 times
$TOMO_BIN daemon stop
```

The repositories go to `$TOMO_DATA_DIR-repos`. Town-named worktree
directories go next to each repository.

## Headline numbers

### Round trips (release daemon, `addons-bench.py ops 3`)

| Metric | Method | Median | Trial spread | Sample min..max |
|---|---|---|---|---|
| Reattach | New socket, `hello`, then `subscribe` and `pane_attach` until the scrollback `pane_output` frame arrives. 10 samples per trial. | **7.66 ms** | 7.58..8.85 | 7.12..14.23 |
| of which `subscribe` | Snapshot of 30 worktrees and 12 panes | 0.51 ms | 0.47..0.59 | 0.42..1.18 |
| of which `pane_attach` | 1 MB scrollback replay | 7.14 ms | 7.09..8.24 | 6.67..13.04 |
| Worktree switch | `worktree_open` on a worktree that has tabs. 20 samples per trial. | **0.14 ms** | 0.11..0.14 | 0.09..0.30 |
| Worktree switch with attach | `worktree_open`, then `pane_attach` until the scrollback frame arrives. This is what the GUI does on a switch. | **9.26 ms** | 8.76..10.29 | 7.17..11.89 |
| Refresh | `worktree_refresh` (full discovery, `git status` for 30 worktrees). 5 samples per trial. | **164.31 ms** | 154.45..167.70 | 149.70..205.75 |
| Process poll, fresh | Wait 1.6 s, then `ps` with `worktree_id: null`. The daemon polls again when its table is older than 1.5 s. 5 samples per trial. | **23.41 ms** | 22.50..23.73 | 0.66..26.64 |
| Process poll, cached | `ps` again at once | 0.63 ms | 0.63..0.65 | 0.37..1.11 |

Two "fresh" samples (1.42 ms and 0.66 ms) arrived just after a monitor tick,
so they used the cached table. The median is not affected.

The daemon has no timing log for the process poll. The timed `ps` call is the
measurement.

### Idle CPU and RSS (release daemon, `addons-bench.py idle`)

The fixture has 12 idle panes. Each window runs for 60 s, after a 3 s settle.
CPU is the `ps -o cputime` delta divided by the window.

| Metric | Run 1 | Run 2 | Run 3 | Median |
|---|---|---|---|---|
| Idle CPU, no subscriber (monitor every 15 s) | 0.13 % | 0.15 % | 0.13 % | **0.13 %** |
| Idle CPU, one subscribed client (monitor every 2 s, system stats every 5 s) | 0.97 % | 1.05 % | 1.13 % | **1.05 %** |
| RSS at window end, no subscriber | 14.8 MB | 14.5 MB | 14.6 MB | **14.6 MB** |
| RSS at window end, subscribed | 14.6 MB | 14.6 MB | 14.5 MB | **14.6 MB** |

The first window started at 31.2 MB RSS, directly after the `ops` run. The
memory went back to 14.8 MB during that window.

While a client is subscribed, the daemon does this background work:

- `system::run` runs `ioreg` every 5 s.
- `usage::run` can call the real Anthropic usage endpoint with the user's
  credentials. It also starts `codex app-server` if `~/.codex/auth.json`
  exists. The first fetch is about 20 s after a subscribe, then every 5 min.

This work is part of the subscribed number.

### `scripts/perf.sh` (release daemon, 3 runs)

```bash
TOMO_PERF_DIR=/tmp/tomo-addons-m0-perf TOMO_PERF_SOURCE=/tmp/tomo-addons-m0-bench \
TOMOD=$W/target/release/tomod T=$W/target/release/tomo bash $W/scripts/perf.sh
```

Stop the bench daemon before a run, because the script copies
`tomo.sqlite3` from the source dir.

| Step | Run 1 | Run 2 | Run 3 | Median |
|---|---|---|---|---|
| socket ready | 92.7 ms | 8.1 ms | 7.2 ms | 8.1 ms |
| hello (see note) | 33.7 ms | 44.2 ms | 41.7 ms | 41.7 ms |
| subscribe (before discovery, 0 worktrees) | 0.8 ms | 1.4 ms | 2.4 ms | 1.4 ms |
| worktrees visible after launch | 239.8 ms | 224.8 ms | 213.1 ms | 224.8 ms |
| summaries done after launch | 437.9 ms | 446.7 ms | 394.1 ms | 437.9 ms |
| `worktree_refresh` | 175.7 ms | 173.5 ms | 197.5 ms | 175.7 ms |
| `ps` fresh | 8.7 ms | 9.6 ms | 7.9 ms | 8.7 ms |
| `ps` cached | 0.3 ms | 0.3 ms | 0.3 ms | 0.3 ms |
| `worktree_list` | 0.2 ms | 0.2 ms | 0.2 ms | 0.2 ms |
| idle CPU, 20 s subscribed | 0.5 % | 0.5 % | 0.5 % | 0.5 % |
| RSS | 16 MB | 16 MB | 17 MB | 16 MB |

Notes on `perf.sh`. The script was not changed.

- It sends `hello` with `protocol: 1`, and the daemon speaks protocol 3. The
  `hello` row is the time of an error reply. Do not compare it with a real
  `hello`.
- It calls `subscribe` before discovery ends, so the snapshot has 0 worktrees.
- Its default binaries are the installed ones in `~/.local/bin`. Always set
  `TOMOD` and `T`.
- A fresh `ps` in `perf.sh` (8.7 ms) is faster than in the bench (23.4 ms).
  The `perf.sh` daemon had just started, and the bench daemon had 12 shells
  that had run for several minutes. This difference is not explained further.
  Compare each number only with the same method.

## Soak (`scripts/soak/busy.sh`, debug daemon, 300 s)

```bash
TOMO_DATA_DIR=/tmp/tomo-addons-m0-soak bash scripts/soak/busy.sh 300 /tmp/tomo-addons-m0-soak-report.md
```

The script honors `TOMO_DATA_DIR` through `lib.sh`. It writes the event count
to the fixed path `/tmp/tomo-soak-events.txt`.

The load has these parts:

- 5 repositories and 25 worktrees
- 16 panes: 10 shells and 6 fake Claude agents
- one fake Playwright process tree
- three shell loops that print every second
- 5 MB of scrollback filler
- a 200 MB memory hog

| Metric | Result |
|---|---|
| Result | **PASS**, tomod RSS bounded (21872 KB at 60 s, 20560 KB at 300 s) |
| tomod RSS under soak | min 20 MB, max 23 MB, last 20 MB |
| tomod CPU (`ps %cpu`, decayed average) | min 0 %, max 10.3 %, last 3.6 % |
| `tomo ps --json` (debug CLI process, round trip) | min 31 ms, max 90 ms |
| `tomo worktree list --json` (debug CLI process) | min 26 ms, max 53 ms |
| Events during run | 429 |

The two CLI timings include the start of a debug CLI process. Do not compare
them with the socket round trips above.

## Tests

### Rust: `cargo test --workspace`

| Crate (test target) | Passed |
|---|---|
| `tomod` (bin unit tests) | 109 |
| `tomo-proto` (lib unit tests, including the generated bindings check) | 4 |
| `tomo_app_lib` (`app/src-tauri`) | 2 |
| `tomo` CLI (bin) | 0 |
| `tomo_app` (bin) | 0 |
| Doc tests | 0 |
| **Total** | **115 passed, 0 failed** |

### Frontend (in `app/`)

| Check | Result |
|---|---|
| `npx tsc --noEmit` | exit 0 |
| `npx vitest run` | **27 files, 194 tests passed** |
| `npx vite build` | built in 379 ms |

Bundle from `vite build`:

| Chunk | Size | Gzip |
|---|---|---|
| `index` (main JS) | 643.15 kB | 204.27 kB |
| `TerminalPane` (lazy) | 479.34 kB | 126.37 kB |
| `japan-towns` data (lazy) | 345.28 kB | 62.43 kB |
| `Towns` (lazy) | 126.62 kB | 39.20 kB |
| `actions` | 76.93 kB | 24.39 kB |
| `index` CSS | 61.46 kB | 12.46 kB |

`docs/architecture.md` says that the main bundle is about 295 KB. That
number is old. The main chunk is now 643 kB, which is still below the 800 KB
budget.

### Torture harness

```bash
TOMO_DATA_DIR=/tmp/tomo-addons-m0-harness bash scripts/torture/run-all.sh
```

Wall time: 4 min 47 s. Overall: **PASS**.

| Script | Passed | Failed | Known |
|---|---|---|---|
| terminal | 17 | 0 | 0 |
| agents | 18 | 0 | 0 |
| provenance | 12 | 0 | 0 |
| layout | 15 | 0 | 0 |
| layout-move | 47 | 0 | 0 |
| archive | 17 | 0 | 0 |
| actions | 24 | 0 | 0 |
| runtime | 28 | 0 | 0 |
| activity | 25 | 0 | 0 |
| browser | 19 | 0 | 0 |
| towns | 6 | 0 | 0 |
| config | 16 | 0 | 0 |
| diagnostics | 7 | 0 | 0 |
| continuity | 19 | 0 | 0 |
| system | 8 | 0 | 0 |
| **Total** | **278** | **0** | **0** |

`provenance.sh` passed on the first run.

## Gate for later milestones

A milestone fails the performance gate if one of these is true. Measure again
first, because the machine is in use.

- A median round trip in this file becomes more than 20 % slower, and the
  difference is more than 1 ms.
- Idle CPU without a subscriber goes above 0.3 %.
- Idle CPU with a subscriber goes above 1.5 %.
- Idle RSS goes above 18 MB.
- The soak fails, or its maximum RSS goes above 28 MB.
- A test count goes down without a reason in the milestone report.
