# Core, Client, and Addons

Read this before you add a feature or move one. It takes a few minutes.

Status: milestone 1 (Towns), the Activity kind seam, and milestone 2
(GitHub) are done. Towns is the reference for every later extraction.
GitHub proved the first GUI slots that core components render. See
"Activity kind seam result" and "Milestone 2 result: GitHub".

Related files:

- [addons-map.md](addons-map.md) shows how each candidate touches every layer.
- [addons-baseline.md](addons-baseline.md) has the performance numbers and the test counts before the refactor.
- [features/towns.md](features/towns.md) describes the Towns addon.
- [features/github.md](features/github.md) describes the GitHub addon.

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
| Hooks, activity recording, core activity kinds | `events.rs`, `activity.rs`; `CoreActivity` in `crates/tomo-proto/src/activity.rs` |
| Persistence, recovery | `store.rs`, `daemon.rs` (`restore`) |
| IPC, CLI transport, config | `server.rs`, `main.rs`, `config.rs`, `settings.rs`, `crates/tomo-cli/src/client.rs` |
| Wire types | `crates/tomo-proto/src/lib.rs` |
| Seams (the points where addons join Core) | `Seams` in `daemon.rs` |

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

| Candidate | Status |
|---|---|
| towns | **done** (milestone 1) |
| github | **done** (milestone 2) |
| actions, runtime, usage, agentation | addon, not moved yet |
| browser | study (milestone 6) |
| activity projections | kind seam **done**; UI cleanup in milestone 8 |
| agent providers | evaluate last |

## The dependency law

1. **Core never imports an addon.** A core module must not name an addon
   module, an addon type, or an addon noun.
2. **An addon imports Core.** It uses public Core functions and types.
3. **An addon does not import another addon.** The exception is a dependency
   that the "Allowed addon dependencies" table lists.
4. **Composition roots name everything.** A composition root is a file whose
   only job is to list Core and addons together. The composition roots are:
   - `crates/tomod/src/main.rs`: startup, `addons::seams()`, `addons::migrate()`
   - `crates/tomod/src/addons/mod.rs`: the static addon list, the seam registration, the table creation
   - `crates/tomod/src/dispatch.rs`: the match that sends an addon `Call` to its addon
   - `crates/tomo-proto/src/lib.rs`: the `Call`, `Event`, `Snapshot`, and `HOOK_EVENTS` definitions, and the addon re-exports
   - `app/src/addons/index.ts`: the `builtins` list
   - `app/src/addons/activity.ts`: the Activity row views of addon kinds
   - one `@import` line for each addon in `app/src/styles/index.css`
5. **Deleting an addon must not damage Core.** If you remove the addon
   folders and their registration lines, Tomo must still build. Everything
   except that feature must still work. The Towns deletion test below proves
   this for Towns.

Why rule 4: the wire protocol must stay typed. A closed `Call` enum that
lists addon variants is typed and easy to trace. A generic
`{kind, payload}` envelope is neither. The composition root is the one place
where naming an addon is correct.

### Allowed addon dependencies

| From | To | Reason |
|---|---|---|
| agentation | browser | Agentation annotates a browser pane (not moved yet). |

Towns does not import GitHub. `town_history` gets the pull request from a
plain function that `dispatch.rs` supplies (`town_pr`). Without GitHub, the
function is `|_, _| None`.

## Events and commands

**Commands request work.** Examples: create a worktree, spawn an agent, run
an Action, open a browser pane. A command is a typed `Call` variant, a direct
function call inside the daemon, or a command in `app/src/commands/*.ts`,
`app/src/actions.ts`, or an addon `commands` list in the GUI.

**Events report facts.** Examples: `worktrees_changed`, `agent_changed`,
`activity_added`, `town_unlocked`. An event is an `Event` variant that goes to
the clients, or a `HookEvent` that goes to user hook scripts.

Rules:

- Use a direct typed call when one part needs another part to do something now.
- Use an event only to tell other parts about something that already happened.
- Do not replace a direct call with an event for architectural purity.
- If an addon must take part in a Core operation and the result must be
  consistent, use a **seam**. A seam is a plain function that Core calls
  synchronously inside the operation. Do not emit an event and hope that the
  addon commits later.

## Static composition

Composition is boring on purpose. There are no manifests, no discovery, no
dynamic loading, no service locator, and no dependency injection container.

### Daemon

```rust
// crates/tomod/src/addons/mod.rs
pub mod github;
pub mod towns;

pub fn seams() -> Seams {
    Seams { worktree_namer: Some(towns::name_worktree), worktree_created: vec![towns::unlock], worktree_rebound: vec![towns::rebind] }
}

pub fn migrate(store: &Store) -> anyhow::Result<()> {
    towns::migrate(store)
}
```

`main.rs` calls `Daemon::new(paths, addons::seams())` and then
`addons::migrate(&daemon.lock().store)`. After that, the seams do not change.

```rust
// crates/tomod/src/dispatch.rs
pub fn is_slow(call: &Call) -> bool {
    matches!(call, Call::PrStatus { .. })
}

match call {
    Call::TownList => towns::list(daemon),
    Call::TownPick => towns::pick(daemon),
    Call::TownHistory { slug } => towns::history(daemon, &slug, town_pr),
    Call::PrStatus { worktree_id } => github::pr_status(daemon, worktree_id).await,
    call => daemon.handle(client_id, call).await,
}
```

`server.rs` sends every request to `dispatch::handle`. It asks
`dispatch::is_slow` which addon calls wait on a subprocess, and runs those
in their own task. `Daemon::handle` has
a `_` arm that returns `unsupported`, because the dispatcher answers the
addon calls first. The cost: the compiler does not tell you when a new
**Core** `Call` variant has no arm in `Daemon::handle`. The torture harness
and the CLI tests find it at run time.

### Seams

Core defines `Seams` in `daemon.rs`. Each field is a plain function or a list
of plain functions. Core calls them at one fixed point. The signatures:

```rust
pub struct Seams {
    pub worktree_namer: Option<fn(&Store, &WorktreeCreate) -> Result<Option<String>, RpcError>>,
    pub worktree_created: Vec<fn(&mut Inner, &CreatedWorktree) -> Result<(), RpcError>>,
    pub worktree_rebound: Vec<fn(&Store, &str, &str) -> anyhow::Result<()>>,
}

pub struct CreatedWorktree { pub id: Id, pub repo_id: Id, pub name: Option<String> }
```

| Seam | Where Core calls it | Why it is the narrowest option |
|---|---|---|
| `worktree_namer` | `worktree_create`, before `git worktree add`, only when the client gave no `path` | The directory name must exist before Git runs, so a later hook is too late. It gets only the store and the request. It is an `Option`, not a list, because one directory has one name. An error refuses the create (`conflict` when every town is unlocked, `bad_request` for a taken or unknown town). |
| `worktree_created` | `worktree_create`, after discovery, under the same state lock that queues the `worktree.created` hook | The unlock and the display name must be written exactly once, in the create call, before the reply. An event would let the reply go out before the unlock. It needs `&mut Inner` to set the display name and to emit `TownUnlocked`. |
| `worktree_rebound` | `Daemon::rebind`, which `discover` (a move on disk) and `restore_worktree` (a restore at a new path) call | A new worktree id must move every row that keys on the old id. It gets only the store and the two ids. An error is logged; it does not stop the Core rebind. |

Without a namer, a worktree created without a `path` gets the branch name as
its directory (`feat/x` becomes `feat-x`). That fallback exists so that Tomo
still creates worktrees when no addon names them.

Order of work in a create call, unchanged from before the split:
namer → `git worktree add` → discovery → created seams → `worktree.created`
hook → reply. Creation is not atomic: if a seam fails, the Git worktree
already exists. Two concurrent creates can pick the same town; the second
`INSERT OR IGNORE` keeps the first unlock. Both limits existed before the
split.

### GUI

```ts
// app/src/addons/index.ts
export const builtins: readonly Addon[] = [towns, github];
```

The `Addon` type in `app/src/addons/types.ts` has only the slots that Towns
and GitHub need:

| Slot | Who renders it |
|---|---|
| `views` (global view: id, title, label, icon, lazy component, fallback) | `App.tsx` center area, `Sidebar.tsx` and `shell/LeftRail.tsx` buttons, `shell/TopStrip.tsx` title, the View menu in `appMenu.ts`, view checks in `uiState.ts` |
| `commands` | `allActions()` in `actions.ts` (palette, shortcuts, menus, shortcut reference) |
| `worktreeNameField` | `CreateWorktree` in `Dialogs.tsx`; it reports the `name_hint` |
| `inspectorSections` (id, label, icon, component, rail marker) | `RightSidebar.tsx` after the `git` section, the buttons and markers in `shell/RightRail.tsx`, the section ids for `sanitizeUi` in `store.ts` |
| `worktreeSignals` (a store selector that returns `AddonSignal[]`) | `signalsFor` in `Signals.tsx`, after the core signals; `nowSignals` keeps the cap of three |
| `repoAvatar` (the first addon that has one wins) | `RepoAvatar` in `Sidebar.tsx`, which the sidebar and Home render |
| `mount` | `App.tsx`, once for the session (the unlock ceremony) |
| `onSnapshot` | `applySnapshot` in `store.ts`, after each `subscribe` |
| `onFrame` | `applyFrame` in `store.ts`, for each daemon event |

The order of `builtins` is the render order of every slot. An addon keeps
its own state in its own module (Towns: `app/src/addons/towns/state.ts`), not
in the core `State`. One exception: data that a slot selector reads while a
core component renders. GitHub declares the optional key `State.prs` through
module augmentation in `app/src/addons/github/state.ts`, and only that module
writes it. See "Client state decision" in "Milestone 2 result: GitHub".

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

Towns background work: none in the daemon. The seams run only inside a
create, a move, or a restore. The GUI ceremony stays mounted, but it renders
nothing and starts no timer until a `town_unlocked` event arrives. The map
view and the town dataset load lazily.

GitHub background work: none in the daemon. `gh` runs only inside a
`pr_status` call. The rail marker, the NOW signals, and the town history
read the cache and start no work. See
[features/github.md](features/github.md#background-work).

Background work that exists today and must keep its current trigger:

| Work | Trigger | Owner |
|---|---|---|
| process poll | every 2 s with a subscriber, 15 s without | core `monitor.rs` |
| `lsof` port scan | each monitor tick with candidate pids | runtime |
| `ioreg` system stats | every 5 s with a subscriber | core `system.rs` |
| usage fetch (network, `codex app-server`) | 20 s tick, only with a subscriber and a snapshot older than 5 min | usage |
| `gh pr view` | each `pr_status` call without a cached pull request younger than 60 s; the inspector section asks when it mounts, every 120 s while it is open, and on refresh; `tomo pr` asks once | github (milestone 2 kept this trigger) |
| `session_list` scan | every 30 s while the sessions section is mounted | agent providers |
| Git watcher and 30 s rediscovery | always | core `watch.rs` |

## Addon state

- An addon owns its SQLite tables. It creates them with
  `CREATE TABLE IF NOT EXISTS` in its own `migrate`, and `addons::migrate`
  calls it at startup. Towns: `crates/tomod/src/addons/towns/mod.rs`.
- The addon runs its SQL through `Store::conn()`. Core does not query addon tables.
- If rows of an addon table key on a worktree id, join `worktree_rebound`.
- Do not join the tables of two addons without a written reason.
- A small value can go in the existing `kv` table with the key prefix
  `<addon>.`. Do not force relational state into KV.
- In memory, keep addon state out of `Inner`. Towns keeps no daemon state in
  memory at all; it reads its table when a call needs it. GitHub keeps its
  cache in a `static` in `addons/github/mod.rs`, because tomod runs one
  daemon in each process. Do not add an addon state field to `Daemon`.
- If a seam needs both locks, take the Core `Inner` lock first, then the
  addon lock. Never take the Core lock while you hold an addon lock.
- Never drop or rename a table or a column that holds user data. If the
  owner of a table changes, keep the table and move the code that reads it.
  Example: the `towns` table stayed on disk; only its `CREATE` and its
  queries moved. `worktree_meta.town_slug` stays in old databases; a new
  database does not get this unused column.

## Layout

This layout is confirmed by Towns.

```text
crates/tomo-proto/src/
  lib.rs                  composition root: Call, Event, Snapshot, HOOK_EVENTS, `pub mod addons { pub mod <name>; }`, re-exports
  activity.rs             core: ActivityKind, CoreActivity, ActivityKinds, ActivityEvent, ActivityQuery
  addons/<name>.rs        the addon wire types (Town, TownUnlock, ...) and its activity kind enum
crates/tomod/src/
  main.rs                 composition root: startup, seams, migrate
  dispatch.rs             composition root: addon Call -> addon handler, the rest -> Daemon::handle
  daemon.rs store.rs ...  core (no addon names); Seams lives in daemon.rs
  addons/mod.rs           composition root: static list, seams(), migrate(), the dependency test
  addons/<name>/mod.rs    handlers, seams, SQL, tests
  addons/<name>/model.rs  pure logic and its tests
crates/tomo-cli/src/
  main.rs                 one clap tree; each addon keeps its subcommand block together
app/src/
  App.tsx store.ts shell/ components/ui/ commands/   client core
  activityKinds.ts        core kind views, activityView(), the plain fallback row
  addons/index.ts         composition root: builtins
  addons/activity.ts      composition root: the activity kind views of the addons
  addons/types.ts         the Addon type, ActivityKindView
  addons/boundary.test.ts the import check and the activity kind check
  addons/<name>/          index.ts (the Addon value), activity.ts (its kind views), views, state, CSS, data, tests
```

Milestone 1 did not split `lib.rs` into a `core.rs`. The re-export keeps the
generated TypeScript names flat in `app/src/generated/`, so imports do not
change.

## Automated dependency checks

All checks run in the normal test commands.

**Rust.** `core_does_not_import_addons` in `crates/tomod/src/addons/mod.rs`
reads every `.rs` file under `crates/tomod/src` and `crates/tomo-proto/src`.
It skips the `addons/` folders and the composition roots `main.rs`,
`dispatch.rs`, and `tomo-proto/src/lib.rs`. It fails on `addons::`,
`mod addons`, the word `town`, or a GitHub noun (`github`, `pullrequest`,
`prstatus`, `pr_status`, `prchanged`, `pr_changed`, `review_decision`,
`checks_failed`, `mergeable`), in any case. It prints the file, the line,
and the match. When a milestone finishes an addon, add its nouns to
`ADDON_NOUNS`. The check between two addons is not written yet, because one
addon exists; add it with the second addon.

**TypeScript.** `app/src/addons/boundary.test.ts` reads every non-test `.ts`
and `.tsx` file under `app/src` outside `generated/` and `addons/` with
`import.meta.glob(..., { query: "?raw" })`. It fails if a file imports an
addon folder. A core file may import only `addons/index.ts` and
`addons/types.ts`. It does not read CSS, so the `@import` line in
`styles/index.css` is a listed registration line. The test "core client
files do not name GitHub pull request nouns" fails on `GitHub`
(case-sensitive), `PullRequest`, `PrStatusResult`, `review_decision`,
`checks_failed`, `mergeable`, `pr_status`, `pr_changed`, or `prs` in a core
client file. Lowercase `github` stays allowed for example text, such as the
clone dialog placeholder.

**Activity kinds.** `core_activity_code_does_not_name_addon_kinds` in
`crates/tomod/src/addons/mod.rs` reads the code before `#[cfg(test)]` in
`tomod/src/activity.rs`, `store.rs`, `events.rs`, and
`tomo-proto/src/activity.rs`. It fails on an addon kind enum name, an addon
kind string, or `endpoint_repeat`. The test "core activity files do not name
an addon activity kind" in `boundary.test.ts` does the same for
`Activity.tsx`, `activityKinds.ts`, `activityModel.ts`, and `glyphs.ts`.
`daemon.rs` and `runtime.rs` still name addon kinds, because the Actions,
Runtime, and Agentation code is not extracted yet.

All four checks were proven. A planted core file that named `addons::towns`
(Rust) or imported `./addons/towns` (TypeScript) made the import checks
fail. A planted `ActionActivity::Crashed` doc line in `tomod/src/activity.rs`
and a planted `"pr_merged"` constant in `glyphs.ts` made the activity checks
fail. The GitHub noun checks were proven the same way: a planted
`// PullRequest review_decision` line in `procs.rs` and a planted
`"pr_status"` constant in `glyphs.ts` made each check fail.

**Omission check.** Milestone 1 chose a deletion test over Cargo features.
Features would spread `#[cfg]` through Core, and the GUI and the proto crate
would need the same switch. Do the deletion test for each finished addon, as
below.

## Add an addon

Towns is the worked example for each step.

1. Answer the three questions at the top. If the code is Core reality, do not make an addon.
2. **Proto.** Put the types in `crates/tomo-proto/src/addons/<name>.rs` and derive `TS`.
   In `lib.rs`, add `pub mod <name>;` inside `pub mod addons`, add `pub use addons::<name>::*;`,
   and add the `Call` and `Event` variants next to the other variants of that addon.
   Run `TOMO_WRITE_TYPES=1 cargo test -p tomo-proto` and commit `app/src/generated`.
   If the addon records activity, put an enum of its kinds in the same file. Rename each variant to
   `<addon>.<name>`, add `impl ActivityKinds for <Enum> {}`, and add its `export_all` line.
3. **Daemon.** Make `crates/tomod/src/addons/<name>/mod.rs` with the handlers, the SQL, and a `migrate`.
   Add `pub mod <name>;` and its lines to `seams()` and `migrate()` in `addons/mod.rs`.
   Add one arm for each call in `dispatch.rs`.
   Add a seam only if the addon must take part in a Core operation. Add a new `Seams` field only when no field fits, and call it at one fixed point.
4. **Background work.** Write the reason in the addon doc. If there is no reason, add no background work.
5. **CLI.** Add a subcommand block in `crates/tomo-cli/src/main.rs` with a `--json` branch.
6. **GUI.** Make `app/src/addons/<name>/index.ts`, which exports one `Addon` value. Add it to `builtins`.
   Put its CSS next to it and add one `@import` line in `app/src/styles/index.css`.
   Keep its client state in its own module.
   If the addon records activity, add `app/src/addons/<name>/activity.ts` with a `Record<Kind, ActivityKindView>`
   of its generated kind union, and list it in `app/src/addons/activity.ts`.
7. **Tests.** Put unit tests next to the code.
   For daemon behavior, add `scripts/torture/<name>.sh` and add its name to `scripts/torture/run-all.sh`.
   Add the addon nouns to `ADDON_NOUNS`.
8. **Docs.** Write `docs/<name>.md` (Towns: `docs/features/towns.md`), and change the candidate table in this file.
9. Run the gates, the deletion test, and the baseline commands.

## Remove an addon

1. Delete `crates/tomod/src/addons/<name>/`, `crates/tomo-proto/src/addons/<name>.rs`, and `app/src/addons/<name>/`.
2. Remove the registration lines:
   - its lines in `seams()` and `migrate()` in `addons/mod.rs`
   - its arms and its `use` line in `dispatch.rs`
   - its `mod` line, its re-export, its `Call` and `Event` variants, its `HOOK_EVENTS` names, and its `export_all` lines in `lib.rs`
   - its entry in `builtins`
   - its entry in `app/src/addons/activity.ts`
   - its `@import` line in `app/src/styles/index.css`
   - its CLI subcommand block and printer
   - its entry in `run-all.sh`
3. Run `TOMO_WRITE_TYPES=1 cargo test -p tomo-proto`.
4. Keep its SQLite tables. Do not write a migration that drops user data.
   Its activity rows stay. They read back with their kind string and render as plain rows.
5. Run the full gates. Everything except the removed feature must work.

If step 2 needs more than these lines, the extraction is not complete.
Record the remaining coupling in [addons-map.md](addons-map.md).

### Towns deletion test (milestone 1)

Done on a throwaway branch from commit `26a5c66`, then deleted. The removal
changed 29 files: 1141 lines deleted, 6 lines added. Outside the three
deleted folders and the regenerated `app/src/generated/Town*.ts`,
`Event.ts`, and `index.ts`, these are the only lines that changed:

| File | Change |
|---|---|
| `crates/tomod/src/addons/mod.rs` | remove `pub mod towns;`; `seams()` returns `Seams { worktree_namer: None, worktree_created: vec![], worktree_rebound: vec![] }`; `migrate` returns `Ok(())` |
| `crates/tomod/src/dispatch.rs` | remove `use crate::addons::towns;` and the three town arms |
| `crates/tomo-proto/src/lib.rs` | remove `pub mod addons { pub mod towns; }`, `pub use addons::towns::*;`, `TownList`, `TownPick`, `TownHistory`, `Event::TownUnlocked`, and the two `export_all` lines |
| `crates/tomo-cli/src/main.rs` | remove `Cmd::Towns`, `enum TownsCmd`, and its two handlers (21 lines) |
| `crates/tomo-cli/src/print.rs` | remove `print::towns` (16 lines) |
| `app/src/addons/index.ts` | remove the `towns` import; `builtins` becomes `[]` |
| `app/src/styles/index.css` | remove `@import "../addons/towns/towns.css";` |
| `scripts/torture/run-all.sh` | remove `towns` from the list |

Result with Towns removed:

| Check | Result |
|---|---|
| `TOMO_WRITE_TYPES=1 cargo test -p tomo-proto` | pass |
| `cargo test --workspace` | pass: 112 tests (tomod 105, tomo-proto 5, tomo_app_lib 2) |
| `npx tsc --noEmit` | exit 0 |
| `npx vitest run` | 28 files, 190 tests pass |
| `npx vite build` | pass |
| `scripts/torture/archive.sh` (creates worktrees without `--path`) | 17 passed, 0 failed |

The removed build has three compiler warnings and no errors: the `_` arm in
`Daemon::handle` is unreachable, `Store::conn` is not used, and the fields of
`CreatedWorktree` are not read. They show seams that no addon uses. They are
expected.

`--town` stays on `tomo worktree create` after the removal, because it only
sets the generic `name_hint`.

## Add a UI contribution

Use an existing slot. Add a new slot only when an extraction needs it. Do not
add a slot "for later". Add the slot to the `Addon` type, then render it at
one site from `builtins`.

Slots that exist (see "Static composition, GUI"): `views`, `commands`,
`inspectorSections`, `worktreeSignals`, `repoAvatar`, `worktreeNameField`,
`mount`, `onSnapshot`, `onFrame`.

Slots that later milestones will need (from the map):

| Slot | First user | Current hard-coded site |
|---|---|---|
| inspector section | **done**: `inspectorSections` (milestone 2) | none |
| worktree signal | **done**: `worktreeSignals` (milestone 2); runtime is the next user | the runtime signal in `activityModel.ts` `nowSignals` |
| topbar item | actions | `WorktreeHeader.tsx` `ActionBar` |
| bottom-strip item | usage | `shell/BottomStrip.tsx` |
| diagnostics section | usage | `shell/Diagnostics.tsx` |
| pane renderer | browser | `Layout.tsx`, `Tabs.tsx` |
| browser toolbar item | agentation | `BrowserPane.tsx` |
| activity row view | **done**: `app/src/addons/activity.ts`, not an `Addon` slot (see "Activity kind seam result") | none |

Each slot must have these properties:

- Each item has an id that does not change.
- The order is the order of `builtins`.
- An item renders from the store and calls commands.
- An item does not change the state of another addon.
- An item that is not visible starts no work.

Commands keep using the one registry. An addon exports its commands in its
`Addon` value, and `allActions()` adds them in `builtins` order, after the
core actions.

## Milestone 1 result: Towns

### What moved

| From | To |
|---|---|
| Town types in `tomo-proto/src/lib.rs` | `crates/tomo-proto/src/addons/towns.rs` |
| `crates/tomod/src/features/towns.rs` | `crates/tomod/src/addons/towns/model.rs` |
| town arms in `Daemon::handle`, the town pick in the `WorktreeCreate` arm, `Inner.town_by_worktree`, the `towns` schema and queries in `store.rs` | `crates/tomod/src/addons/towns/mod.rs` and the three seams |
| `app/src/Towns.tsx`, `TownReveal.tsx`, `townCeremony.ts` (now `model.ts`), `styles/towns.css`, `data/japan-*.json` | `app/src/addons/towns/` |
| `State.unlocks`, `State.townReveal`, the `town_unlocked` reducer case, the `town_list` call in `applySnapshot` | `app/src/addons/towns/state.ts` and `index.ts` |
| the town suggestion in `CreateWorktree`, `MapLoading`, `townsProgress`, the `towns` command, the "Japan map" buttons, the view title | `TownSuggest.tsx`, `MapLoading.tsx`, `model.ts`, `index.ts` |

### Wire and schema changes

- `Worktree.town_slug` is removed. The installed CLI reads `Worktree` with
  `#[serde(default)]`, so it still works. The GUI never read the field. The
  CLI worktree printer no longer adds `town <slug>`; the path already ends in
  the slug. A script that read `town_slug` from `worktree ... --json` must
  use `tomo towns list --unlocked --json` (as `towns.sh` does now).
- `WorktreeCreate.town_slug` is now `name_hint`, with
  `#[serde(alias = "town_slug")]`. An installed GUI or CLI that sends
  `town_slug` still gets the town that it asked for. A test covers the alias.
  ts-rs prints "failed to parse serde attribute" for the alias at compile time.
- Method names, event names, and every other field are unchanged.
- SQLite: no table or column is dropped. The `towns` table and its rows
  stay. A new database does not get the unused `worktree_meta.town_slug`
  column.

### Fixed invariant bugs

Characterization tests came first (commit `ea606f0`, failing), then one
commit for each fix:

1. `store: rebind moves activity rows` (Core): a moved worktree kept its
   activity on the old id.
2. `towns: a worktree move keeps the unlock`: the rebind did not move the
   `towns` row. The fix now lives in the `worktree_rebound` seam.
3. `restore: rebind the worktree id when the path changes` (Core): a restore
   into a new parent directory lost the display name, and `INSERT OR IGNORE`
   kept the unlock on the old id. `restore_worktree` now calls the same
   rebind as a move.

### Coupling that stays

| Coupling | Why it stays |
|---|---|
| `Call`, `Event`, and the re-export in `tomo-proto/src/lib.rs` | composition root; the typed wire needs the variants |
| `tomo towns` CLI block and `--town` in `crates/tomo-cli` | the layout rule keeps one clap tree; `--town` sets the generic `name_hint` |
| the `town_slug` alias on `WorktreeCreate.name_hint` | compatibility with installed clients; remove it when no old client exists |
| the `@import` of `towns.css` in `styles/index.css` | the cascade order of the CSS must not change |
| `.town-row`, `.towns-list`, `.towns-map` selectors in `styles/interaction.css` | shared interaction rules; moving them could change the cascade, and dead selectors do no harm |
| `"rare"` and `"legendary"` chimes in `sounds.ts`, and the sound setting text in `Settings.tsx` | user-visible copy and a shared sound module; a later cleanup can move them |
| ~~`town_history` reads `Inner.prs`~~ | resolved in milestone 2 |
| `Daemon::handle` has a `_` arm | the dispatcher answers addon calls first; see "Static composition" |

### Small user-visible changes

- The create-worktree location placeholder shows `<name>` instead of
  `<town>` until the town suggestion arrives.
- In the palette and the shortcut reference, "Open Japan map" comes after
  the other core actions, because addon commands follow the core actions.
- The Vite build puts the former `actions` chunk (preloaded at startup) into
  the main chunk. The JavaScript that loads at startup is the same size.

### Performance

Measured on 2026-09-15 with the commands in
[addons-baseline.md](addons-baseline.md), release build, data dirs
`/tmp/tomo-addons-towns-*`. The owner used the machine during the runs.

Round trips (`addons-bench.py ops 3`, median of the trial medians):

| Metric | Baseline | Milestone 1 | Change |
|---|---|---|---|
| Reattach | 7.66 ms | 8.24 ms | +0.58 ms |
| of which `subscribe` | 0.51 ms | 0.52 ms | +0.01 ms |
| of which `pane_attach` | 7.14 ms | 7.48 ms | +0.34 ms |
| Worktree switch | 0.14 ms | 0.19 ms | +0.05 ms |
| Worktree switch with attach | 9.26 ms | 8.95 ms | −0.31 ms |
| Refresh | 164.31 ms | 155.83 ms | −8.48 ms |
| Process poll, fresh | 23.41 ms | 19.53 ms | −3.88 ms |
| Process poll, cached | 0.63 ms | 0.60 ms | −0.03 ms |

Idle (`addons-bench.py idle 60`, 3 windows each):

| Metric | Baseline | Milestone 1 (runs) |
|---|---|---|
| Idle CPU, no subscriber | 0.13 % | **0.13 %** (0.13, 0.12, 0.13) |
| Idle CPU, one subscriber | 1.05 % | **0.78 %** (0.75, 0.78, 0.92) |
| RSS at window end, no subscriber | 14.6 MB | **11.3 MB** (14.5, 10.2, 11.3) |
| RSS at window end, subscribed | 14.6 MB | **13.2 MB** (14.0, 13.1, 13.2) |

`scripts/perf.sh` (3 runs, median):

| Step | Baseline file | Milestone 1 | Base commit `29e1d1e`, same session, warm run |
|---|---|---|---|
| socket ready | 8.1 ms | 106.4 ms | 104.5 ms |
| hello (error reply) | 41.7 ms | 46.6 ms | 38.5 ms |
| subscribe | 1.4 ms | 1.8 ms | 1.1 ms |
| worktrees visible after launch | 224.8 ms | 321.3 ms | 335.5 ms |
| summaries done after launch | 437.9 ms | 546.5 ms | 565.8 ms |
| `worktree_refresh` | 175.7 ms | 206.3 ms | 175.3 ms |
| `ps` fresh | 8.7 ms | 10.7 ms | 11.2 ms |
| `ps` cached | 0.3 ms | 0.3 ms | 0.4 ms |
| `worktree_list` | 0.2 ms | 0.2 ms | 0.4 ms |
| idle CPU, 20 s subscribed | 0.5 % | 0.5 % | 0.4 % |
| RSS | 16 MB | 15 MB | 15 MB |

The launch rows of `perf.sh` are slower than the baseline file. A release
binary built from the base commit and run in the same session gave the same
slow numbers (its first, cold run was slower still: socket ready 428 ms,
worktrees visible 653 ms). The difference therefore comes from the machine
load that day, not from the change. The change also removes work from
startup: discovery no longer reads the `towns` table.

Gate: pass. No round trip is more than 1 ms and 20 % slower. Idle CPU and
RSS are below the limits. GUI cold launch and GUI RSS: not measured (no GUI
allowed). The soak (`scripts/soak/busy.sh`) was not run in milestone 1.

Test counts:

| Suite | Baseline | Milestone 1 |
|---|---|---|
| `cargo test --workspace` | 115 | 121 (tomod 114, tomo-proto 5, tomo_app_lib 2) |
| vitest | 27 files, 194 tests | 29 files, 197 tests |
| torture harness | 278 checks | 283 checks (`towns.sh` 6 → 11) |

No test was removed. The Towns tests moved from `delight.test.tsx` to
`app/src/addons/towns/towns.test.tsx`, and one store test moved to the Towns
addon.

## Activity kind seam result

This step moved forward from milestone 8, so that GitHub, Actions, Runtime,
and Agentation do not add nouns to a Core enum.

### Decision

- **Core kinds.** `CoreActivity` in `crates/tomo-proto/src/activity.rs` is a
  closed enum of 9 kinds. The wire type `ActivityKind` is a string newtype.
- **Addon kinds.** Each addon owns an enum in
  `crates/tomo-proto/src/addons/<name>.rs` that implements `ActivityKinds`.
  `impl<K: ActivityKinds> From<K> for ActivityKind` makes the string from the
  serde name. A Rust call site stays typed:
  `activity::event(ActionActivity::Crashed, ...)`.
- **Strings.** The 16 stored strings do not change. Namespaced strings such as
  `actions.crashed` were rejected for the existing kinds. The installed CLI
  decodes `ActivityEvent.kind` into its closed enum, and serde fails the
  whole `Vec`. So `tomo activity` would fail for every list that holds one
  such row. Stored rows would also need a read mapping. A **new** addon kind
  uses `<addon>.<name>`.
- **Unknown kinds.** The store keeps the string. A row of an omitted or newer
  addon no longer reads back as `hook_failed`.
- **No `source` field.** The registry already knows the owner of each kind,
  and a field needs a new column. Add it when a client must show the owner of
  an unknown kind.
- **No typed payload per kind.** The views read the payload with
  `payloadString`, as before. Add a payload type when a view needs more than
  one string.
- **GUI registry.** `app/src/activityKinds.ts` has
  `Record<CoreActivity, ActivityKindView>`. Each addon has
  `Record<ActionActivity, ActivityKindView>` (and so on) in
  `app/src/addons/<name>/activity.ts`. A missing view is a compile error,
  because ts-rs generates the unions from the Rust enums. A kind without a
  view renders as a plain row.
- **Not an `Addon` slot.** The first attempt was an `activity` slot on
  `Addon`. It broke module load in 7 test files: the views import
  `actions.ts` for Restart and "go to pane", `actions.ts` imports
  `addons/index.ts`, and the cycle left `failToast` undefined when
  `commands/panes.ts` loaded. The second composition root
  `app/src/addons/activity.ts` has only one importer, `activityKinds.ts`.

### Kinds before and after

| Stored string | Before | After |
|---|---|---|
| `agent_started` | `ActivityKind::AgentStarted` | core `CoreActivity::AgentStarted` |
| `agent_waiting` | `ActivityKind::AgentWaiting` | core `CoreActivity::AgentWaiting` |
| `agent_exited` | `ActivityKind::AgentExited` | core `CoreActivity::AgentExited` |
| `checkpoint_created` | `ActivityKind::CheckpointCreated` | core `CoreActivity::CheckpointCreated` |
| `checkpoint_resolved` | `ActivityKind::CheckpointResolved` | core `CoreActivity::CheckpointResolved` |
| `state_changed` | `ActivityKind::StateChanged` | core `CoreActivity::StateChanged` |
| `archived` | `ActivityKind::Archived` | core `CoreActivity::Archived` |
| `restored` | `ActivityKind::Restored` | core `CoreActivity::Restored` |
| `hook_failed` | `ActivityKind::HookFailed` | core `CoreActivity::HookFailed` |
| `action_started` | `ActivityKind::ActionStarted` | actions `ActionActivity::Started` |
| `action_stopped` | `ActivityKind::ActionStopped` | actions `ActionActivity::Stopped` |
| `action_completed` | `ActivityKind::ActionCompleted` | actions `ActionActivity::Completed` |
| `action_crashed` | `ActivityKind::ActionCrashed` | actions `ActionActivity::Crashed` |
| `endpoint_discovered` | `ActivityKind::EndpointDiscovered` | runtime `RuntimeActivity::EndpointDiscovered` |
| `pr_merged` | `ActivityKind::PrMerged` | github `GitHubActivity::PrMerged` |
| `annotations_sent` | `ActivityKind::AnnotationsSent` | agentation `AgentationActivity::AnnotationsSent` |
| any other string | read back as `hook_failed` | kept as the string, plain row |

Milestone 0 counted 6 addon kinds by feature. By variant, 7 of 16 belong to
addons.

### Compatibility

- **Stored kinds.** The mapping from old stored strings to new kinds is the
  identity for all 16 strings (table above). No migration. A store test
  round trips every string.
- **Wire.** The JSON is unchanged. The generated `ActivityKind.ts` is now
  `string`. New generated files: `CoreActivity.ts`, `ActionActivity.ts`,
  `RuntimeActivity.ts`, `GitHubActivity.ts`, `AgentationActivity.ts`.
- **Installed CLI.** It decodes every current row. It fails on a kind string
  that it does not know, which only a newer build can write.
- **Installed GUI.** The strings are the same, so its rows render as before.

### Needs me

One rule. An attention item needs me when it is unresolved, and a `waiting`
item also is unviewed and has an agent in its pane that still waits. The
daemon applies it in `Store::activity_list`: `ActivityList` passes the panes
where an agent waits, and the SQL checks them with `json_each`. The client
applies it in `needsMeItem`, which now requires the agent list. The Rust
store test and the TypeScript test use the same case table. See
[activity.md](activity.md#needs-me).

### Behavior changes

- `tomo activity --needs-me` drops a waiting item whose agent left `waiting`
  before the daemon resolved the item. The daemon resolves such an item at
  the same state change, so the window is short.
- The "Resolve" button on an Activity row and the checkpoint banner use the
  agent-aware rule. Before, a waiting row whose agent moved on still showed
  "Resolve".
- A row of an unknown kind shows its own kind data, not `hook_failed`.
- A row whose kind has no action view no longer takes the actor from a
  payload `action_id`. No core kind has such a payload.

### Coupling that stays

| Coupling | Why it stays |
|---|---|
| `daemon.rs` and `runtime.rs` name `ActionActivity`, `RuntimeActivity`, `AgentationActivity` | the Actions, Runtime, and Agentation code is not extracted; each milestone moves its call site with its code (the `GitHubActivity` call site moved in milestone 2) |
| the core `checkpoint_created` view falls back to the first HTTP endpoint (`appUrl` reads `State.endpoints`) | the existing checkpoint to runtime link in the map; milestone 4 decides |
| the actions and runtime views read `State.actions` for the action label | Actions state is still Core client state |
| ~~Towns `town_history` names `GitHubActivity::PrMerged`~~ | resolved in milestone 2: `github::known_pr` reads the event |
| `lib.rs` declares and re-exports the four kind modules | composition root |
| the seven older addon kind strings are snake_case | stored rows and installed CLIs |

### Tests

| Suite | Milestone 1 | Activity kind seam |
|---|---|---|
| `cargo test --workspace` | 121 | 128 (tomod 119, tomo-proto 7, tomo_app_lib 2) |
| vitest | 29 files, 197 tests | 30 files, 212 tests |
| torture harness | 283 checks | 283 checks, all pass |

New tests: the store round trip of every kind, the unknown kind, list
filters, the shared "Needs me" cases (Rust and TypeScript), the Activity view
row of every kind in jsdom with filters and row actions, the addon kind
strings in `tomo-proto`, and the two activity dependency checks. No test was
removed. One client case ("waiting, no agent list") was removed, because the
rule without agents no longer exists.

### Performance

Measured on 2026-09-15 with `addons-bench.py`, release build, data dir
`/tmp/tomo-addons-activity-bench`. Another agent built in parallel during
the session, and the owner used the machine.

| Metric | Baseline | Milestone 1 | Activity kind seam |
|---|---|---|---|
| Reattach | 7.66 ms | 8.24 ms | 7.48 ms |
| of which `subscribe` | 0.51 ms | 0.52 ms | 0.46 ms |
| of which `pane_attach` | 7.14 ms | 7.48 ms | 6.97 ms |
| Worktree switch | 0.14 ms | 0.19 ms | 0.13 ms |
| Worktree switch with attach | 9.26 ms | 8.95 ms | 7.90 ms |
| Refresh | 164.31 ms | 155.83 ms | 166.34 ms |
| Process poll, fresh | 23.41 ms | 19.53 ms | 13.45 ms |
| Process poll, cached | 0.63 ms | 0.60 ms | 0.30 ms |
| Idle CPU, no subscriber | 0.13 % | 0.13 % | 0.10 % (0.08, 0.12, 0.10) |
| Idle CPU, one subscriber | 1.05 % | 0.78 % | 0.75 % (0.77, 0.75, 0.63) |
| RSS at window end, no subscriber | 14.6 MB | 11.3 MB | 14.8 MB (15.0, 14.8, 14.7) |
| RSS at window end, subscribed | 14.6 MB | 13.2 MB | 14.6 MB (14.1, 15.1, 14.6) |

The refresh trials were 173.90, 166.34, and 128.35 ms. The change adds no
work to discovery, the monitor, or startup. `ActivityList` now collects the
waiting panes under the lock that it already took.

Gate: pass. No round trip is more than 1 ms and 20 % slower than the
baseline. Idle CPU and RSS are below the limits. The main JS chunk is
719.39 kB, below the 800 KB budget. Not measured: GUI cold launch and GUI
RSS (no GUI allowed). Not run: `scripts/perf.sh` and the soak.

## Candidates

| Candidate | Verdict | Top leaks today (see the map) |
|---|---|---|
| towns | **done** | none in Core; see "Coupling that stays" |
| github | **done** | none in Core; see "Milestone 2 result: GitHub" |
| actions | addon | `Pane.action_id` and `panes.action_id`, `on_exit` action branch, `AttentionKind::Crash`, `HookEvent.action`, the `ActionActivity` call sites in `daemon.rs` |
| runtime | addon | `Inner.endpoints`, `Snapshot.endpoints`, `RuntimeEndpoint.action_id` filled from `inner.actions`, the `RuntimeActivity` call site in `runtime.rs` |
| usage | addon | `Inner.usage`, `Snapshot.usage`, hard-mounted `UsageStrip`, `fetch_all` names the providers |
| browser | study (milestone 6) | `PaneKind`, `Pane.url`, `create_browser_pane` in `daemon.rs`, `Layout.tsx` switch |
| agentation | addon on browser | `AnnotationsSend` arm with the `AgentationActivity` call site, `annotation.sent` hook, all UI inside `BrowserPane.tsx`, inject code inside Tauri `browser_create` |
| activity projections | kind seam **done** | `activityModel.ts` still mixes runtime and usage helpers; see "Activity kind seam result" |
| agent providers | evaluate last | closed `AgentKind` in 10 types, spawn plan built in 3 places, `detect_agent` and env stripping in core |

## Migration order

The PRD order is: Towns, GitHub, Actions, Runtime, Usage, Browser,
Agentation, Activity, providers, and an optional `tomo-core` crate.

Keep that order with one change: **do the Activity kind seam before
GitHub.** Leave only the Activity UI cleanup in milestone 8.

The reasons for the order:

1. **Towns first.** Done. It proved the seam pattern, the layout, and both dependency checks.
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

Done. See "Milestone 1 result: Towns". The planned `name_hint` field and the
three seams were built as planned. One change: the namer and the rebind seam
get `&Store`, not `&Inner`, because Towns needs nothing else.

### 2. GitHub

Done. See "Milestone 2 result: GitHub". Changes from the plan:

- The addon does not fill `Repo.github`. The field is removed, and the GUI
  addon reads the owner from `Repo.remote_url`. The avatar was its only reader.
- A composition root passes the pull request to Towns. The client join was
  rejected, because the CLI and the torture script read `town_history` too.
- The cache does not join `worktree_rebound`. That would change behavior; see
  "Problems found in milestone 2".
- `scripts/torture/github.sh` covers GitHub with a fake `gh`.

### 3. Actions

Risks:

- The action branch is inside the core pane exit path (`on_exit` in `daemon.rs`).
- `restore` strips `action_id`, and `reopen.rs` drops it.
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

Narrowest seam: a monitor tick seam `fn(&Arc<Daemon>)` after `poll_once`, called with the lock released, exactly where `scan_endpoints` runs today (`monitor.rs`). Runtime reads the Core provenance label from milestone 3, not `inner.actions`.

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
- The native child webview must hide under every overlay (`BrowserPane.tsx`).
- The Tauri main window is a child webview because of Browser.

Narrowest seam: keep `PaneKind` as a Core discriminator, because a pane with no PTY is a real Core fact that recovery and `terminal_only` need. Move `create_browser_pane`, `BrowserOpen`, `BrowserNavigate`, and the UI into the addon. Change the `Layout.tsx` switch to a renderer map only if the map is shorter than the switch. Otherwise keep the switch and write the reason here.

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

- **Fixed.** "Needs Me" was defined in SQL (`store.rs`) and in `activityModel.ts` `needsMeItem`, and the two definitions differed.
- **Open.** `activityModel.ts` mixes runtime and usage helpers. The PR helper moved to the GitHub addon in milestone 2.
- **Avoided.** A string kind loses compile-time checks. Each owner has a typed enum and a typed record of views.

The kind seam is done. See "Activity kind seam result". The plan above was
built as planned, with one change: the GUI views are a second composition
root, not a slot on `Addon`. Milestone 8 keeps only the UI cleanup: split
`activityModel.ts` and move each addon's helpers with its milestone.

### 9. Agent providers

Risks:

- `AgentKind` is in 10 wire types and in 3 SQLite text columns.
- The spawn plan is built in 3 places (`daemon.rs` two times, `reopen.rs`).
- `detect_agent` (`procs.rs`) and `inherited_env_to_remove` (`daemon.rs`) name providers.
- The fake agent speaks only the Claude protocol, so Codex and Pi have no harness coverage. A regression there is invisible.
- This is the most likely milestone to hit the stop condition "debugging gets worse".

Narrowest seam: keep `AgentKind` as a closed Core enum (a provider id is Core identity). Move only the per-provider functions (plan, hook translation, detection names, env names, install, health, sessions) behind one static `match` in `providers/mod.rs`.

### 10. Optional `tomo-core` crate

Risks:

- `tomod` is a binary crate, and its tests run in the bin target.
- `daemon.rs` has more than 2500 lines with one global `Inner` mutex.
- A crate split moves tests and changes the test layout.

Do this milestone only if milestones 1 to 9 leave an obvious library edge.

## Problems found in milestone 0

1. **Fixed in milestone 1.** Restore lost the town unlock move.
2. **Fixed in milestone 1.** A worktree move lost the `towns` and `activity` rows.
3. **Open.** `action_stopped` on pane close. `docs/activity.md` says that pane close and archive record `action_stopped`. `remove_pane` removes the pane before `hangup`, so `on_exit` returns early, and no activity or `action.exited` hook runs. The Activity kind seam changed `docs/activity.md` to describe what the code does. The code is not changed; the Actions milestone decides.
4. **Partly fixed.** Stale docs. The Activity kind seam fixed two: `docs/activity.md` lists `annotations_sent`, and `docs/architecture.md` gives the measured main bundle size. Open: `docs/usage.md` does not describe `scope`. `README.md` puts usage in the Activity header.
5. **Open.** `scripts/perf.sh` sends `hello` with `protocol: 1` and subscribes before discovery ends.
6. **Open.** Dead code. `townBySlug` (`app/src/addons/towns/Towns.tsx`) has no importer. `usageSummary` has only a test caller.
