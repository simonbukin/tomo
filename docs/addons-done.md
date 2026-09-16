# Audit against the definition of done

This document examines the finished Core / Client / Addon refactor against
the definition of done of its PRD (section 37), its laws (section 1), and its
non-goals (section 3). It is an audit, not a guide. The architecture itself is
in [addons.md](addons.md); this file does not repeat it.

Tree: master at `7a2ff88`. Date: 2026-09-15.

**Method.** The audit reads the code, the documents, and the Git history. It
runs no build, no test, and no daemon, because the machine had too little
memory. Every number below comes from a recorded run. A claim that only a run
can settle is marked "not re-verified here", with its recorded evidence.

Measured on final master by the coordinator, and cited below:

| Check | Result |
|---|---|
| `cargo test --workspace` | 156 passed, 0 failed (tomod 144, proto 7, app lib 5) |
| `npx tsc --noEmit` | exit 0 |
| `npx vitest run` | 38 files, 272 tests |
| `npx vite build` | pass |
| `scripts/torture/run-all.sh` | PASS: 20 scripts, 408 passed, 0 failed, 7 known |
| Bench round trips | reattach 7.82 ms (baseline 7.66), `worktree_open` 0.09 (0.14), open and attach 7.49 (9.26), refresh 132.98 (164.31), `ps` fresh 16.22 (23.41), `ps` cached 0.46 (0.63) |
| Idle, no subscriber | 0.12–0.13 % CPU (baseline 0.13 %), RSS about 15.0 MB (14.6) |
| Idle, one subscriber | 0.80–0.90 % CPU (baseline 1.05 %), RSS about 15.1 MB (14.6) |
| Not measured on final master | `scripts/perf.sh`, the 300 s soak (the machine stopped both runs for low memory), GUI cold launch, GUI RSS |

## 1. The definition of done, bullet by bullet

Verdict counts: **15 met, 4 partly met, 0 not met, 1 not verifiable here.**

| # | PRD 37 bullet | Verdict | Evidence | Reason |
|---|---|---|---|---|
| 1 | All current user-facing behavior still works | partly met | Milestone sections "Small user-visible changes" and "Behavior changes" in [addons.md](addons.md); 272 vitest tests; 408 harness checks | Headless checks pass, but nobody opened a window in the whole refactor, and each milestone records small deliberate changes (palette order, the create placeholder, the endpoint label from the pane source, `localhost:3000`, the note count reset, the agent-aware Resolve button). |
| 2 | Current test suite is green | met | `cargo test --workspace` 156/0; tsc exit 0; vitest 38 files, 272 tests; `vite build` pass. Baseline: 115 Rust, 194 vitest ([addons-baseline.md](addons-baseline.md)) | Every suite is green and larger than the baseline. Not re-verified here; the counts are the coordinator's run on `7a2ff88`. |
| 3 | Soak and torture suites pass | partly met | `run-all.sh` PASS, 408 passed, 0 failed, 7 known. Last soak: milestone 5, `scripts/soak/busy.sh 300`, 2 runs PASS, maximum RSS 28 MB ([addons.md](addons.md) "Milestone 5 result: Usage") | The torture harness passes on final master. The soak has not run since milestone 5, eight milestones back. That run touched the gate ceiling of 28 MB, and the cause was never found. |
| 4 | Performance is unchanged or better | partly met | The six bench round trips above; idle CPU and RSS above; the gate in [addons-baseline.md](addons-baseline.md) | Every round trip is at or better than the baseline, and idle CPU and RSS are inside the limits. `scripts/perf.sh` and the soak did not run on final master, and GUI cold launch and GUI RSS were never measurable. |
| 5 | Core no longer depends on extracted addons | met | `core_does_not_import_addons`, `an_addon_does_not_name_another_addon`, `core_activity_code_does_not_name_addon_kinds` in `crates/tomod/src/addons/mod.rs`; 8 tests in `app/src/addons/boundary.test.ts`; `the_browser_host_does_not_name_agentation` in `app/src-tauri/src/lib.rs` | Core names an addon at four composition roots only: `main.rs`, `dispatch.rs`, `tomo-proto/src/lib.rs`, and the GUI and host roots. `rg -l "addons::"` finds no other Core file. The checks are text greps, not compiler rules; see section 3. |
| 6 | Towns is independently removable in principle | met | "Towns deletion test (milestone 1)" in [addons.md](addons.md): a throwaway branch from `26a5c66`, 29 files, 1141 lines deleted, 6 added, 8 registration files; results 112 Rust tests, 28 files and 190 vitest tests, `archive.sh` 17/0 | The recorded test exists and names every changed line. Two limits: it ran at the milestone 1 commit, not on `7a2ff88`, and the removed build keeps three expected compiler warnings for seams that no addon then uses. |
| 7 | GitHub concepts no longer pollute generic Git or core models | met | Commit `4904e59` removes `Repo.github`, `GitHubRepo`, and `git::github_repo`; `OWNED_NOUNS` "github" (9 nouns) in `addons/mod.rs`; the GitHub noun test in `boundary.test.ts`; "GitHub deletion test (milestone 2)" | `Repo.remote_url` and `Worktree.branch` stay as Git facts. The addon parses the owner in `app/src/addons/github/model.ts`. `PullRequest`, `review_decision`, `checks_failed`, and `mergeable` appear in Core in no file. |
| 8 | Actions are layered over lower-level spawn and process capabilities | met | `crates/tomod/src/addons/actions/`; `Seams.worktree_files` and `Seams.pane_exited` in `daemon.rs`; `Daemon::stop_pane`, `spawn_in_worktree`, `focus_pane`, `push_attention` | The addon composes Core functions. No `ActionRuntimeManager`, `ServiceRegistry`, or `JobManager` exists. Core keeps `Pane.action_id`, `HookEvent.action`, `HookAction`, and `AttentionKind::Crash` for wire compatibility, and each has a written reason. |
| 9 | Runtime discovery is separate from generic process provenance | met | `PaneSource { kind, id, label }` in `tomo-proto/src/lib.rs`; `Seams.process_polled` with `runtime::scan`; `crates/tomod/src/addons/runtime/`; the test "the Runtime and the Actions addon do not name each other" | Core owns the provenance; the addon reads it. Neither addon names the other, in Rust or in TypeScript. The scan runs on the existing monitor tick, so the cadence does not change. |
| 10 | Usage semantics are separate from the generic Agent abstraction | met | `crates/tomod/src/addons/usage/`; `addons::State.usage`; `OWNED_NOUNS` "usage" holds `weekly`, `5-hour`, and `allowance`; "Not moved, with the reason" in "Milestone 9 result" | The Core agent code names no window, quota, or allowance word. The provider table has no usage capability, by decision, so Core never names `UsageSnapshot`. `UsageSnapshot.provider: AgentKind` stays, because a provider id is Core identity. |
| 11 | Agentation depends on Browser, not the reverse | met | `browserToolbar` slot in `app/src/addons/types.ts`; `BROWSER_PAGE_LOADED` and `BROWSER_CLOSED` in `app/src-tauri/src/lib.rs`; `the_browser_host_does_not_name_agentation`; "core client files do not name Agentation" (it covers `app/src/browser/`); "Agentation deletion test (milestone 7)" | The deletion test changed no Browser and no Core file. Browser reaches Agentation only through two static hook lists and one slot. Both lists are `&[]` without the addon. |
| 12 | Activity needs no core taxonomy growth, or the deferral is documented | met | `ActivityKind` is a string newtype and `CoreActivity` is a closed enum of 9 kinds in `crates/tomo-proto/src/activity.rs`; each addon owns an enum in `addons/<name>.rs`; `app/src/activityKinds.ts` and `app/src/addons/activity.ts`; `core_activity_code_does_not_name_addon_kinds` and its vitest twin | A new addon adds a kind without a change in Core. The 16 stored strings do not change, and an unknown kind reads back as itself. The remaining milestone 8 UI cleanup is documented in "Candidates", although that row is now stale (see section 5). |
| 13 | Addon composition stays static and boring | met | `builtins` in `app/src/addons/index.ts` (one array of 6); `seams()`, `migrate()`, `start()` in `crates/tomod/src/addons/mod.rs`; the `match` in `dispatch.rs`; `pub mod addons` in `tomo-proto/src/lib.rs` | Composition is six literal lists. Nothing scans a folder, reads a manifest, or registers at run time. Order is the array order. |
| 14 | No plugin framework has been introduced | met | The same composition roots; "Question 1: a pane renderer registry" and "Decision: the shape of addon state" in [addons.md](addons.md) | No manifest, loader, version rule, or sandbox exists. Two designs that would have been a framework were examined and rejected: a pane renderer registry keyed by a string `PaneKind`, and a `HashMap<TypeId, Box<dyn Any>>` addon registry. |
| 15 | No generic service locator exists | met | `Inner.addons: Box<dyn Any + Send>` in `daemon.rs:89`; `addons::state` and `addons::state_mut` in `addons/mod.rs:26-32`; the decision table in "Addon state" | **I agree with the argument.** The slot holds one concrete type, `addons::State`, which the composition root names and builds. There is no key, no lookup, and no run-time registration, so a reader cannot ask "who provides X". The cost is real but small: the compiler cannot prove that the slot is full, so a caller that forgets it panics at the first access. See section 5. |
| 16 | No untyped protocol regression occurred | partly met | `Call`, `Event`, and `Snapshot` stay closed enums and structs with `ts-rs` bindings; `ActivityKind.ts` is now `string`; `PaneSource.kind` is a `String` | No generic `{kind, payload}` envelope exists anywhere on the wire. But two types became strings: the activity kind and the pane source kind. Each has a written reason, and each keeps a compile-time check on both sides (an owner enum in Rust, an exhaustive `Record` in TypeScript). At the wire level it is still a loss of type strength. |
| 17 | `docs/addons.md` clearly teaches the architecture | met | The file; "Agent hackability exercise" in it | An agent built a whole addon from the file alone in 9 minutes, and the 12 gaps it found are now closed. The file is 3335 lines, so PRD section 35 ("a few minutes") holds only for the first third; the rest is a milestone record. |
| 18 | An alternate client can consume Core state without React or Tauri | met | `scripts/torture/client.sh` and `scripts/torture/headless_client.py` (19 checks in `run-all.sh`); `app/src/clientModels.test.ts` (8 pure modules); [client-independence.md](client-independence.md) | A Python client that uses only the socket and the standard library drives repos, worktrees, tabs, panes, agents, attention, and checkpoints, and its state matches a fresh snapshot four times. The import check keeps the 8 shared models free of React, Tauri, and the store. |
| 19 | Deleting an addon does not conceptually damage Core | met | Six recorded deletion tests in [addons.md](addons.md): Towns (`26a5c66`), GitHub (`4c50df1`), Usage (`3a8499b`), Actions (`d1b0879`), Runtime (`a4055be`), Agentation (`1187f22`), plus anime-chart (commits `e9c25dd`, `2b19364`) | Each test names every changed line, and no Core file changes in any of them. Two tests delete a cross-addon test file (`Activity.test.tsx`, `composition.test.tsx`), which the rule allows, because a cross-addon test is a composition root. None ran on `7a2ff88`. |
| 20 | Tomo still feels instantaneous | not verifiable here | The bench round trips above; no GUI run in the whole refactor | Feel needs a window. The headless proxies are at or better than the baseline: a worktree switch is 0.09 ms, a cached `ps` is 0.46 ms, and a reattach with 1 MB of scrollback is 7.82 ms. |

## 2. The laws and the non-goals

### The laws (PRD section 1)

| Law | Verdict | Evidence |
|---|---|---|
| Core provides reality, lifetime, and coordination | met | Repos, worktrees, PTYs, panes, tabs, layout, processes, agents, attention, hooks, and recovery stay in `crates/tomod/src/*.rs` beside `addons/`. `providers/` is Core by the milestone 9 decision. |
| Clients render Tomo | met | The GUI renders addon parts only through the 21 slots of `Addon` in `app/src/addons/types.ts`. [client-independence.md](client-independence.md) lists what stays presentation-coupled and why. |
| Addons interpret and compose Tomo | met | Six addon folders in three places each: `crates/tomo-proto/src/addons/<name>.rs`, `crates/tomod/src/addons/<name>/`, `app/src/addons/<name>/`. |
| Core must never depend on an addon | met | The 7 Rust and Tauri checks and the 8 TypeScript checks of section 3. |
| Events report facts, commands request actions | met | Every addon join is a synchronous seam or a typed `Call`, never an event. `Seams` in `daemon.rs` is six fields of plain `fn` pointers. The PRD warned against "emit an event and hope the addon commits later"; the `worktree_created` seam exists for that reason. |
| Prefer direct typed calls over indirection | met | `dispatch.rs` is one `match` of 12 arms. `town_pr` is a plain function pointer, not an event or a shared table. |
| Static composition only | met | `crates/tomod/src/addons/mod.rs` (`pub mod` × 6, `seams()`, `migrate()`, `start()`) and `app/src/addons/index.ts` (`builtins` of 6). |
| No public plugin architecture | met | See non-goals below. |
| No background work without a reason | met | The background table in [addons.md](addons.md) "Performance law". Only Usage adds a task, and [usage.md](usage.md) gives its cadence. Runtime rides the existing monitor tick through `process_polled`. |
| Types before generic JSON envelopes | partly met | No envelope exists. Two narrow widenings do: `ActivityKind` (a string newtype with per-owner enums) and `PaneSource.kind` (a `String`, so Core names no addon). Both are documented decisions. |
| Deleting an addon should not damage Tomo | met | Six deletion tests; see section 3. |
| An abstraction is good only if it makes a feature simpler | met | Milestone 6 rejected the pane renderer registry, because the map was not shorter than the switch. Each milestone counts its slot lines against the lines that left the client core, and the slot code is always smaller. |

### The non-goals (PRD section 3)

All 18 are avoided. Notes on the four that need one:

| Non-goal | Verdict | Note |
|---|---|---|
| dynamic plugin discovery, manifests, runtime loading, marketplace, package manager, WASM host, dynamic Rust libraries, extension semver | avoided | Nothing reads a folder or a manifest. An addon is a `pub mod` line and an array entry. |
| sandboxing, permissions system | avoided | `app/src-tauri/capabilities/` is the Tauri permission file of the app, and it is older than this refactor. It is a registration line, not an addon permission model. `capabilities/browser.json` stays an open security surface; see section 4. |
| generic service locator, dependency injection framework | avoided | See bullet 15 above and "Decision: the shape of addon state". |
| generic workflow engine | avoided | `Seams` has six fields with one fixed call site each. No engine orders them. |
| arbitrary third-party UI injection | avoided | 21 named slots, each with one render site, one order rule, and a documented owner. There is no `registerArbitraryReactAnywhere`. |
| remote execution, TUI, mobile app | avoided | The client proof is a Python script in the harness, not a second client. |
| new product features | avoided | The one addon built for the exercise, `anime-chart`, was removed in `e9c25dd`. `Pane.source` and `RuntimeEndpoint.source` are provenance fields, not features. Three bug fixes changed behavior; each has its own commit and test. |

## 3. Dependency and deletion evidence

### Automated checks

| Check | File | What it forbids | Proven by a planted violation? |
|---|---|---|---|
| `core_does_not_import_addons` | `crates/tomod/src/addons/mod.rs` | `addons::`, `mod addons`, and 56 addon nouns in every `.rs` under `tomod/src` and `tomo-proto/src`, outside `addons/` and the three composition roots | **Yes.** A planted `addons::towns` line in a core file. Also planted: `// PullRequest review_decision` and `// ActionSet` and `// RuntimeEndpoint scan_endpoints lsof` in `procs.rs` or `monitor.rs`. |
| `an_addon_does_not_name_another_addon` | `crates/tomod/src/addons/mod.rs` | One addon file names a noun that another addon owns | **No planted proof is recorded** for the Rust check. Its TypeScript twin was proven. |
| `addon_modules_keep_no_mutable_static` | `crates/tomod/src/addons/mod.rs` | A `static` item whose line names `Mutex`, `RwLock`, `Atomic`, `Cell`, or `static mut`, under `tomod/src/addons/` | **Yes.** A planted `static PLANTED: std::sync::Mutex<u8>` in `towns/model.rs`. |
| `two_daemons_in_one_process_keep_their_own_addon_state` | `crates/tomod/src/addons/mod.rs` | Addon state that leaks between two daemons in one process | **Yes.** It was red on the three statics before the change (commit `982b412`). |
| `core_activity_code_does_not_name_addon_kinds` | `crates/tomod/src/addons/mod.rs` | An addon kind enum, an addon kind string, or `endpoint_repeat` in `activity.rs`, `store.rs`, `events.rs`, `tomo-proto/src/activity.rs` | **Yes.** A planted `ActionActivity::Crashed` doc line in `tomod/src/activity.rs`. |
| `only_provider_modules_branch_on_a_provider` | `crates/tomod/src/providers/mod.rs` | A branch on a provider outside `providers/` | **Yes.** A planted `// AgentKind::Claude` line in `monitor.rs`. |
| `the_browser_host_does_not_name_agentation` | `app/src-tauri/src/lib.rs` | `agentation`, `annotat`, or `feedback` in `browser.rs` and `main.rs` | **Yes.** A planted `// agentation` line in `app/src-tauri/src/browser.rs`. |
| "core client files reach addons only through `addons/index.ts` and `addons/types.ts`" | `app/src/addons/boundary.test.ts` | An import of an addon folder from a core client file | **Yes.** A planted `./addons/towns` import. |
| "an addon imports no other addon folder" | `app/src/addons/boundary.test.ts` | A relative import that lands in another addon folder | **No planted proof is recorded.** |
| "core client files do not name an Action type, call, or event" | `app/src/addons/boundary.test.ts` | `ActionDef`, `ActionSet`, `ActionRunResult`, `ActionMode`, `ActionShow`, `ActionActivity`, the four quoted `action_*` methods, `actions_changed`, `runningAction`, `activeActionSet` | **Yes.** A planted `"action_run"` constant in `glyphs.ts`. |
| "core client files do not name GitHub pull request nouns" | `app/src/addons/boundary.test.ts` | `GitHub`, `PullRequest`, `PrStatusResult`, `review_decision`, `checks_failed`, `mergeable`, `pr_status`, `pr_changed`, `prs` | **Yes.** A planted `"pr_status"` constant in `glyphs.ts`. |
| "core client files do not name a runtime endpoint noun" | `app/src/addons/boundary.test.ts` | `RuntimeEndpoint`, `RuntimeProtocol`, `RuntimeActivity`, `RuntimePreview`, `endpoints_changed`, `runtime_list`, `endpointsOf`, `endpointUrl`, `httpEndpoints`, `endpointLabel`, `endpoints` | **Yes.** A planted `// endpointsOf RuntimeEndpoint` line in `glyphs.ts`. |
| "the Runtime and the Actions addon do not name each other" | `app/src/addons/boundary.test.ts` | An Action noun in a Runtime file, or a runtime endpoint noun in an Actions file | **Yes.** A planted `// ActionSet runningAction` line in `addons/runtime/model.ts`. |
| "core client files do not name Agentation" | `app/src/addons/boundary.test.ts` | `agentation`, `annotat`, `EvidenceBundle`, `browser_feedback`, `browser://feedback` | **Yes.** A planted `// EvidenceBundle` line in `glyphs.ts`. |
| "core activity files do not name an addon activity kind" | `app/src/addons/boundary.test.ts` | An addon kind string or enum in `Activity.tsx`, `activityKinds.ts`, `activityModel.ts`, `glyphs.ts` | **Yes.** A planted `"pr_merged"` constant in `glyphs.ts`. |
| "pure client models import only pure client models and generated types" | `app/src/clientModels.test.ts` | React, Tauri, `store.ts`, or a package in the 8 listed modules | **Yes.** A planted `import type { State } from "./store"` in `order.ts`. |

Every check is a text grep over source files. Two consequences follow. A noun
that `OWNED_NOUNS` or a regular expression does not list passes without a
sound. And a rename of an addon type needs a change in the noun list too.
Milestone 10 measured this: a `tomo-core` crate would give the compiler 2 of
the 58 patterns, and the other 56 would stay greps.

### Deletion tests

| Addon | Commit of the test | Files and lines | Registration lines | Result |
|---|---|---|---|---|
| Towns | `26a5c66` | 29 files, 1141 deleted, 6 added | 8 files | 112 Rust tests, 28 files and 190 vitest tests, `archive.sh` 17/0. Three expected warnings. |
| GitHub | `4c50df1` | 23 files, 637 deleted, 10 added | 8 files | 127 Rust tests, 31 files and 220 vitest tests, `archive.sh`, `terminal.sh`, `towns.sh` green. No new warning. |
| Usage | `3a8499b` | 19 files, 969 deleted, 5 added | 7 files | 106 Rust tests, 29 files and 190 vitest tests, `run-all.sh` 283 checks. One expected warning. |
| Actions | `d1b0879` | outside the folders: 1283 deleted, 7 added | 9 files, one test file deleted | 127 Rust tests, 30 files and 212 vitest tests. `continuity.sh` 17/2/1: the two failures run `tomo action run`. Two expected warnings. |
| Runtime | `a4055be` | 27 files, 1223 deleted, 11 added | 8 files, two test files deleted | 149 Rust tests, 35 files and 256 vitest tests, `terminal.sh`, `actions.sh`, `continuity.sh`, `provenance.sh` green. Two expected warnings. |
| Agentation | `1187f22` | 26 files, 772 deleted, 8 added | 11 files | 146 Rust tests, 33 files and 252 vitest tests, `browser.sh`, `continuity.sh`, `agents.sh` green. One expected warning. |
| anime-chart | `e9c25dd` and `2b19364` | 11 files, 220 deleted, 5 added | 4 files | 156 Rust tests, 38 files and 272 vitest tests. One expected warning, then the dead seam went too. |
| Browser | none | — | — | Not extracted, by the milestone 6 decision. No deletion test was run, because nothing moved out of Core. |

Three observations. No deletion test ran on `7a2ff88`; each ran at its own
milestone commit. Each removal leaves one to three compiler warnings for Core
seams and functions that then have no user, which is the correct signal. The
Actions removal is the only one that breaks harness checks, and only the
checks that run an Action on purpose.

## 4. Open items

### The 7 known limitations of the harness

`scripts/torture/lib.sh` prints `KNOWN` for a behavior that the team accepts.
On final master there are 7:

| # | Script | Limitation |
|---|---|---|
| 1 | `providers.sh` | `session_list` reads no Pi sessions. `providers::sessions` covers Claude and Codex only. |
| 2 | `providers.sh` | Two Codex panes in one worktree both resume with `resume --last`, so the untrusted pane gets the session of the other pane. |
| 3 | `providers.sh` | A Claude session with no message has no transcript, so `--resume` fails after a restart. |
| 4 | `providers.sh` | A Pi session with no message has no session file, so `--session <id>` fails after a restart. |
| 5 | `providers.sh` | Restore resumes a Claude agent that had exited before the restart. Reopen skips an exited agent; restore does not. |
| 6 | `providers.sh` | A pane whose hand-started Codex had exited is resumed with `resume --last` after a restart. |
| 7 | `github.sh` | A restart forgets the pull request cache, so the next `pr_status` records `pr_merged` again. |

Two more `known` lines exist but do not fire on this machine:
`continuity.sh` ("action pane landed outside the actions tab", only without
the Actions addon) and `system.sh` ("no GPU utilization from ioreg").
Codex installs no `SessionEnd` hook; the test at `providers/mod.rs:544` pins
that, and only the process monitor sees a Codex exit.

### Bugs found and not fixed

| # | Bug | Where it is recorded |
|---|---|---|
| 1 | The GitHub cache does not follow an archive, a move, or a rebind. The new id starts empty. | [addons.md](addons.md) "Problems found in milestone 2"; [features/github.md](features/github.md) |
| 2 | After a daemon restart, the next merged answer records `pr_merged` again. | the same, and `github.sh` |
| 3 | `pr_changed` fires on each new fetch of an open pull request, because `fetched_at_ms` is part of the equality. An open inspector gets one extra store update every 120 s. | "Problems found in milestone 2" |
| 4 | `attention_next` returns the first unviewed item, so `tomo attention next` and the GUI can pick different items. It does not follow the one "needs me" rule. | [client-independence.md](client-independence.md) "Problems found" |
| 5 | `ui_state` is one JSON blob for every client. A second client that writes it replaces the GUI view state. | the same; [data-model.md](data-model.md) |
| 6 | `ToastLevel` and `DaemonHealth` live in `store.ts`, which keeps `notifyRoute.ts`, `shell/bottomModel.ts`, and `shell/daemonHealth.ts` out of the pure model list. | the same |
| 7 | Codex installs no `SessionEnd` hook. | "Known limitations, not changed" in "Milestone 9 result" |
| 8 | `session_list` reads no Pi sessions. | the same |
| 9 | Restore resumes an agent that had exited before the restart. | the same |
| 10 | A closed Action pane records nothing: `remove_pane` runs before the process exits, so `on_exit` returns early and no `action_stopped` row and no `action.exited` hook follow. | "Problems found in milestone 0" item 3; "Decisions" in "Milestone 3 result" |
| 11 | `RuntimeProtocol::Https` is never produced. The probe reports `http` or `tcp`. | "Decisions" in "Milestone 4 result" |
| 12 | `scripts/perf.sh` sends `hello` with `protocol: 1` and subscribes before discovery ends, so two of its rows measure an error reply and an empty snapshot. | "Problems found in milestone 0" item 5; [addons-baseline.md](addons-baseline.md) |
| 13 | Dead code: `townBySlug` in `app/src/addons/towns/Towns.tsx` has no importer. | "Problems found in milestone 0" item 6 |
| 14 | Two concurrent worktree creates can pick the same town. The second `INSERT OR IGNORE` keeps the first unlock, and creation is not atomic. | "Seams" in [addons.md](addons.md) |
| 15 | The `tomo usage` help text names Pi, which the addon never fetches. | "Coupling that stays" in "Milestone 5 result" |
| 16 | `capabilities/browser.json` lets a remote page invoke `browser_feedback`. It is a security surface, and milestone 7 did not close it. | "7. Agentation" in "Milestone risks" |
| 17 | The daemon answers a request whose JSON does not parse with `id: 0` (`crates/tomod/src/server.rs:53`). `Request` flattens `Call` next to `id`, so a `params` value of the wrong shape fails the whole struct and the reply loses the request id. A client cannot match the error to its call. | **Not recorded in any document.** The audit found it in the code. |

### Measurements that did not run on final master

| Measurement | State |
|---|---|
| `scripts/perf.sh` startup numbers | Not re-verified here. The machine stopped the run for low memory. The last full set is milestone 5 (socket ready 99.1 ms, worktrees visible 214.4 ms, summaries 382.9 ms). |
| `scripts/soak/busy.sh 300` | Not re-verified here, for the same reason. The last run is milestone 5: PASS twice, maximum RSS 28 MB, which is the gate ceiling and 5 MB above the baseline. The cause was never found, and the document asked for a new soak at the next milestone. Five milestones later, no soak has run. |
| GUI cold launch | Never measurable. No window is allowed. |
| GUI idle RSS | Never measurable, for the same reason. |

### GUI checks that a human must still do

Native child webviews and real input need a window. 27 checks are open:

- **Browser, 14 checks.** "GUI checks for a human" in "Milestone 6 result: Browser": open a browser pane three ways, app zoom, sidebar and splitter and window resize, overlays that hide the page, the navigation controls, a link click and a daemon restart, terminal Cmd-click, "Open App" from the banner and from Activity, tab switch and reopen, zoom in a split, tab preview and a pane drag, the narrow-pane rules, the Agentation loop, and the `window.__tomoAgentation` check of problem 1.
- **Agentation, 9 checks.** "GUI checks for a human" in "Milestone 7 result: Agentation": a page that was never annotated, the toolbar and the note count, both copy paths, the send menu and the arrival of the text, the reset on a link, the reload with annotate on, annotate off and reload, the close and the tab switch, the narrow-pane rule, and `localhost:3000` in the url field.
- **Terminal, 4 checks.** "Phase 2.5 smoke" in [terminal-evaluation.md](terminal-evaluation.md), from the earlier shell work: paste (multi-line and bracketed, into `vim` and a shell), IME composition for CJK input, mouse selection and copy across a split, and the WebGL fallback to canvas.
- [edge-cases.md](edge-cases.md) also keeps 9 manual daemon checks that the harness does not cover.

## 5. Notes on the evidence itself

Four documents are now wrong in a small way. A reader who trusts them loses
time.

1. `docs/features/github.md` says the cache is `CACHE` in
   `crates/tomod/src/addons/github/mod.rs`. No `CACHE` symbol exists. The
   cache is `addons::State.github` (`pub type Cache`), under the Core lock,
   since the addon state change.
2. `docs/addons.md` "Candidates" says `activityModel.ts` still mixes runtime
   and usage helpers. The runtime helpers moved to the addon in milestone 4.
   Only the usage helpers `sparkCells` and `resetsIn`, and the shared
   `AddonSignal` type, are left.
3. `docs/addons.md` "Add a UI contribution" lists `endpointMenu` as a slot
   that exists. The `Addon` type has no `endpointMenu`; milestone 4 replaced
   it with `sourceMenu`. The same list omits `signalLine`, `sourceMark`,
   `sourceMenu`, and `appUrl`. The type has 21 slots; the list names 18.
4. `docs/development.md` omits `crates/tomod/src/addons/runtime/`,
   `crates/tomod/src/addons/agentation/`, and `app/src/addons/runtime/` from
   its layout block.

One more note on bullet 15. The `Inner.addons` slot is not a service locator,
and I agree with the decision. But the `expect(NOT_FILLED)` in
`addons::state` moves one error from compile time to run time. Every path
that builds a `Daemon` must pass `Box::new(addons::State::default())`. Three
call sites do so today, and a test that forgets it fails at the first addon
access, not at the type check.

## What a future agent should know first

Read [addons.md](addons.md) first; its first third is the guide, and the rest
is a milestone record. Ask the three questions: Core reality, Client display,
or Addon opinion. Core never names an addon, and only six composition roots
do. An addon joins Core through one of six seams, which are plain function
lists in `Seams`, and never through an event. Run `cargo test --workspace`
and `npx vitest run`; they hold 16 boundary checks that fail on a noun, not
only on an import. Before you call an extraction done, do the deletion test in
"Remove an addon" on a throwaway branch. Nobody has opened the window during
this refactor, so trust the daemon numbers and doubt every GUI claim.
