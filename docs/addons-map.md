# Addon dependency map

This map shows how each addon candidate touches every layer of Tomo at commit
`4ff28d3`, before the refactor. The rules and the milestone plan are in
[addons.md](addons.md). Line numbers refer to that commit. Update a section
when a milestone removes a coupling.

Each coupling has one class:

- **fine**: a legitimate use of Core, or code that is already inside the feature's own files.
- **leak**: an addon noun inside a Core type or a Core code path.
- **seam**: a lifecycle point where the addon must take part, often transactionally.

Paths without a prefix are in `crates/tomod/src/` (daemon), `crates/tomo-proto/src/lib.rs` (proto, "lib.rs"), `crates/tomo-cli/src/` (CLI), or `app/src/` (GUI).

## Cross-candidate dependencies

| From | To | Where |
|---|---|---|
| towns | github | `TownHistory.pr` / `TownPr` (lib.rs:1142-1160); `Call::TownHistory` reads `inner.prs` (daemon.rs:2396-2404); `features/towns.rs:57, 75-77` |
| towns | activity | `towns::history` reads `ActivityKind::Archived` payload (`branch`, `checkpoint_commit`, `head`, from daemon.rs:1438-1440) and `PrMerged` payload (`number`, `url`) |
| towns | core metadata | the create path sets `metadata.display_name` and calls `meta_upsert` |
| runtime | actions | `runtime.rs:95-120` `observe` reads `row.action_id` and `inner.actions` for the label; `RuntimeEndpoint.action_id`/`label`; `HookAction` in `queue_endpoint_event` (runtime.rs:192-197); GUI `endpointLabel(e, actions)`, `liveEndpointFor`, `EndpointMark` |
| actions | runtime | GUI only: the topbar endpoint arrow, `runningActionItems`, `endpointMenu` restart and stop |
| agentation | browser | Tauri `browser_create` re-injects the script on page load (src-tauri lib.rs:229-231); `browser_close` clears `AnnotatePanes` (lib.rs:278); all UI is inside `BrowserPane.tsx`; the `browser://feedback` event |
| agentation | actions | `AnnotationsSend` uses `action_def(bundle.action_id)` for the runtime line (daemon.rs:2364-2371); `EvidenceBundle.action_id` |
| agentation | agents | live agent check in `inner.agents`, PTY write, `agentsOf`, `KIND_LABEL` |
| usage | agent providers | `UsageSnapshot.provider: AgentKind`; `fetch_all` names `fetch_claude`, `fetch_codex` (usage.rs:265-277); `bottomModel.ts:15` filters `"pi"` |
| checkpoint (core) | runtime | `WorktreeHeader.tsx:141-152` `CheckpointBanner` and `Activity.tsx:84-86` use the first HTTP endpoint for "Open App" |
| terminal (core) | browser | Cmd-click on a URL calls `openEndpoint`, which calls `openInBrowser` (`terminalHooks.ts:16`, `actions.ts:300-303`) |
| core keys | actions | `store.ts:406-409` `keyBindings` merges `action:<id>`; `actions.ts:688-692` `runAction` handles the `action:` prefix |
| core attention | actions | `AttentionKind::Crash`; `attention.ts:36-39, 55-56`; `notifyRoute.ts` crash toast with Restart |

## Towns

**Status after milestone 1:** extracted. Every **leak** row below is gone,
except the `tomo towns` CLI block (allowed), the `town_slug` wire alias on
`WorktreeCreate.name_hint`, the shared CSS selectors in
`styles/interaction.css`, and the two chimes in `sounds.ts`. `discover` no
longer reads the `towns` table. The three seams replace the create, restore,
and rebind rows. See "Milestone 1 result: Towns" in [addons.md](addons.md).
The line numbers below are from before the extraction.

Background work (before milestone 1): the daemon has none of its own, but every `discover` runs a
full `SELECT` on `towns`. The GUI `TownReveal` uses a timer, a `keydown`
listener, and a WebAudio chime. The dataset loads lazily.

### Proto

| Location | Symbol | Class | Note |
|---|---|---|---|
| lib.rs:140-143 | `Call::TownList`, `TownPick`, `TownHistory { slug }` | fine (composition root) | |
| lib.rs:230 | `WorktreeCreate.town_slug` | **leak** | addon field in a Core create spec |
| lib.rs:304 | `Event::TownUnlocked { unlock }` | fine (composition root) | |
| lib.rs:642 | `Worktree.town_slug` | **leak** | filled at view time |
| lib.rs:1111-1161 | `Town`, `TownUnlock`, `TownWorktreeStatus`, `TownPr`, `TownHistory` | leak (location) | move to `addons/towns.rs` |
| lib.rs:1256-1257 | `Town::export_all`, `TownHistory::export_all` | fine | |

### Daemon

| Location | Symbol | Class | Note |
|---|---|---|---|
| daemon.rs:81, 183 | `Inner.town_by_worktree` | **leak** | addon state in Core `Inner` |
| daemon.rs:315 | `worktree_view` sets `town_slug` | **leak** | |
| daemon.rs:522 | `discover` rebuilds `town_by_worktree` from `store.town_unlocks()` | **leak** | runs on every discovery |
| daemon.rs:1679-1723 | `Call::WorktreeCreate` arm | **seam** | reads unlocks (1683); picks or checks a town, and returns `Conflict` when every town is unlocked (1687-1691); path `parent/slug` (1692-1696); after `git worktree add` and `discover` it writes the unlock, sets `display_name`, calls `meta_upsert`, emits `TownUnlocked` and `WorktreesChanged` (1702-1718). Not atomic. |
| daemon.rs:1507-1513 | `restore_worktree` re-keys the unlock | **seam** | the store write does nothing (see addons.md "Problems found") |
| daemon.rs:2392-2408 | `TownList`, `TownHistory`, `TownPick` arms | fine (thin) / seam (`TownHistory` reads activity, repos, worktrees, `inner.prs`) | |
| features/towns.rs:5 | `DATA = include_str!("../../../../app/src/data/japan-towns.json")` | leak (build) | daemon crate reads a file in the app tree |
| features/towns.rs:6-77 | `WEIGHTS`, `all`, `find`, `pick`, `WorktreeFacts`, `history` | fine | |
| archive_worktree (daemon.rs:1410-1455) | none | fine | unlock happens at create, archive keeps it |

### Store

| Location | Symbol | Class | Note |
|---|---|---|---|
| store.rs:121-126 | `towns(slug PK, worktree_id, repo_id, unlocked_at_ms)` in Core `SCHEMA` | **leak** | move the `CREATE` to the addon, keep the table |
| store.rs:146 | `META_COLUMNS` `town_slug` on `worktree_meta` | leak (dead) | unused column; keep it |
| store.rs:567-581 | `town_unlocks`, `town_unlock` (`INSERT OR IGNORE`) | leak (location) | |
| store.rs:297-304 | `rebind_worktree` does not update `towns` | seam | moved worktrees lose the link |
| store.rs:624, 631-632 | test `migration_adds_columns_to_an_old_schema` calls `town_unlock` | leak | Core migration test depends on towns |

### CLI

| Location | Symbol | Class |
|---|---|---|
| main.rs:60-61, 336-342, 538-546 | `Cmd::Towns(TownsCmd { List, Pick })` and handlers | fine |
| main.rs:178-179, 488-490 | `worktree create --town` sets `town_slug` | **leak** |
| print.rs:70-71 | `print::worktrees` prints `town <slug>` | **leak** |
| print.rs:163-176 | `print::towns` | fine |

### GUI

| Location | Symbol | Class | Note |
|---|---|---|---|
| store.ts:25, 68, 122; 74, 128 | `State.unlocks`, `State.townReveal` | leak | |
| store.ts:196 | `applySnapshot` calls `rpc("town_list")` | leak | extra call in the Core snapshot path |
| store.ts:377-379 | `case "town_unlocked"` | leak | |
| types.ts:108; uiState.ts:13 | `"towns"` in `UiState.view` and `VIEWS` | leak | global view slot |
| App.tsx:34, 37, 135-141, 157 | lazy `Towns`, view switch, global `<TownReveal />` | leak | |
| shell/TopStrip.tsx:11; shell/LeftRail.tsx:58; Sidebar.tsx:83 | view title, "Japan map" buttons | leak | |
| actions.ts:546, 621; appMenu.ts:27 | `towns` command, group, View menu entry | leak | |
| Dialogs.tsx:103-168 | `CreateWorktree`: `town_pick` reroll, default path, `town_slug`, `.town-suggest` | **seam** | create dialog field slot |
| states.tsx:35-39; emptyStates.ts:22-23 | `MapLoading`, `townsProgress` | leak (minor) | |
| sounds.ts:3-9, 15 | `Chime` `"rare" \| "legendary"` | leak | Core sound module |
| Towns.tsx, TownReveal.tsx, townCeremony.ts, data/japan-*.json, styles/towns.css | feature files | fine | `townBySlug` (Towns.tsx:295) has no importer |
| styles/interaction.css:7-45 | `.town-row`, `.towns-list`, `.towns-map` in shared rules | leak | |

### Tests, config, docs

- Rust: `features/towns.rs` (6 tests), `store.rs::migration_adds_columns_to_an_old_schema`, `tomo-proto` generated bindings check.
- Vitest: `delight.test.tsx` (ceremony, `townsProgress`), fixtures with `town_slug: null` in `delight.test.tsx:110`, `homeQuery.test.ts:8`.
- Torture: `scripts/torture/towns.sh` (6 checks). It does not cover a restore or a worktree move.
- Config: no towns key. It uses `worktree_parent_dir` and `[notifications] sounds`.
- Docs: `docs/features/towns.md`, `architecture.md`, `data-model.md`, `cli.md`, `development.md`, `ui.md`, `state-and-recovery.md`, `README.md`.

## GitHub

Background work: the daemon has no poller. Each `pr_status` call starts one
`gh pr view` process. The cache lasts 60 s only when a PR exists. The GUI
`PrSection` polls every 120 s while the right inspector is open.
`Sidebar.tsx:151` loads `https://github.com/<owner>.png` in the webview.

### Proto

| Location | Symbol | Class | Note |
|---|---|---|---|
| lib.rs:131, 305 | `Call::PrStatus`, `Event::PrChanged` | fine (composition root) | |
| lib.rs:610-619 | `Repo.github: Option<GitHubRepo>`, `GitHubRepo { owner, name }` | **leak** | `Repo.remote_url` is fine |
| lib.rs:1005 | `ActivityKind::PrMerged` | **leak** | |
| lib.rs:1088-1108 | `PullRequest`, `PrStatusResult` | fine (move to `addons/github.rs`) | |
| lib.rs:1142-1160 | `TownPr`, `TownHistory.pr` | leak (in towns) | |

### Daemon

| Location | Symbol | Class | Note |
|---|---|---|---|
| github.rs:5, 34 | `parse_pr`, `pr_status` | fine | env `GH_NO_UPDATE_NOTIFIER=1`, `NO_COLOR=1` |
| daemon.rs:78, 180 | `Inner.prs` | **leak** | never cleared on archive or rebind |
| daemon.rs:2129-2154 | `Call::PrStatus` arm | fine / seam | records `PrMerged` and emits `PrChanged` |
| daemon.rs:2455-2460; git.rs:177-184 | `repo_view` calls `git::github_repo` | **leak** | GitHub parsing in core Git code, on every discovery |
| server.rs:29 | `is_slow` includes `PrStatus` | fine (composition) | |

### Store, CLI

- Store: no table or column. `activity` rows with `kind = 'pr_merged'`.
- CLI: `main.rs:70-71, 731-735` `Cmd::Pr`; `print.rs:244-258` `pr()`. Both fine.

### GUI

| Location | Symbol | Class |
|---|---|---|
| store.ts:17-18, 71, 125, 372-375 | `State.prs`, `case "pr_changed"` | leak |
| RightSidebar.tsx:12, 24, 89-121 | `PrSection` (120 s poll) | seam (inspector section) |
| shell/RightRail.tsx:17-29; types.ts:105; uiState.ts:12 | `SECTIONS.pr`, markers, `"pr"` in `RightSection` | leak |
| activityModel.ts:80-103; Signals.tsx:19, 65-66; shell/LeftRail.tsx:36-37 | PR `Signal`, `nowSignals` | **leak** (worktree signal slot) |
| glyphs.ts:23 | `ACTIVITY.pr_merged` | leak |
| Towns.tsx:264 | `h.pr` row | leak (towns) |
| Sidebar.tsx:151-153 | GitHub avatar URL | leak |
| styles/base.css:40-56; layout.css:86-87 | `.pr-*`, `.check-*` | fine |

### Tests, config, docs

- Rust: `github.rs::parses_checks_from_both_rollup_shapes`, `git.rs::parses_github_remotes`, 2 PR tests in `features/towns.rs`.
- Vitest: `activity.test.ts:81`; fixtures with `github: null`.
- Torture: none.
- Config: none.
- Docs: `README.md`, `cli.md`, `activity.md`, `ui.md`, `features/towns.md`.

## Actions

Background work: none that runs by itself. `reload_actions` reads
`.tomo.toml` for every worktree on each `discover`. The watcher reacts to
`.tomo.toml`. An external Action starts a detached `sh -c` only on an
explicit run.

### Proto

| Location | Symbol | Class | Note |
|---|---|---|---|
| lib.rs:158-161, 307 | `ActionList/Run/Stop/Restart`, `Event::ActionsChanged` | fine (composition root) | |
| lib.rs:182-220 | `ActionMode`, `ActionShow`, `ActionDef`, `ActionSet`, `ActionRunResult` | fine (move) | |
| lib.rs:454, 457-461 | `HookEvent.action`, `HookAction` | **leak** | Core hook envelope |
| lib.rs:505-507 | `HOOK_EVENTS` `action.started/exited/crashed` | fine (composition root) | |
| lib.rs:757 | `Pane.action_id` | **leak** | becomes an opaque provenance label |
| lib.rs:942-943 | `AttentionKind::Crash` | **leak** | |
| lib.rs:995-998 | `ActivityKind::ActionStarted/Stopped/Completed/Crashed` | **leak** | |
| lib.rs:1077 | `EvidenceBundle.action_id` | leak (agentation) | |
| lib.rs:1191 | `Snapshot.actions` | fine (composition root) | |

### Daemon

| Location | Symbol | Class | Note |
|---|---|---|---|
| features/actions.rs:12-91 | `FILE_NAME`, `parse`, `load` | fine | |
| daemon.rs:59 | `PaneState.stop_intent` | fine (generic) | tells a crash from a stop |
| daemon.rs:82, 184 | `Inner.actions` | **leak** | |
| daemon.rs:532, 539-561 | `discover` calls `reload_actions` | **seam** | discovery seam |
| daemon.rs:563-683 | `action_def`, `running_action_pane`, `queue_action_event`, `record_action`, `run_action`, `stop_action` | fine (move) | `focus_pane` (603-627) is generic and stays in Core |
| daemon.rs:852-868 | `on_exit` branch on `row.action_id` | **seam** | pane exit seam |
| daemon.rs:1139-1141 | `restore` strips `action_id` | **seam** | |
| daemon.rs:1307-1333 | `action_crashed` (attention, hook, activity) | leak | |
| daemon.rs:1725-1740 | four action arms | fine (dispatch) | |
| watch.rs:11-16, 62 | `Change::Actions` for `.tomo.toml` | **seam** | watcher file classifier |
| features/reopen.rs:6, 21, 37-44 | reopen drops the action | seam | |
| store.rs:65, 150, 362-402 | `PaneRow.action_id`, `PANE_COLUMNS` migration | leak (keep the column) | |

### CLI, GUI

| Location | Symbol | Class |
|---|---|---|
| CLI main.rs:83-84, 139-144, 508-526; print.rs:338-370 | `Cmd::Action` and printers | fine |
| store.ts:8, 37, 95, 207, 258-261, 395-409 | `State.actions`, `actions_changed`, `activeActionSet`, `runningActionIds`, `keyBindings` | **leak** |
| actions.ts:288-298 | run, stop, restart | fine |
| actions.ts:688-692 | `runAction` `action:` prefix | leak |
| WorktreeHeader.tsx:18-85, 160-172 | `ActionBar`, `ActionWarning` | seam (topbar slot) |
| menus.ts:97-146; Palette.tsx:4-67; ShortcutReference.tsx:6-22 | action menu, palette, shortcut rows | leak |
| attention.ts:36-56; notifyRoute.ts:9-97 | crash names and toast | **leak** |
| Activity.tsx:70-112; glyphs.ts:18-21 | action rows, Restart button, glyphs | leak (activity row slot) |
| styles/layout.css:29-39 | `.actionbar`, `.action-*` | fine |

### Tests, config, docs

- Rust: 3 tests in `features/actions.rs`, `reopen.rs::panes_come_back_by_kind_and_actions_never_rerun`, `store.rs` activity and browser tests (use `action_id: None`).
- Vitest: `menus.test.ts:81-96`, `notifyRoute.test.ts`, `notify.test.ts:43-70`, `previews.test.ts:15`, `activity.test.ts:52`, `shell/shell.test.tsx:34`.
- Torture: `actions.sh` (24), and parts of `runtime.sh`, `activity.sh`, `continuity.sh`, `browser.sh`.
- Config: `.tomo.toml` `[[actions]]` (`id`, `label`, `command`, `mode`, `show`, `shortcut`); hooks `action.*`.
- Docs: `actions.md`, `hooks.md`, `activity.md`, `data-model.md`, `cli.md`, `browser.md`, `edge-cases.md`, `notifications.md`, `architecture.md`, `development.md`, `ui.md`, `runtime.md`.

## Runtime

Background work: each monitor tick (2 s with a subscriber, 15 s without)
runs one `lsof` if candidate pids exist, then one probe task for each new
endpoint. `RuntimeList` forces a tick when the data is older than 1.5 s.

### Proto

| Location | Symbol | Class |
|---|---|---|
| lib.rs:145, 283 | `Call::RuntimeList`, `Event::EndpointsChanged` | fine (composition root) |
| lib.rs:508-509 | `HOOK_EVENTS` `runtime.endpoint_*` | fine (composition root) |
| lib.rs:962-983 | `RuntimeProtocol`, `RuntimeEndpoint` (`action_id`, `label`) | fine (move) / leak (`action_id`) |
| lib.rs:999 | `ActivityKind::EndpointDiscovered` | **leak** |
| lib.rs:1192-1193 | `Snapshot.endpoints` | fine (composition root) |

### Daemon

| Location | Symbol | Class | Note |
|---|---|---|---|
| runtime.rs:21-249 | `parse_lsof`, `listeners`, `candidate_pids`, `observe`, `reconcile`, `probe`, `scan_endpoints`, `probe_endpoint` | fine (move) | `observe` reads Actions (leak) |
| activity.rs:12 | `ENDPOINT_REPEAT_MS` | **leak** | feature constant in Core |
| monitor.rs:102-112 | `poll_and_scan` calls `scan_endpoints` | **seam** | monitor tick seam |
| daemon.rs:86-88, 188-190 | `Inner.endpoints`, `endpoint_gone_ms`, `endpoints_at_ms` | **leak** | |
| daemon.rs:2241-2251 | `RuntimeList` arm | fine | |
| archive, pane close | no explicit endpoint cleanup | fine | removed after the 5 s grace |

### Store, CLI, GUI

| Location | Symbol | Class |
|---|---|---|
| store | no table; `activity` rows `endpoint_discovered` | fine |
| CLI main.rs:85-86, 743-750; print.rs:198-209 | `Cmd::Runtime` | fine |
| store.ts:20, 47, 105, 183-185, 208, 323-331, 417-423 | `State.endpoints`, `endpoints_changed`, `endpointsOf`, `liveEndpointFor` | leak |
| activityModel.ts:23-33, 78-101; Signals.tsx:15-61; shell/LeftRail.tsx:32-33 | endpoint helpers and runtime signal | **leak** |
| WorktreeHeader.tsx:55-136 | `EndpointMark`, `RuntimePopover` | seam (topbar) |
| WorktreeHeader.tsx:141-152; Activity.tsx:84-86, 109 | "Open App" fallback | leak (checkpoint to runtime) |
| menus.ts:89-145; Palette.tsx:27-36 | endpoint menu and palette entries | leak |
| HoverPreviews.tsx:19-32 | `RuntimePreview` | fine |
| styles/base.css:72; layout.css:40-43 | `.signal-runtime`, `.runtime-*` | fine |

`Home.tsx:170` `.runtime` shows Git line counts, not endpoints. Only the name is the same.

### Tests, config, docs

- Rust: 3 tests in `runtime.rs` (`probe_tells_http_from_tcp` binds local sockets).
- Vitest: `activity.test.ts`, `menus.test.ts`.
- Torture: `runtime.sh` (28) with `scripts/fixtures/fake-server`.
- Config: hooks `runtime.endpoint_*`.
- Docs: `runtime.md`, `hooks.md`, `activity.md`, `cli.md`, `keyboard.md`, `ui.md`, `browser.md`, `diagnostics.md`, `notifications.md`, `architecture.md`.

## Usage

Background work (with a subscriber only): `usage::run` wakes every 20 s. It
fetches when the newest snapshot is at least 5 min old. A fetch runs
`security find-generic-password`, sends a `curl` request to
`api.anthropic.com/api/oauth/usage`, and starts `codex app-server` if
`~/.codex/auth.json` exists. `TOMO_USAGE_MOCK=<path>` replaces every source.

| Location | Symbol | Class | Note |
|---|---|---|---|
| lib.rs:149, 286 | `Call::UsageGet`, `Event::UsageChanged` | fine (composition root) | |
| lib.rs:1037-1058 | `UsageBucket`, `UsageSnapshot { provider: AgentKind, .. }` | fine (move) | |
| lib.rs:1195 | `Snapshot.usage` | fine (composition root) | |
| daemon.rs:85, 187 | `Inner.usage` | **leak** | |
| daemon.rs:1568 | `Subscribe` fills `usage` | seam (snapshot) | |
| daemon.rs:2235-2240 | `UsageGet` arm | fine (dispatch) | |
| main.rs:21, 84 | `tokio::spawn(usage::run(..))` | seam (start) | |
| usage.rs:332-344 | `run` reads `clients[..].subscribed` | seam | needs a public "has subscriber" |
| usage.rs:265-277 | `fetch_all` names the providers | leak (provider) | |
| store | none (memory only) | fine | |
| CLI main.rs:72-76, 736-739; print.rs:396-432 | `Cmd::Usage` | fine | help text names Pi, which is never fetched |
| store.ts:27, 49, 107, 209, 336-338 | `State.usage`, `usage_changed` | leak | |
| shell/BottomStrip.tsx:25, 62-118 | hard-mounted `UsageStrip` | **seam** (bottom-strip slot) | |
| shell/bottomModel.ts:11-15, 26-44, 149 | thresholds (duplicate of `usage::THRESHOLDS`), `"pi"` filter, rows | leak | |
| shell/Diagnostics.tsx:9, 97, 159-167 | Usage section | seam (diagnostics slot) | |
| activityModel.ts:107-131 | `percentOf`, `sparkCells`, `usageSummary`, `resetsIn` | leak (wrong module) | |
| styles/bottom.css | `.bottom-usage`, `.usage-*` | fine | `.micro-bar`, `.tone-*` are shared with metrics |

- Rust: 15 tests in `usage.rs`.
- Vitest: `shell/bottomModel.test.ts`, `shell/BottomStrip.test.tsx`, `activity.test.ts:95-104`.
- Torture: none.
- Config: none (env `TOMO_USAGE_MOCK` only).
- Docs: `usage.md` (stale about `scope`), `ui.md`, `diagnostics.md`, `notifications.md`, `cli.md`, `agent-integrations.md`, `README.md:37` (stale).

## Browser

Background work: the daemon has none. Each mounted `BrowserPane` runs a
`requestAnimationFrame` loop that calls `browser_set_bounds` only on a change.
The webview closes when the pane unmounts.

| Location | Symbol | Class | Note |
|---|---|---|---|
| lib.rs:154-155 | `Call::BrowserOpen`, `BrowserNavigate` | fine (composition root) | |
| lib.rs:762, 770-774 | `Pane.kind`, `PaneKind { Terminal, Browser }` | seam | a pane with no PTY is a Core fact |
| lib.rs:763-765 | `Pane.url` | **leak** | |
| daemon.rs:371, 378-379 | `pane_view` live and kind logic | leak | |
| daemon.rs:767-772 | `start_pty` returns early for `Browser` | seam | also skips PTY on restore |
| daemon.rs:1021-1048 | `create_browser_pane` in `daemon.rs` | **leak** | |
| daemon.rs:1050-1056 | `terminal_only` guard (`PaneSend`, `PaneResize`, `PaneAttach`) | seam (capability check) | |
| daemon.rs:2317-2350 | `BrowserOpen`, `BrowserNavigate` arms | leak (move) | |
| features/reopen.rs:4-110 | `ClosedPane::Browser { cwd, url }`, `reopen_pane` calls `create_browser_pane` | **seam** | reopen must rebuild addon pane kinds |
| store.rs:66-67, 150, 184-193, 362-404 | `PaneRow.kind`, `PaneRow.url`, `pane_kind_str`, `parse_pane_kind` | leak (keep the columns) | |
| CLI main.rs:36-37, 319-326, 658-661 | `Cmd::Browser` | fine | |
| src-tauri lib.rs:189-283, 321-353 | browser webview commands, `open_main_window` child layout, handler list | fine / leak (registration) | `Cargo.toml` `unstable` feature, `build.rs`, capabilities |
| Layout.tsx:20 | `kind === "browser"` renders `<BrowserPane>` | **leak** | pane renderer slot |
| Tabs.tsx:111 | browser skips tab preview | leak | |
| BrowserPane.tsx:49, 113-116 | `covered` hides the webview under menus, dialogs, palette | seam (client) | |
| actions.ts:13, 205-243, 300-303; shortcuts.ts:5 | `openBrowser`, `openInBrowser`, `browserHostFailed`, `browserCommand`, `"Browser"` group | leak (location) | |
| commands/discovery.ts:24-44 | `new_browser`, `browser_back/forward/reload` | leak (location) | |
| menus.ts:223, 231, 274-289; appMenu.ts:25 | spawn menu, `browserMenu`, File menu | leak | |
| styles/terminal.css:54-62 | `.browser-*` | leak (shared file) | |

- Rust: `store.rs::browser_pane_keeps_kind_and_url`, `reopen.rs::panes_come_back_by_kind_and_actions_never_rerun`.
- Vitest: none for `BrowserPane` or `normalizeUrl`.
- Torture: `browser.sh` (19), `continuity.sh:53-58`.
- Config: none.
- Docs: `browser.md`, `architecture.md`, `cli.md`, `keyboard.md`, `ui.md`, `diagnostics.md`, `notifications.md`, `state-and-recovery.md`, `README.md`.

## Agentation

Background work: one in-page React root for each annotated webview. It is
injected again on each page load while annotation is on. Notes live in
`localStorage` for each path. No daemon or GUI timers.

| Location | Symbol | Class | Note |
|---|---|---|---|
| lib.rs:156 | `Call::AnnotationsSend { pane_id, bundle }` | fine (composition root) | |
| lib.rs:512 | `HOOK_EVENTS` `annotation.sent` | fine (composition root) | |
| lib.rs:1000 | `ActivityKind::AnnotationsSent` | **leak** | |
| lib.rs:1063-1086 | `Annotation`, `EvidenceBundle` | fine (move) | the GUI always sends `annotations: []` |
| daemon.rs:2351-2391 | `AnnotationsSend` arm | **seam** | needs a Core "paste into a live agent pane" operation plus activity and hook |
| daemon.rs:2423-2447 | `evidence_text`, `evidence_title` | leak (move) | |
| daemon.rs:2451-2453 | `pasted` (bracketed paste) | fine | generic, stays in Core |
| store | no table; `activity` rows `annotations_sent` with the bundle | fine | |
| CLI | none | fine | raw RPC only |
| src-tauri lib.rs:180-187, 286-319, 354-356 | `AGENTATION_JS`, `AnnotatePanes`, `browser_set_annotate`, `browser_clear_annotations`, `feedback_pane`, `browser_feedback` | fine | |
| src-tauri lib.rs:229-231, 278 | inject in `browser_create`, cleanup in `browser_close` | **leak into browser** | page-load and close hooks |
| src-tauri capabilities/browser.json | remote `http(s)` pages may invoke `browser_feedback` | seam (security) | |
| app/agentation/ (`entry.tsx`, `markdown.ts`), `vite.agentation.config.ts`, `package.json` script | build | fine | |
| BrowserPane.tsx:16-28, 60-62, 94-157, 200-220 | feedback state, listener, send menu, toolbar | **leak into browser** | browser toolbar slot |
| Activity.tsx:75 | `annotations_sent` shown as "You" | leak | |
| styles/terminal.css:58-59 | `.browser-annotate-on`, `.browser-count` | leak | |

- Rust: `daemon.rs::evidence_text_lists_annotations_in_order`, `evidence_text_uses_the_markdown_body`; Tauri `feedback_pane_comes_from_the_label_and_gates_copy_and_submit`, `agentation_script_injects_once_then_toggles`.
- Vitest: `app/agentation/markdown.test.ts` (2).
- Torture: `browser.sh` section 5.
- Config: hooks `annotation.sent`.
- Docs: `browser.md:67-200`, `architecture.md`.

## Activity projections

Background work: none. Activity is written when an event occurs and read on
request.

### Every `ActivityKind` variant (lib.rs:989-1006)

| Variant | Owner | Emitter |
|---|---|---|
| `AgentStarted` | core agents | daemon.rs:1007, 1238 |
| `AgentWaiting` | core agents and attention | daemon.rs:1251-1253 |
| `AgentExited` | core agents | daemon.rs:876, 1257 |
| `CheckpointCreated` | core checkpoints | daemon.rs:2281-2287 |
| `CheckpointResolved` | core checkpoints | daemon.rs:2305-2310 |
| `ActionStarted` | actions | daemon.rs:641, 660 |
| `ActionStopped` | actions | daemon.rs:673, 865 |
| `ActionCompleted` | actions | daemon.rs:864 |
| `ActionCrashed` | actions | daemon.rs:1327-1332 |
| `EndpointDiscovered` | runtime | runtime.rs:217-221 |
| `AnnotationsSent` | agentation | daemon.rs:2373-2385 (builds the struct directly) |
| `StateChanged` | core metadata | daemon.rs:1796-1799 |
| `Archived` | core archive | daemon.rs:1438-1441 |
| `Restored` | core archive | daemon.rs:1518-1520 |
| `HookFailed` | core hooks | events.rs:200-203; also the decode fallback in store.rs:497 |
| `PrMerged` | github | daemon.rs:2145-2148 |

Six of the 16 variants belong to addons.

### Couplings

| Location | Symbol | Class | Note |
|---|---|---|---|
| lib.rs:989-1006 | closed `ActivityKind` | **leak** | |
| lib.rs:1008-1022 | `ActivityEvent` (`attention_id`, `agent_kind`) | fine | |
| activity.rs:14-41 | `event`, `Daemon::record`, `recorded_recently` | seam | the one entry point, about 15 direct callers |
| store.rs:127-139, 469-522 | `activity` table, `activity_insert`, `activity_trim`, `activity_row`, `activity_list` | fine | |
| store.rs:493-497 | `activity_row` decodes an unknown kind as `HookFailed` | **leak** | an omitted addon corrupts rows on read |
| store.rs:515 | SQL "Needs Me" | seam | differs from `activityModel.ts` `needsMeItem` |
| store.rs:297-304 | `rebind_worktree` does not move `activity` | seam | |
| daemon.rs:2396-2404 | `TownHistory` reads `activity_list(1000)` | leak (towns) | |
| CLI main.rs:88-95, 751-758; print.rs:211-245 | `Cmd::Activity` | fine | |
| store.ts:3, 48, 106, 333-335, 411-415 | `State.activity`, `activity_added`, `needsMe` | leak / fine | |
| Activity.tsx:68-118 | `whoOf`, `EventRow` switch on kind strings | **leak** | activity row slot |
| activityModel.ts:7-33, 74-131 | Needs Me, endpoint helpers, `nowSignals`, usage helpers | **leak** | one module mixes four features |
| glyphs.ts:12-28 | `ACTIVITY` map | leak | |
| App.tsx:140-141; uiState.ts:13; Sidebar.tsx:31, 82; shell/LeftRail.tsx:45, 54 | Activity view and rail button | seam (global view) | |

- Rust: `store.rs::activity_lists_newest_first_and_needs_me_follows_attention_state`, `pane_view_and_waiting_resolve_return_changed_ids`, 4 tests in `features/towns.rs`.
- Vitest: `activity.test.ts`, `delight.test.tsx`, `previews.test.ts`, `notifyRoute.test.ts`, `notify.test.ts`, `shell/shell.test.tsx`, `homeQuery.test.ts`.
- Torture: `activity.sh` (25), parts of `runtime.sh`, `browser.sh`, `diagnostics.sh`, `agents.sh`.
- Config: none; `KEEP = 10_000` is a constant.
- Docs: `activity.md` (omits `annotations_sent`), `data-model.md`, `architecture.md`, `ui.md`, `notifications.md`.

## Agent providers

Background work:

- `Daemon::new` writes `<data>/integrations/claude-hooks.json` and `tomo-status.ts`.
- `login_env::apply` can run a login shell one time before the runtime starts.
- Each config reload runs `integrations::status`.
- Every `Status` and `Subscribe` reads three files in the home directory.
- Each agent spawn starts `type_pending_when_quiet` (100 ms poll, 5 s maximum).
- The GUI polls `session_list` every 30 s while the sessions section is mounted.

| Location | Symbol | Class | Note |
|---|---|---|---|
| lib.rs:788-820 | `AgentKind { Claude, Codex, Pi }` | leak / keep | used in 10 wire types; a provider id is Core identity |
| lib.rs:380-388 | `Status.integrations: Integrations { claude_hooks, codex_hooks, pi_extension }` | **leak** | |
| lib.rs:67-68, 117-118, 144 | `IntegrationsInstall/Status`, `AgentSpawn`, `AgentHook`, `SessionList` | seam | |
| daemon.rs:22, 201-232, 409 | `PI_EXTENSION_SOURCE`, `write_integration_files`, `claude_settings_path`, `pi_extension_path`, `integrations()` | **leak** | |
| daemon.rs:760-765 | `inherited_env_to_remove` names `CLAUDECODE`, `CLAUDE_CODE_*`, `CODEX_THREAD_ID` | **leak** | Core PTY spawn path |
| daemon.rs:1142 | `restore`: Codex without a session uses `--last` | **leak** | |
| daemon.rs:1143-1148, 2030-2056; features/reopen.rs:111-117 | spawn plan built in 3 places | seam | |
| daemon.rs:2057-2065 | `AgentHook` calls `agents::hook_outcome` | seam | lifecycle translation |
| agents.rs:48-190 | `hook_outcome`, `claude_style_outcome`, `pi_outcome`, `spawn_plan`, hook settings | fine (provider module) | `shell_quote`, `shell_line` (146-157) are generic |
| integrations.rs:7-139 | install, status, `codex_hooks_trusted` | fine (provider module) | |
| settings.rs:27, 47 | config reload calls `integrations::status` | leak | |
| procs.rs:191-205 | `detect_agent` names providers | **leak** | Core process monitor |
| monitor.rs:68-89 | heuristic `AgentReport` | seam | |
| features/sessions.rs:14-139 | Claude and Codex session readers | fine (provider module) | |
| config.rs:253-257, 314-315 | `default_agents()` names three providers | leak | |
| store.rs:176-182 | `agent_kind_str` | leak / keep | |
| CLI main.rs:35, 54-57, 297-315, 404 | `value_parser = ["claude","codex","pi"]` in `hook` and `agent spawn` | leak | |
| CLI print.rs:29-46 | `status` prints "hooks claude/codex/pi" | leak | |
| types.ts:150 | `KIND_LABEL` | leak / keep | |
| actions.ts:567-569, 651-653; appMenu.ts:30; menus.ts:58-60, 220-236 | `spawn_claude/codex/pi` commands and menus | leak | |
| ProcessIcon.tsx:56-68 | `BY_AGENT`, brand icons | leak | |
| RightSidebar.tsx:166-193 | `SessionsSection` (30 s poll) | seam | |
| Settings.tsx:306-365; shell/Diagnostics.tsx:99-120; shell/bottomModel.ts:141-145 | integration health UI | seam | |

- Rust: 9 tests in `agents.rs`, 1 in `integrations.rs`, 2 in `features/sessions.rs`, `procs.rs::detects_agents_by_name_or_command`, 4 in `login_env.rs`, `config.rs::set_value_writes_nested_tables_and_arrays`.
- Vitest: `menus.test.ts:36`, `Palette.test.tsx:35`, `shell/bottomModel.test.ts:116-123`.
- Torture: `agents.sh` (18), `continuity.sh`, `activity.sh`, `browser.sh`, `layout.sh`, the soak. All use `scripts/fixtures/fake-agent`, which speaks only the Claude protocol. No script covers Codex or Pi.
- Config: `[agents.<name>] command, args`.
- Docs: `agent-integrations.md`, `state-and-recovery.md`, `data-model.md`, `cli.md`, `development.md`, `architecture.md`, `edge-cases.md`.
