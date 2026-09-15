# Core, Client, and Addons

Read this before you add a feature or move one. It takes a few minutes.

Status: milestone 0. No code has moved yet. The sections "Target layout",
"Add an addon", "Remove an addon", and "Add a UI contribution" describe the
**target** procedure. Milestone 1 (Towns) must prove the procedure, and then
change this file to show what really works.

Related files:

- [addons-map.md](addons-map.md) shows how each candidate touches every layer today.
- [addons-baseline.md](addons-baseline.md) has the performance numbers and the test counts before the refactor.

## The three layers

Ask three questions about each new piece of code:

1. Is this reality that Tomo observes or keeps alive? Then it is **Core**.
2. Is this how one program shows Tomo to a person? Then it is **Client**.
3. Is this an opinion that uses Core to interpret or compose? Then it is an **Addon**.

### Core

Core provides reality, lifetime, and coordination. Core is Tomo without its
opinions.

| Concept | Where it lives today |
|---|---|
| Repositories, worktrees, discovery, Git lifecycle, archive, restore | `crates/tomod/src/daemon.rs`, `git.rs`, `watch.rs` |
| PTYs, panes, scrollback | `pty.rs`, `daemon.rs` |
| Tabs, layout, layout persistence | `layout.rs`, `moves.rs`, `features/reopen.rs` (these do not move in this refactor) |
| Processes, ownership, provenance | `procs.rs`, `monitor.rs` |
| Agent abstraction, presence, authority | `agents.rs` (`merge`, `AgentPresence`) |
| Attention, checkpoints | `daemon.rs`, `store.rs` |
| Hooks, activity recording | `events.rs`, `activity.rs` |
| Persistence, recovery | `store.rs`, `daemon.rs` (`restore`) |
| IPC, CLI transport, config | `server.rs`, `main.rs`, `config.rs`, `settings.rs`, `crates/tomo-cli/src/client.rs` |
| Wire types | `crates/tomo-proto/src/lib.rs` |

### Client

The macOS Tauri and React app in `app/` is one client. The CLI is a second
client for the same daemon operations. The GUI client owns these parts:

- window chrome, strips, rails, tabs, pane rendering, terminal rendering
- theme, dialogs, menus, palette, toasts, settings UI
- drag and drop, hover, popovers

The client renders addon contributions. The client never becomes the only
implementation of daemon behavior.

### Addon

An addon is a first-party source module. It holds one optional opinion or
capability, and it composes Core primitives. An addon is not dynamically
loaded, not third-party, not versioned alone, and not sandboxed. It is normal
source code with a clean dependency boundary.

Current candidates: towns, github, actions, runtime, usage, browser,
agentation, activity projections, and agent providers.

## The dependency law

1. **Core never imports an addon.** A core module must not name an addon
   module, an addon type, or an addon noun.
2. **An addon imports Core.** It uses public Core functions and types.
3. **An addon does not import another addon.** The exception is a dependency
   that the "Allowed addon dependencies" table lists. Agentation depends on
   Browser; nothing else is allowed yet.
4. **Composition roots name everything.** A composition root is a file whose
   only job is to list Core and addons together. The composition roots are:
   - `crates/tomod/src/main.rs`: startup
   - `crates/tomod/src/addons/mod.rs`: the static addon list and the seam registration (target)
   - `crates/tomod/src/dispatch.rs`: the `Call` to handler match (target)
   - the `Call`, `Event`, `Snapshot`, and `HOOK_EVENTS` definitions in `tomo-proto`
   - `app/src/addons/index.ts`: the `builtins` list (target)
5. **Deleting an addon must not damage Core.** If you remove the addon
   directory and its registration lines, Tomo must still build. Everything
   except that feature must still work.

Why rule 4: the wire protocol must stay typed. A closed `Call` enum that
lists addon variants is typed and easy to trace. A generic
`{kind, payload}` envelope is neither. The composition root is the one place
where naming an addon is correct.

### Allowed addon dependencies

| From | To | Reason |
|---|---|---|
| agentation | browser | Agentation annotates a browser pane. |

Other links exist today, for example Towns reads GitHub PR data. Each one
must go through Core data or through a composition root, or this table must
list it with a reason.

## Events and commands

**Commands request work.** Examples: create a worktree, spawn an agent, run
an Action, open a browser pane. A command is a typed `Call` variant, a direct
function call inside the daemon, or a command in `app/src/commands/*.ts` or
`app/src/actions.ts` in the GUI.

**Events report facts.** Examples: `worktrees_changed`, `agent_changed`,
`activity_added`, `town_unlocked`. An event is an `Event` variant that goes to
the clients, or a `HookEvent` that goes to user hook scripts.

Rules:

- Use a direct typed call when one part needs another part to do something now.
- Use an event only to tell other parts about something that already happened.
- Do not replace a direct call with an event for architectural purity.
- If an addon must take part in a Core operation and the result must be
  consistent, use a **seam**. A seam is a typed function that Core calls
  synchronously inside the operation. Do not emit an event and hope that the
  addon commits later.

## Static composition

Composition is boring on purpose. There are no manifests, no discovery, no
dynamic loading, no service locator, and no dependency injection container.

Daemon (target):

```rust
// crates/tomod/src/addons/mod.rs
pub mod towns;
pub mod github;

pub fn seams() -> Seams {
    Seams { worktree_naming: vec![towns::name_worktree], worktree_created: vec![towns::on_created] }
}
```

Core defines `Seams` as a struct of plain function lists, and it calls each
function at a fixed point. `main.rs` builds the struct one time at startup
and gives it to `Daemon::new`. After that, the struct does not change.

GUI (target):

```ts
// app/src/addons/index.ts
export const builtins: Addon[] = [towns, github, actions, runtime, usage, browser, agentation];
```

The order of `builtins` is the render order of every contribution slot.

## Performance law

- An addon does nothing until something needs it. Registration must be
  effectively free.
- These things need a written reason in the addon's doc: a poller, a timer,
  a watcher, a subprocess, a network call, or a UI part that stays mounted.
- Prefer activation by a relevant event, a visible UI, an explicit command,
  or a known active worktree state.
- Noticeable latency is a bug. Idle CPU must stay about zero.
- Every milestone measures again with the commands in
  [addons-baseline.md](addons-baseline.md). The gate at the end of that file
  decides if a milestone passes.

Background work that exists today and must keep its current trigger:

| Work | Trigger | Owner |
|---|---|---|
| process poll | every 2 s with a subscriber, 15 s without | core `monitor.rs` |
| `lsof` port scan | each monitor tick with candidate pids | runtime |
| `ioreg` system stats | every 5 s with a subscriber | core `system.rs` |
| usage fetch (network, `codex app-server`) | 20 s tick, only with a subscriber and a snapshot older than 5 min | usage |
| `gh pr view` | each `pr_status` call; the inspector polls every 120 s while it is open | github |
| `session_list` scan | every 30 s while the sessions section is mounted | agent providers |
| Git watcher and 30 s rediscovery | always | core `watch.rs` |

## Addon state

- An addon owns its SQLite tables. It creates them with
  `CREATE TABLE IF NOT EXISTS` in its own module.
- Core does not query addon tables.
- Do not join the tables of two addons without a written reason.
- A small value can go in the existing `kv` table with the key prefix
  `<addon>.`. Do not force relational state into KV.
- In memory, keep addon state out of `Inner`. The addon holds its state in
  its own struct.
- If a seam needs both locks, take the Core `Inner` lock first, then the
  addon lock. Never take the Core lock while you hold an addon lock.
- Never drop or rename a table or a column that holds user data. If the
  owner of a column changes, keep the column and move the code that reads it.
  Example: `worktree_meta.town_slug` is unused, and it stays.

## Target layout

This is the proposal. Milestone 1 confirms it or changes it.

```text
crates/tomo-proto/src/
  lib.rs                  composition root: Call, Event, Snapshot, HOOK_EVENTS, re-exports
  core.rs                 Repo, Worktree, Pane, Tab, AgentPresence, AttentionItem, ActivityEvent, ...
  addons/<name>.rs        Town, PullRequest, ActionDef, RuntimeEndpoint, UsageSnapshot, ...
crates/tomod/src/
  main.rs                 composition root: startup, tasks, Seams
  dispatch.rs             composition root: Call -> core or addon handler
  daemon.rs store.rs ...  core (no addon names)
  addons/mod.rs           composition root: static list, seams(), migrate(), start()
  addons/<name>/mod.rs    handlers, state, SQL, tests
crates/tomo-cli/src/
  main.rs                 keeps one clap tree; each addon keeps its subcommand block together
app/src/
  App.tsx store.ts shell/ components/ui/ commands/   client core
  addons/index.ts         composition root: builtins
  addons/types.ts         the Addon type (only slots that an extraction needs)
  addons/<name>/          views, components, commands, CSS, tests
```

The TypeScript bindings keep their flat output in `app/src/generated/`, so
existing imports do not change.

## Automated dependency check

Add this check in milestone 1, together with the first `addons/` directory.
Before that directory exists, the check has nothing to find.

**Rust.** Add a `#[test] fn core_does_not_import_addons` in
`crates/tomod/src/addons/mod.rs`. It uses only `std::fs`.

1. Walk `crates/tomod/src` and `crates/tomo-proto/src`.
2. Skip the addon trees (`crates/tomod/src/addons/`, `crates/tomo-proto/src/addons/`).
3. Skip the composition roots (`crates/tomod/src/main.rs`, `crates/tomod/src/dispatch.rs`, `crates/tomo-proto/src/lib.rs`).
4. In every other `.rs` file, fail on each match of `addons::` or `mod addons`.
5. For each addon that a milestone has finished, fail on its noun list in the
   same core files. The list starts with `town_slug`, `town_by_worktree`,
   `towns::`, `TownUnlock`. Milestone 2 adds `PullRequest`, `review_decision`,
   `checks_failed`, `mergeable`, `prs`.
6. For each file under `addons/<a>/`, fail on `addons::<b>` unless the pair
   (a, b) is in the "Allowed addon dependencies" table.
7. Print the file, the line, and the match.

The test runs in `cargo test --workspace`, so it needs no new tool.

**TypeScript.** Add `app/src/addons/boundary.test.ts` (vitest, `node:fs`).

1. Read every `.ts` and `.tsx` file under `app/src`.
2. Skip `app/src/generated/`, `app/src/addons/`, and test files.
3. Fail if a file imports a path that contains `addons/<name>`.
   Only `app/src/addons/index.ts` may import an addon folder.
   Core files may import `addons/index.ts` and `addons/types.ts`.
4. For each file under `app/src/addons/<a>/`, fail on an import of `addons/<b>/` unless the table allows the pair.

**Omission check.** Milestone 1 decides between two options:

- a default-on Cargo feature for each addon in `tomod`, with
  `cargo check -p tomod --no-default-features` in the gates
- a test that builds `Seams` without the addon and runs the worktree
  lifecycle tests

Prefer the test if the feature flags spread `#[cfg]` through Core.

## Add an addon (target)

1. Answer the three questions at the top. If the code is Core reality, do not make an addon.
2. **Proto.** Put the types in `crates/tomo-proto/src/addons/<name>.rs` and derive `TS`.
   Add the `Call` and `Event` variants in `lib.rs` next to the other variants of that addon.
   Run `TOMO_WRITE_TYPES=1 cargo test -p tomo-proto` and commit `app/src/generated`.
3. **Daemon.** Make `crates/tomod/src/addons/<name>/mod.rs` with the handlers, the state struct, and the SQL.
   Add one line to `addons/mod.rs` and one arm for each call in `dispatch.rs`.
   Add a seam only if the addon must take part in a Core operation.
4. **Background work.** Write the reason in the addon doc. If there is no reason, add no background work.
5. **CLI.** Add a subcommand block in `crates/tomo-cli/src/main.rs` with a `--json` branch.
6. **GUI.** Make `app/src/addons/<name>/index.ts`, which exports one `Addon` value. Add it to `builtins`.
7. **Tests.** Put unit tests next to the code.
   For daemon behavior, add `scripts/torture/<name>.sh` and add its name to `scripts/torture/run-all.sh`.
8. **Docs.** Write `docs/<name>.md`, and add a row to the candidate table in this file.
9. Run the gates and the baseline commands.

## Remove an addon (target)

1. Delete `crates/tomod/src/addons/<name>/`, `crates/tomo-proto/src/addons/<name>.rs`, and `app/src/addons/<name>/`.
2. Remove the registration lines:
   - the entry in `addons/mod.rs`
   - its arms in `dispatch.rs`
   - its `Call` and `Event` variants
   - its `HOOK_EVENTS` names
   - its entry in `builtins`
   - its CLI subcommand
   - its entry in `run-all.sh`
3. Run `TOMO_WRITE_TYPES=1 cargo test -p tomo-proto`.
4. Keep its SQLite tables. Do not write a migration that drops user data.
5. Run the full gates. Everything except the removed feature must work.

If step 2 needs more than these lines, the extraction is not complete.
Record the remaining coupling in [addons-map.md](addons-map.md).

## Add a UI contribution (target)

Use an existing slot. Add a new slot only when an extraction needs it. Do not
add a slot "for later".

Slots that the current code needs (from the map):

| Slot | First user | Current hard-coded site |
|---|---|---|
| global view | towns, activity | `App.tsx:135-141`, `uiState.ts:13`, `TopStrip.tsx:11`, `appMenu.ts:27` |
| worktree create field | towns | `Dialogs.tsx:103-168` |
| store slice and frame reducer | every addon | `store.ts` `State`, `applyFrame` |
| inspector section | github | `RightSidebar.tsx`, `RightRail.tsx`, `uiState.ts:12` |
| worktree signal | github, runtime | `activityModel.ts` `nowSignals`, `Signals.tsx`, `LeftRail.tsx` |
| topbar item | actions | `WorktreeHeader.tsx` `ActionBar` |
| bottom-strip item | usage | `shell/BottomStrip.tsx:25` |
| diagnostics section | usage | `shell/Diagnostics.tsx` |
| pane renderer | browser | `Layout.tsx:20`, `Tabs.tsx:111` |
| browser toolbar item | agentation | `BrowserPane.tsx:200-220` |
| activity row renderer | actions, runtime, github, agentation | `Activity.tsx` `whoOf`, `EventRow`; `glyphs.ts` `ACTIVITY` |

Each slot must have these properties:

- Each item has an id that does not change.
- The order is the order of `builtins`.
- An item renders from the store and calls commands.
- An item does not change the slice of another addon.
- An item that is not visible starts no work.

Commands keep using the one registry in `app/src/commands/*.ts`. An addon
exports its commands. The registry adds them in `builtins` order.

## Candidates

| Candidate | Verdict | Top leaks today (see the map) |
|---|---|---|
| towns | addon | `Worktree.town_slug`, `WorktreeCreate.town_slug`, `Inner.town_by_worktree`, town pick inside the `WorktreeCreate` arm, `towns` table in core `SCHEMA` |
| github | addon | `Repo.github` computed in core `repo_view`, `Inner.prs`, `ActivityKind::PrMerged`, `TownHistory.pr` |
| actions | addon | `Pane.action_id` and `panes.action_id`, `on_exit` action branch, `AttentionKind::Crash`, `HookEvent.action`, four `ActivityKind::Action*` |
| runtime | addon | `Inner.endpoints`, `Snapshot.endpoints`, `RuntimeEndpoint.action_id` filled from `inner.actions`, `ENDPOINT_REPEAT_MS` in `activity.rs` |
| usage | addon | `Inner.usage`, `Snapshot.usage`, hard-mounted `UsageStrip`, `fetch_all` names the providers |
| browser | study (milestone 6) | `PaneKind`, `Pane.url`, `create_browser_pane` in `daemon.rs`, `Layout.tsx:20` switch |
| agentation | addon on browser | `AnnotationsSend` arm, `ActivityKind::AnnotationsSent`, `annotation.sent` hook, all UI inside `BrowserPane.tsx`, inject code inside Tauri `browser_create` |
| activity projections | partial | closed `ActivityKind` with 8 feature nouns, unknown kind decodes as `HookFailed`, two different "Needs Me" definitions |
| agent providers | evaluate last | closed `AgentKind` in 10 types, spawn plan built in 3 places, `detect_agent` and env stripping in core |

## Migration order

The PRD order is: Towns, GitHub, Actions, Runtime, Usage, Browser,
Agentation, Activity, providers, and an optional `tomo-core` crate.

Keep that order with one change: **do the Activity kind seam before
GitHub.** Leave only the Activity UI cleanup in milestone 8.

The reasons for the order:

1. **Towns first.** It is the smallest addon and already mostly isolated. It
   emits no activity kind. It needs exactly one transactional seam (worktree
   create), so it proves the seam pattern, the layout, and the dependency check.
2. **Activity kind seam second (moved forward from milestone 8).** GitHub,
   Actions, Runtime, and Agentation each add a variant to `ActivityKind`, and
   Actions and Runtime add `HOOK_EVENTS` names. If `ActivityKind` stays closed
   in Core, each of those milestones must leave an addon noun in Core. The
   shared rules forbid coupling that stays "for later". Also, `store.rs`
   `activity_row` decodes an unknown kind as `HookFailed`, so an omitted addon
   corrupts its history rows on read.
3. **GitHub, then Actions, then Runtime.** GitHub is read-only and pull-based,
   so it has low risk. Runtime reads Action provenance
   (`RuntimeEndpoint.action_id` and the label from `inner.actions`). Actions
   must first turn `Pane.action_id` into a generic pane provenance label that
   Core owns. Then Runtime can use that label without an addon-to-addon
   dependency.
4. **Usage.** It is small and has no transactional seam. It can move at any
   time after the seam pattern exists.
5. **Browser, then Agentation.** Agentation depends on Browser, and its code
   lives inside `BrowserPane.tsx` and inside Tauri `browser_create`. These two
   milestones change native webview behavior, which the agents cannot see
   without a GUI. They need a human check.
6. **Activity UI, then providers, then `tomo-core`.** These are the widest
   changes. They are safe only after the narrower boundaries exist.

## Milestone risks and narrowest seams

### 1. Towns

Risks:

- `WorktreeCreate` fails with `Conflict` when every town is unlocked and no path is given. The seam must keep that behavior.
- Creation is not atomic today: `git worktree add` runs before the unlock row is written. Keep the same order. Do not claim more.
- Removing `Worktree.town_slug` changes the wire. The CLI (`print.rs:70`) and the GUI must change in the same commit.
- `features/towns.rs` includes `app/src/data/japan-towns.json` with `include_str!`.
- A known bug: see "Problems found".

Narrowest seam:

- Core keeps `WorktreeCreate { path: Option<..> }` and one generic `name_hint: Option<String>`, with `#[serde(alias = "town_slug")]` so that old clients still work.
- Core calls a naming seam before `git worktree add`: `fn(&Inner, &WorktreeCreate) -> Result<Option<NamedPath>, RpcError>`.
- Core calls a created seam under the same lock segment where the unlock row and `display_name` are written today: `fn(&mut Inner, &NamedPath, &Id) -> Result<(), RpcError>`.
- Core also calls a rebind seam from `restore_worktree` and from the gitdir rebind in `discover`: `fn(&Inner, old: &Id, new: &Id)`.
- Core does not know what a hint or a name means.
- Clients get the town of a worktree from `town_list` unlocks, which `store.ts:196` already loads.

### 2. GitHub

Risks:

- `Repo.github` is computed in core `repo_view` on every discovery, and `Sidebar.tsx:151` uses it for avatars.
- `TownHistory.pr` reads `inner.prs`, which is a Towns to GitHub dependency.
- `Inner.prs` is never cleared on archive or rebind.
- No torture script covers GitHub.

Narrowest seam: none that is transactional. The work is pull-based.

- Move `github_repo` parsing to the addon. The addon computes `Repo.github` from the `Repo.remote_url` of Core.
- For `TownHistory.pr`, let the client join the town history with `pr_status`, or let a composition root pass the PR.

### 3. Actions

Risks:

- The action branch is inside the core pane exit path (`on_exit`, `daemon.rs:860-868`).
- `restore` strips `action_id` (`daemon.rs:1139`), and `reopen.rs` drops it.
- `AttentionKind::Crash` is Action-only.
- `keyBindings` in `store.ts` merges `action:<id>` shortcuts into Core bindings.
- Documentation and code disagree about `action_stopped` (see "Problems found"). Characterization tests must record what the code really does.

Narrowest seam:

- `Pane.action_id` stays as the wire field and the column. Core treats it as an opaque provenance label that it keeps and strips on restore.
- A pane exit seam `fn(&mut Inner, &PaneExit)` receives the label, the exit code, and `stop_intent`.
- `reload_actions` becomes a discovery seam, `fn(&mut Inner, &[Id])`.
- The watcher asks the seam list whether a changed file name belongs to an addon (`.tomo.toml`).

### 4. Runtime

Risks:

- The `lsof` cost per tick. Keep the rule "no candidate pids means no `lsof`".
- `CheckpointBanner` and `Activity.tsx` use an endpoint for "Open App".
- `RuntimeProtocol::Https` is never produced.

Narrowest seam: a monitor tick seam `fn(&Arc<Daemon>)` after `poll_once`, called with the lock released, exactly where `scan_endpoints` runs today (`monitor.rs:110`). Runtime reads the Core provenance label from milestone 3, not `inner.actions`.

### 5. Usage

Risks:

- `Snapshot.usage` is part of the wire snapshot.
- The thresholds exist two times (`usage.rs` and `bottomModel.ts`).
- `stripUsage` filters `provider !== "pi"` in UI code.
- No torture script uses `TOMO_USAGE_MOCK`. Add one before the move, because a real fetch uses the user's credentials.

Narrowest seam:

- a start function in `addons::start`
- a public `Daemon::has_subscriber()`
- `Snapshot.usage` filled in the composition root
- a bottom-strip slot
- a diagnostics section slot

### 6. Browser (study)

Risks:

- The GUI behavior cannot be verified without a window. The agents can only run `browser.sh` (daemon side).
- The native child webview must hide under every overlay (`BrowserPane.tsx:113`).
- The Tauri main window is a child webview because of Browser.

Narrowest seam: keep `PaneKind` as a Core discriminator, because a pane with no PTY is a real Core fact that recovery and `terminal_only` need. Move `create_browser_pane`, `BrowserOpen`, `BrowserNavigate`, and the UI into the addon. Change `Layout.tsx:20` to a renderer map only if the map is shorter than the switch. Otherwise keep the switch and write the reason here.

### 7. Agentation

Risks:

- `capabilities/browser.json` lets remote pages invoke `browser_feedback`, which is a security surface.
- The GUI cannot be verified without a window.
- `Annotation` is never filled by the GUI.

Narrowest seam:

- a Core operation "paste text into an agent pane" (`pasted`, the live-agent check) that Agentation calls
- a page-load hook and a close hook in the Tauri browser host
- a browser toolbar slot

`evidence_text` and the "Browser feedback" header move to the addon.

### 8. Activity projections

Risks:

- "Needs Me" is defined in SQL (`store.rs:515`) and in `activityModel.ts` `needsMeItem`, and the two definitions differ.
- `activityModel.ts` mixes runtime, usage, and PR helpers.
- `rebind_worktree` does not move `activity` rows.
- A string kind loses compile-time checks.

Narrowest seam (decide in the moved-forward step 2):

- `ActivityKind` keeps the Core variants.
- Each addon defines its kinds in its proto module as a typed enum that serializes to the same snake_case strings, so the wire and the rows do not change.
- `activity_row` keeps an unknown kind as its string and does not rewrite it to `HookFailed`.
- The GUI renders rows through the activity row slot.

### 9. Agent providers

Risks:

- `AgentKind` is in 10 wire types and in 3 SQLite text columns.
- The spawn plan is built in 3 places (`daemon.rs:1145`, `daemon.rs:2040`, `reopen.rs:111`).
- `detect_agent` (`procs.rs:191`) and `inherited_env_to_remove` (`daemon.rs:760`) name providers.
- The fake agent speaks only the Claude protocol, so Codex and Pi have no harness coverage. A regression there is invisible.
- This is the most likely milestone to hit the stop condition "debugging gets worse".

Narrowest seam: keep `AgentKind` as a closed Core enum (a provider id is Core identity). Move only the per-provider functions (plan, hook translation, detection names, env names, install, health, sessions) behind one static `match` in `providers/mod.rs`.

### 10. Optional `tomo-core` crate

Risks:

- `tomod` is a binary crate, and its 109 tests run in the bin target.
- `daemon.rs` has 2553 lines with one global `Inner` mutex.
- A crate split moves tests and changes the test layout.

Do this milestone only if milestones 1 to 9 leave an obvious library edge.

## Problems found in milestone 0 (not fixed)

These are outside the scope of milestone 0. Fix them in separate changes.

1. **Restore loses the town unlock move.** `restore_worktree` (`daemon.rs:1507-1513`) calls `store.town_unlock` with the new id. `town_unlock` runs `INSERT OR IGNORE`, and `slug` is the primary key, so the row keeps the old id. The next `discover` rebuilds `town_by_worktree` from the table. `docs/features/towns.md` says that the row moves.
2. **A worktree move loses addon rows.** `store.rs` `rebind_worktree` updates `worktree_meta`, `tabs`, `panes`, and `attention`, but not `towns` or `activity`. This comes from reading the code; no run verified it.
3. **`action_stopped` on pane close.** `docs/activity.md` says that pane close and archive record `action_stopped`. `remove_pane` removes the pane before `hangup`, so `on_exit` returns early, and no activity or `action.exited` hook runs.
4. **Stale docs.** `docs/usage.md` does not describe `scope`. `docs/activity.md` omits `annotations_sent`. `docs/architecture.md` gives an old main bundle size (295 KB; now 643 kB). `README.md:37` puts usage in the Activity header.
5. **`scripts/perf.sh`** sends `hello` with `protocol: 1` and subscribes before discovery ends.
6. **Dead code.** `townBySlug` (`Towns.tsx:295`) has no importer. `usageSummary` has only a test caller.
