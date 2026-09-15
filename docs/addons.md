# Core, Client, and Addons

Read this before you add a feature or move one. It takes a few minutes.

Status: milestone 1 (Towns), milestone 2 (GitHub), milestone 3 (Actions),
milestone 5 (Usage), and the Activity kind seam are done. Milestone 6 decided
that Browser stays a built-in pane kind; see "Milestone 6 result: Browser".
Towns is the first
addon and the reference for every later extraction. GitHub added the first
GUI slots that core components render. Usage added a background task, a
snapshot field, and two GUI slots. Actions added the Core pane source, two
daemon seams, and six GUI slots. The procedures below are the ones that these
addons proved. See "Activity kind seam result", "Milestone 2 result:
GitHub", "Milestone 3 result: Actions", and "Milestone 5 result: Usage".

Related files:

- [addons-map.md](addons-map.md) shows how each candidate touches every layer.
- [addons-baseline.md](addons-baseline.md) has the performance numbers and the test counts before the refactor.
- [features/towns.md](features/towns.md) describes the Towns addon.
- [features/github.md](features/github.md) describes the GitHub addon.
- [usage.md](usage.md) describes the Usage addon.
- [actions.md](actions.md) describes the Actions addon.

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
| usage | **done** (milestone 5) |
| actions | **done** (milestone 3) |
| runtime, agentation | addon, not moved yet |
| browser | **built-in pane kind** (milestone 6 decision; its code is isolated, not an addon) |
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
   - `crates/tomod/src/main.rs`: startup, `addons::seams()`, `addons::migrate()`, `addons::start()`
   - `crates/tomod/src/addons/mod.rs`: the static addon list, the seam registration, the table creation, the background tasks
   - `crates/tomod/src/dispatch.rs`: the match that sends an addon `Call` to its addon, and the `Snapshot` that adds the addon fields to the `CoreSnapshot`
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
| none | | Milestone 6 kept Browser as a built-in pane kind. So Agentation depends on Core client code, and needs no exception. |

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
pub mod actions;
pub mod github;
pub mod towns;
pub mod usage;

pub fn seams() -> Seams {
    Seams {
        worktree_namer: Some(towns::name_worktree),
        worktree_created: vec![towns::unlock],
        worktree_rebound: vec![towns::rebind],
        worktree_files: vec![actions::FILE],
        pane_exited: vec![actions::exited],
    }
}

pub fn migrate(store: &Store) -> anyhow::Result<()> {
    towns::migrate(store)
}

pub fn start(daemon: &Arc<Daemon>) {
    tokio::spawn(usage::run(daemon.clone()));
}
```

`main.rs` calls `Daemon::new(paths, addons::seams())`, then
`addons::migrate(&daemon.lock().store)`, and after `restore` and the Core
tasks, `addons::start(&daemon)`. After that, the seams do not change.

```rust
// crates/tomod/src/dispatch.rs
pub fn is_slow(call: &Call) -> bool {
    matches!(call, Call::PrStatus { .. })
}

match call {
    Call::Subscribe => ok(Snapshot {
        core: daemon.subscribe(client_id)?,
        usage: usage::snapshots(),
        actions: actions::snapshot(),
    }),
    Call::ActionList { worktree_id } => actions::list(daemon, worktree_id),
    Call::ActionRun { worktree_id, action_id } => actions::run(daemon, &worktree_id, &action_id),
    Call::ActionStop { worktree_id, action_id } => actions::stop(daemon, &worktree_id, &action_id),
    Call::ActionRestart { worktree_id, action_id } => actions::restart(daemon, &worktree_id, &action_id),
    Call::TownList => towns::list(daemon),
    Call::TownPick => towns::pick(daemon),
    Call::TownHistory { slug } => towns::history(daemon, &slug, town_pr),
    Call::PrStatus { worktree_id } => github::pr_status(daemon, worktree_id).await,
    Call::UsageGet { refresh } => usage::get(daemon, refresh).await,
    call => daemon.handle(client_id, call).await,
}
```

`server.rs` sends every request to `dispatch::handle`. It asks
`dispatch::is_slow` which addon calls wait on a subprocess, and runs those
in their own task. `Daemon::handle` has
a `_` arm that returns `unsupported`, because the dispatcher answers the
addon calls first.

**The snapshot.** `Daemon::subscribe` marks the client subscribed and
returns `CoreSnapshot`, which names no addon. `Snapshot` in `lib.rs` is
`#[serde(flatten)] core: CoreSnapshot` plus one field for each addon.
`serde` and `ts-rs` put the flattened fields at the top level, so the JSON
and the generated TypeScript look like one flat object. The flattened
struct must be the Core one: `ts-rs` cannot flatten an empty struct, so an
`AddonSnapshot` would break the bindings when the last addon field goes.
`Daemon::handle` still answers `subscribe` with the `CoreSnapshot` alone,
for a caller that does not go through the dispatcher. No caller does that
today. The cost: the compiler does not tell you when a new
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
    pub worktree_files: Vec<WorktreeFile>,
    pub pane_exited: Vec<fn(&mut Inner, &PaneExit)>,
}

pub struct CreatedWorktree { pub id: Id, pub repo_id: Id, pub name: Option<String> }
pub struct WorktreeFile { pub name: &'static str, pub reload: fn(&Arc<Daemon>) }
pub struct PaneExit { pub pane_id: Id, pub worktree_id: Id, pub source: Option<PaneSource>, pub exit_code: Option<i32>, pub stop_intent: bool }
```

| Seam | Where Core calls it | Why it is the narrowest option |
|---|---|---|
| `worktree_namer` | `worktree_create`, before `git worktree add`, only when the client gave no `path` | The directory name must exist before Git runs, so a later hook is too late. It gets only the store and the request. It is an `Option`, not a list, because one directory has one name. An error refuses the create (`conflict` when every town is unlocked, `bad_request` for a taken or unknown town). |
| `worktree_created` | `worktree_create`, after discovery, under the same state lock that queues the `worktree.created` hook | The unlock and the display name must be written exactly once, in the create call, before the reply. An event would let the reply go out before the unlock. It needs `&mut Inner` to set the display name and to emit `TownUnlocked`. |
| `worktree_rebound` | `Daemon::rebind`, which `discover` (a move on disk) and `restore_worktree` (a restore at a new path) call | A new worktree id must move every row that keys on the old id. It gets only the store and the two ids. An error is logged; it does not stop the Core rebind. |
| `worktree_files` | `discover`, after it releases the state lock and before it flushes the hooks; and `watch.rs`, when a watched worktree root reports a change to that file name | Actions must read `.tomo.toml` at the same two moments as before the split. One list gives both the file name and the reload, so the watcher and discovery cannot disagree. The watcher copies the names at start and runs each reload one time for a burst of changes. `reload` gets the daemon, because it reads files with no lock held and then takes the lock. |
| `pane_exited` | `on_exit`, under the state lock, after the `pane_exited` event and before Core updates the agent and removes a pane that exited with 0 | The outcome (`action_completed`, `action_stopped`, or a crash with its attention item and hook) must go into the same lock as the exit, while the pane still exists for the `pane` field of the hook. An event would come after an exit-0 pane is gone. It gets only the facts of the exit: pane, worktree, source, exit code, and stop intent. |

Actions also calls Core functions: `spawn_in_worktree`, `pane_view`,
`emit_pane`, `emit_tabs`, `hook_pane`, `record`, the crate-wide
`focus_pane` and `push_attention`, and the new `Daemon::stop_pane`, which
ends a pane as a stop (stop intent, process tree kill, scrollback, removal).

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
export const builtins: readonly Addon[] = [towns, github, usage, actions];
```

The `Addon` type in `app/src/addons/types.ts` has only the slots that Towns,
GitHub, Usage, and Actions need:

| Slot | Who renders it | First user |
|---|---|---|
| `views` (global view: id, title, label, icon, lazy component, fallback) | `App.tsx` center area, `Sidebar.tsx` and `shell/LeftRail.tsx` buttons, `shell/TopStrip.tsx` title, the View menu in `appMenu.ts`, view checks in `uiState.ts` | towns |
| `commands` | `allActions()` in `actions.ts` (palette, shortcuts, menus, shortcut reference) | towns |
| `worktreeNameField` | `CreateWorktree` in `Dialogs.tsx`; it reports the `name_hint` | towns |
| `inspectorSections` (id, label, icon, component, rail marker) | `RightSidebar.tsx` after the `git` section, the buttons and markers in `shell/RightRail.tsx`, the section ids for `sanitizeUi` in `store.ts` | github |
| `worktreeSignals` (a store selector that returns `AddonSignal[]`) | `signalsFor` in `Signals.tsx`, after the core signals; `nowSignals` keeps the cap of three | github |
| `repoAvatar` (the first addon that has one wins) | `RepoAvatar` in `Sidebar.tsx`, which the sidebar and Home render | github |
| `mount` | `App.tsx`, once for the session (the unlock ceremony) | towns |
| `bottomItem` | `shell/BottomStrip.tsx`, inside `.bottom-items` at the start of the middle section, before the status slot | usage |
| `diagnosticsSection` | `DiagnosticsReport` in `shell/Diagnostics.tsx`, after the core sections and before the compact actions | usage |
| `topbar.buttons`, `topbar.marks` | `HeaderControls` in `WorktreeHeader.tsx`: `buttons` before the editor button, `marks` after it and before the runtime and overflow buttons | actions |
| `worktreeMenu(w, s)` | `overflowMenu` in `menus.ts`, first, with a separator after a list that is not empty | actions |
| `endpointMenu(worktreeId, e, s)` | `endpointMenu` in `menus.ts`, after "focus logs" | actions |
| `paletteEntries(s, w, context)` | `Palette.tsx`: the context list of the worktree on screen and the worktree sub-list, before the endpoint entries | actions |
| `shortcuts(s)` | `keyBindings` in `store.ts`, `runAction` in `actions.ts`, and `ShortcutReference.tsx` | actions |
| `paneSource { kind, restart }` | the crash toast in `attention.ts`: Restart calls the addon that owns the `kind` of the pane source | actions |
| `onSnapshot(snapshot)` | `applySnapshot` in `store.ts`, with each `subscribe` snapshot | towns, usage, actions |
| `onFrame` | `applyFrame` in `store.ts`, for each daemon event | towns, github, usage, actions |

The order of `builtins` is the render order of every slot. Each item gets
the addon `id` as its React key. An addon keeps its own state in its own
module (Towns: `app/src/addons/towns/state.ts`, Usage:
`app/src/addons/usage/state.ts`, Actions:
`app/src/addons/actions/state.ts`), not in the core `State`. One exception:
data that a slot selector reads while a core component renders. GitHub
declares the optional key `State.prs` through module augmentation in
`app/src/addons/github/state.ts`, and only that module writes it. See
"Client state decision" in "Milestone 2 result: GitHub".

**The editor button contract.** The editor button is Core client, because it
opens `editor_command`. Addon `topbar.buttons` come before it. Addon
`topbar.marks` (Actions: the `.tomo.toml` warning) come after it. That is the
order from before the split.

**Module load.** `store.ts` and `actions.ts` both load `addons/index.ts`. A
module that `addons/index.ts` loads must not import `actions.ts`,
`menus.ts`, `Palette.tsx`, or `activityKinds.ts`, because that cycle can run
`commands/panes.ts` before `store.ts` exists (see "Activity kind seam
result"). Import `store.ts`, `api.ts`, and leaf modules, and reach
`actions.ts` with `import()` inside a click handler. Actions does that for
`copyText` and `openEndpoint`, as `attention.ts` does.

`.bottom-items` always renders, also when it is empty, so that the status
slot and the metrics keep their grid columns.

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

Usage background work: one daemon task, started by `addons::start`, with the
cadence it had in Core (see the table). The reason is in
[usage.md](usage.md), "Polling cadence". The GUI meters start no timer and
no request; the `refresh` link sends one `usage_get` on a click.

Actions background work: none. The reload reads `.tomo.toml` in each
worktree at each discovery and at a watcher change to that file, as before
the split. A run starts a process only on an explicit call. The topbar sends
`action_list` only for a worktree that has no set yet.

Background work that exists today and must keep its current trigger:

| Work | Trigger | Owner |
|---|---|---|
| process poll | every 2 s with a subscriber, 15 s without | core `monitor.rs` |
| `lsof` port scan | each monitor tick with candidate pids | runtime |
| `ioreg` system stats | every 5 s with a subscriber | core `system.rs` |
| usage fetch (network, `codex app-server`) | 20 s tick, only with a subscriber and a snapshot older than 5 min | usage addon (`addons::start`) |
| `gh pr view` | each `pr_status` call without a cached pull request younger than 60 s; the inspector section asks when it mounts, every 120 s while it is open, and on refresh; `tomo pr` asks once | github addon (milestone 2 kept this trigger) |
| `session_list` scan | every 30 s while the sessions section is mounted | agent providers |
| Git watcher and 30 s rediscovery | always | core `watch.rs` |
| `.tomo.toml` reads | each discovery, and a watcher change to the file | actions addon (`worktree_files`) |

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
  memory at all; it reads its table when a call needs it.
- Usage keeps its last result in memory only, because a restart must start
  empty (the first fetch compares against zero). It holds the result in a
  `static Mutex` in `addons/usage/mod.rs`. That is process-wide state; it is
  correct because `tomod.lock` allows one daemon per data dir. The other
  options were worse: a field in `Inner` is a Core leak; a handle passed
  through `server.rs` makes Core carry an addon type; the `kv` table would
  write memory-only data to disk. If a process ever runs two daemons, pass a
  handle instead.
- Actions keeps the parsed `.tomo.toml` sets in memory only, in a
  `static Mutex` in `addons/actions/mod.rs`, for the same reasons. The sets
  come from files, so a restart reads them again. Lock order: the Core state
  lock first, then the sets lock; never lock Core state while you hold the
  sets lock. A reload keeps only the worktrees of its own daemon, so the Rust
  characterization test runs its three scenarios in one test function.
- GitHub keeps its pull request cache in a `static Mutex` in
  `addons/github/mod.rs` for the same reasons. The cache starts empty after a
  restart, as it did in Core.
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
`mod addons`, or a noun that an addon owns (any case), and prints the file,
the line, and the match. `OWNED_NOUNS` lists the nouns of each finished
addon: `town` for Towns; `github`, `pullrequest`, `prstatus`, `pr_status`,
`prchanged`, `pr_changed`, `review_decision`, `checks_failed`, and
`mergeable` for GitHub; `mod usage`, `crate::usage`, `.usage`, `usage:`,
`usagesnapshot`, `usagebucket`, `usage_get`, `usageget`, `usage_changed`,
`usagechanged`, `weekly`, `5-hour`, and `allowance` for Usage. The last three
keep window and allowance words out of the Core agent code. Actions owns
`actiondef`, `actionset`, `actionrunresult`, `actionmode`, `actionshow`,
`actionactivity`, `tomo.toml`, `features::actions`, `inner.actions`,
`run_action`, `stop_action`, `reload_actions`, and `action_def`. The plain
word `action` is not a noun of the check, because Core keeps the
compatibility names `Pane.action_id`, `HookEvent.action`, and
`PaneSource::action_id`. When a milestone finishes an addon, add its nouns
there.

**Rust, between addons.** `an_addon_does_not_name_another_addon` reads every
file under `tomod/src/addons/` (without the composition root `mod.rs`) and
under `tomo-proto/src/addons/`. A file fails if it names a noun that another
addon owns. The Activity kind modules of the addons that are not moved yet
(`actions.rs`, `agentation.rs`, `runtime.rs`) must not name them either.

**TypeScript.** `app/src/addons/boundary.test.ts` reads every non-test `.ts`
and `.tsx` file under `app/src` outside `generated/` and `addons/` with
`import.meta.glob(..., { query: "?raw" })`. It fails if a file imports an
addon folder. A core file may import only `addons/index.ts` and
`addons/types.ts`. It does not read CSS, so the `@import` line in
`styles/index.css` is a listed registration line. The test "an addon
imports no other addon folder" resolves each relative import of a file in
`addons/<name>/`, and fails if the import lands in another addon folder.
The test "core client files do not name an Action type, call, or event"
fails when a file outside `addons/` names `ActionDef`, `ActionSet`,
`ActionRunResult`, `ActionMode`, `ActionShow`, `ActionActivity`, a quoted
`action_list`, `action_run`, `action_stop`, or `action_restart`,
`actions_changed`, `WorktreeAction`, `runningAction`, or `activeActionSet`.
The test "core client files do not name GitHub pull request nouns" fails on
`GitHub` (case-sensitive), `PullRequest`, `PrStatusResult`,
`review_decision`, `checks_failed`, `mergeable`, `pr_status`, `pr_changed`,
or `prs` in a core client file. Lowercase `github` stays allowed for example
text, such as the clone dialog placeholder.

**Activity kinds.** `core_activity_code_does_not_name_addon_kinds` in
`crates/tomod/src/addons/mod.rs` reads the code before `#[cfg(test)]` in
`tomod/src/activity.rs`, `store.rs`, `events.rs`, and
`tomo-proto/src/activity.rs`. It fails on an addon kind enum name, an addon
kind string, or `endpoint_repeat`. The test "core activity files do not name
an addon activity kind" in `boundary.test.ts` does the same for
`Activity.tsx`, `activityKinds.ts`, `activityModel.ts`, and `glyphs.ts`.
`daemon.rs` still names `AgentationActivity`, and `runtime.rs` names
`RuntimeActivity`, because the Runtime and Agentation code is not extracted
yet.

All four checks were proven. A planted core file that named `addons::towns`
(Rust) or imported `./addons/towns` (TypeScript) made the import checks
fail. A planted `ActionActivity::Crashed` doc line in `tomod/src/activity.rs`
and a planted `"pr_merged"` constant in `glyphs.ts` made the activity checks
fail. The GitHub noun checks were proven the same way: a planted
`// PullRequest review_decision` line in `procs.rs` and a planted
`"pr_status"` constant in `glyphs.ts` made each check fail. Milestone 3 proved the Action nouns: a planted `// ActionSet`
line in `tomod/src/monitor.rs` and a planted `"action_run"` constant in
`glyphs.ts` made the checks fail.

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
   If a client needs the addon state at `subscribe`, add a field to `Snapshot` in `lib.rs` and fill it in the `Subscribe` arm of `dispatch.rs`.
4. **Background work.** Write the reason in the addon doc. If there is no reason, add no background work.
   A task gets one line in `addons::start`. It must check for a subscriber or another trigger before it does work.
5. **CLI.** Add a subcommand block in `crates/tomo-cli/src/main.rs` with a `--json` branch.
6. **GUI.** Make `app/src/addons/<name>/index.ts`, which exports one `Addon` value. Add it to `builtins`.
   Put its CSS next to it and add one `@import` line in `app/src/styles/index.css`.
   Keep its client state in its own module.
   If the addon records activity, add `app/src/addons/<name>/activity.ts` with a `Record<Kind, ActivityKindView>`
   of its generated kind union, and list it in `app/src/addons/activity.ts`.
7. **Tests.** Put unit tests next to the code.
   For daemon behavior, add `scripts/torture/<name>.sh` and add its name to `scripts/torture/run-all.sh`.
   Add the addon nouns to `OWNED_NOUNS`.
8. **Docs.** Write `docs/<name>.md` (Towns: `docs/features/towns.md`), and change the candidate table in this file.
9. Run the gates, the deletion test, and the baseline commands.

## Remove an addon

1. Delete `crates/tomod/src/addons/<name>/`, `crates/tomo-proto/src/addons/<name>.rs`, and `app/src/addons/<name>/`.
2. Remove the registration lines:
   - its lines in `seams()`, `migrate()`, and `start()` in `addons/mod.rs`
   - its arms, its `use` line, and its field line in the `Subscribe` arm in `dispatch.rs`
   - its `mod` line, its re-export, its `Call` and `Event` variants, its `Snapshot` field, its `HOOK_EVENTS` names, and its `export_all` lines in `lib.rs`
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

### Usage deletion test (milestone 5)

Done with a script on a throwaway branch from commit `3a8499b` (before the
merge of the Activity kind seam), then deleted. The removal changed 19
files: 969 lines deleted, 5 lines added. Outside the three deleted folders
and the regenerated `app/src/generated/UsageBucket.ts`, `UsageSnapshot.ts`,
`Snapshot.ts`, `Event.ts`, and `index.ts`, these are the only lines that
changed:

| File | Change |
|---|---|
| `crates/tomod/src/addons/mod.rs` | remove `pub mod usage;` and `tokio::spawn(usage::run(daemon.clone()));` |
| `crates/tomod/src/dispatch.rs` | `use crate::addons::{towns, usage};` becomes `use crate::addons::towns;`; remove `usage: usage::snapshots(),` and the `Call::UsageGet` arm |
| `crates/tomo-proto/src/lib.rs` | remove `pub mod usage;`, `pub use addons::usage::*;`, `UsageGet`, `UsageChanged`, the two lines of `Snapshot.usage`, and `UsageSnapshot::export_all` |
| `crates/tomo-cli/src/main.rs` | remove `Cmd::Usage` and its handler (9 lines) |
| `crates/tomo-cli/src/print.rs` | remove `resets_in` and `print::usage` (37 lines) |
| `app/src/addons/index.ts` | remove the `usage` import; `builtins` becomes `[towns]` |
| `scripts/torture/run-all.sh` | remove `usage` from the list |

No Core file changed: not `daemon.rs`, `main.rs`, `store.ts`,
`BottomStrip.tsx`, `Diagnostics.tsx`, or a CSS file.

Result with Usage removed:

| Check | Result |
|---|---|
| `TOMO_WRITE_TYPES=1 cargo test -p tomo-proto` | pass |
| `cargo test --workspace` | pass: 106 tests (tomod 99, tomo-proto 5, tomo_app_lib 2) |
| `npx tsc --noEmit` | exit 0 |
| `npx vitest run` | 29 files, 190 tests pass |
| `npx vite build` | pass |
| `scripts/torture/run-all.sh` without `usage` | PASS: 283 checks in 15 scripts; `agents.sh` 18 of 18 |

The removed build has one compiler warning: the `daemon` parameter of
`addons::start` is not used. It shows a start function that no addon uses.
It is expected.

The first try failed, and the test did its job. That try flattened an
`AddonSnapshot` struct into `Snapshot`. Without usage the struct was empty,
and `ts-rs` stopped with `AddonSnapshot cannot be flattened`. Commit `3a8499b`
turned the split around (`CoreSnapshot` is flattened into `Snapshot`), and
the second try passed. The test was not done again after the merge of the
Activity kind seam; the merge did not change a usage registration line.

### Actions deletion test (milestone 3)

Done with a scratch script on a throwaway worktree from commit `d1b0879`
(milestone 3 merged with milestone 5), then deleted. The script stops when
an edit does not match. Outside the three deleted folders, the removal
deleted 1283 lines and added 7. The count leaves out `docs/` and the
regenerated `app/src/generated/Action*.ts`, `Event.ts`, `Snapshot.ts`, and
`index.ts`. These are the only lines that changed:

| File | Change |
|---|---|
| `crates/tomod/src/addons/mod.rs` | remove `pub mod actions;`; `worktree_files: vec![]` and `pane_exited: vec![]` |
| `crates/tomod/src/dispatch.rs` | `use crate::addons::{actions, towns, usage};` becomes `{towns, usage}`; remove `actions: actions::snapshot(),` and the four `Call::Action*` arms |
| `crates/tomo-proto/src/lib.rs` | remove `pub mod actions;`, `pub use addons::actions::*;`, the four `Call::Action*` variants, `Event::ActionsChanged`, the two lines of `Snapshot.actions`, the three `action.*` names in `HOOK_EVENTS`, the `ActionActivity` and `ActionRunResult` `export_all` lines, and the four `ActionActivity` lines and strings in the kind string test |
| `crates/tomo-cli/src/main.rs` | remove `Cmd::Action`, `enum ActionCmd`, and its four handlers |
| `crates/tomo-cli/src/print.rs` | remove `print::actions` and `print::action_run` |
| `app/src/addons/index.ts` | remove the `actions` import; `builtins` becomes `[towns, usage]` |
| `app/src/addons/activity.ts` | remove the `actionsActivity` import and entry |
| `scripts/torture/run-all.sh` | remove `actions` from the list |
| `app/src/Activity.test.tsx` | deleted; see below |

No Core file changed: not `daemon.rs`, `watch.rs`, `runtime.rs`, `store.rs`,
`store.ts`, `WorktreeHeader.tsx`, `menus.ts`, `Palette.tsx`, or
`attention.ts`. `Pane.source`, `Pane.action_id`, `HookEvent.action`, and
`AttentionKind::Crash` stay, because they are Core.

Result with Actions removed:

| Check | Result |
|---|---|
| `TOMO_WRITE_TYPES=1 cargo test -p tomo-proto` | pass |
| `cargo test --workspace` | pass: 127 tests (tomod 118, tomo-proto 7, tomo_app_lib 2) |
| `npx tsc --noEmit` | exit 0 |
| `npx vitest run` | 30 files, 212 tests pass |
| `npx vite build` | pass |
| `terminal.sh` | 17 passed, 0 failed |
| `agents.sh` | 18 passed, 0 failed |
| `archive.sh` | 17 passed, 0 failed |
| `continuity.sh` | 17 passed, 2 failed, 1 known; see below |

The failures are in tests that exercise Actions on purpose:

- `Activity.test.tsx` renders the row of every addon kind. It imports
  `ActionSet` and expects the Action rows, so it does not compile without
  Actions. The throwaway worktree deleted it. It is a cross-addon test, as a
  composition root is a cross-addon file.
- `continuity.sh` sections 5 and 8 run `tomo action run serve`. Without that
  command, "action reopen" and "restore action" fail, and "action pane
  landed outside the actions tab" becomes a known limitation. The two "does
  not rerun" checks pass without meaning. The other checks pass: tab
  reopen, agent resume, the closed-tab stack, `open_location`, and the
  restart.

The first vitest run had one more failure: the glyph test in
`previews.test.ts` used `action_crashed` as its sample kind. Milestone 3
changed the sample to the core kind `hook_failed`, and the run above
includes that change.

The removed build has two compiler warnings and no errors: the fields of
`PaneExit` are not read, and `Daemon::focus_pane` and `Daemon::stop_pane`
are not used. They show a seam and two Core functions that no addon uses.
They are expected.

## Add a UI contribution

Use an existing slot. Add a new slot only when an extraction needs it. Do not
add a slot "for later". Add the slot to the `Addon` type, then render it at
one site from `builtins`.

Slots that exist (see "Static composition, GUI"): `views`, `commands`,
`inspectorSections`, `worktreeSignals`, `repoAvatar`, `worktreeNameField`,
`mount`, `bottomItem`, `diagnosticsSection`, `topbar`, `worktreeMenu`,
`endpointMenu`, `paletteEntries`, `shortcuts`, `paneSource`, `onSnapshot`,
`onFrame`.

Slots that later milestones will need (from the map):

| Slot | First user | Current hard-coded site |
|---|---|---|
| inspector section | **done**: `inspectorSections` (milestone 2) | none |
| worktree signal | **done**: `worktreeSignals` (milestone 2); runtime is the next user | the runtime signal in `activityModel.ts` `nowSignals` |
| pane renderer | **not built** (milestone 6: the switch is shorter; see "Milestone 6 result: Browser") | `Layout.tsx` keeps the switch |
| browser toolbar item | agentation (milestone 7) | `app/src/browser/BrowserPane.tsx`; see "Agentation boundary for milestone 7" |
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

## Milestone 5 result: Usage

### What moved

| From | To |
|---|---|
| `crates/tomod/src/usage.rs` | `crates/tomod/src/addons/usage/mod.rs` (`git mv`, so the history stays) |
| `UsageBucket`, `UsageSnapshot` in `tomo-proto/src/lib.rs` | `crates/tomo-proto/src/addons/usage.rs` |
| `Inner.usage` | the addon's `static Mutex` (see "Addon state") |
| the `UsageGet` arm in `Daemon::handle` | `usage::get`, called from `dispatch.rs` |
| `usage: inner.usage.clone()` in the `Subscribe` arm | `Daemon::subscribe` returns `CoreSnapshot`; `dispatch.rs` adds `usage::snapshots()` |
| `tokio::spawn(usage::run(..))` in `main.rs` | `addons::start` |
| `UsageStrip`, `UsageMeter`, `UsageBuckets`, `MicroBar` in `shell/BottomStrip.tsx` | `app/src/addons/usage/UsageStrip.tsx`, through `bottomItem` |
| the Usage section in `shell/Diagnostics.tsx` | `UsageDiagnostics`, through `diagnosticsSection` |
| `usageRows`, `stripUsage`, `headlineBucket`, `bucketTone`, `usageTone`, `usageIssues`, `percentText`, `microBar`, `USAGE_WARN`, `USAGE_DANGER` in `shell/bottomModel.ts` | `app/src/addons/usage/model.ts` |
| `State.usage`, the `usage_changed` case, `usage` in `applySnapshot`, `refreshUsage` in `actions.ts` | `app/src/addons/usage/state.ts`, `index.ts`, `UsageStrip.tsx` |
| the usage tests in `shell/bottomModel.test.ts` and `shell/BottomStrip.test.tsx` | `app/src/addons/usage/usage.test.tsx` |

Removed as dead code: `usageSummary` and `percentOf` in `activityModel.ts`.

### Seams

| Seam | Why it is the narrowest option |
|---|---|
| `addons::start(&Arc<Daemon>)` | One call in `main.rs`, after the Core tasks. A field in `Seams` would be a list that Core stores but never calls. |
| `Daemon::subscribe -> CoreSnapshot`, and `Snapshot { core, usage }` in `lib.rs` | Installed clients need one typed JSON object. The composition root builds it, so Core names no addon field. The flattened part is the Core part, because `ts-rs` cannot flatten an empty addon struct. |
| `bottomItem?: ComponentType` | One component for each addon, keyed by the addon id, at the place where `UsageStrip` was. Usage draws all its meters in one component, so a list of items is not necessary. |
| `diagnosticsSection?: ComponentType` | The same shape, at the place of the old Usage section. |
| `onSnapshot(snapshot)` | The existing slot now gets the snapshot, so Usage reads `snapshot.usage`. A `usage_get` call there would start a fetch at each connect, because `usage_get` fetches when the result is empty. |

The poll uses the daemon lock, `Daemon::emit`, and
`Daemon::diagnostic_on_change`, like Towns uses `Inner`. No Core function was
added for Usage.

### Wire and schema changes

- Method names, event names, and JSON field names do not change. The
  `tomo usage` text and `--json` output do not change; `usage.sh` checks both.
- The `subscribe` JSON has the same fields. `usage` is now the last key
  (before, `ui_state` came after it), and the generated `Snapshot.ts` lists
  `usage` first. The clients do not depend on key order.
- Rust: `Snapshot` has `core: CoreSnapshot` and `usage`. Only `tomod` builds it.
- SQLite: no change. Usage has no table.
- CSS: `.bottom-usage` is now `.bottom-items`, with the same rules.

### Coupling that stays

| Coupling | Why it stays |
|---|---|
| `Call::UsageGet`, `Event::UsageChanged`, `Snapshot.usage`, and the re-export in `lib.rs` | composition root |
| `Cmd::Usage` in `crates/tomo-cli/src/main.rs` and `print::usage` | the layout rule keeps one clap tree |
| the `tomo usage` help text names Pi, which is never fetched | user-visible text; not changed in a refactor |
| `.usage-*` and `.micro-bar` rules in `styles/bottom.css` | the cascade order must not change; `.tone-*` is shared with the metrics |
| the addon imports `sparkCells`, `resetsIn` (`activityModel.ts`), `toneOf`, `worstTone` (`shell/bottomModel.ts`), `HoverPopover`, and `KIND_LABEL` | an addon may import Core client code |
| `UsageSnapshot.provider: AgentKind`, `AgentKind::label()` | a provider id is Core identity (milestone 9) |
| `fetch_all` names Claude and Codex | inside the addon; milestone 9 decides about provider modules |
| the thresholds exist in Rust (`THRESHOLDS`) and TypeScript (`USAGE_WARN`, `USAGE_DANGER`) | two languages; [usage.md](usage.md) says to keep them equal |
| `Daemon::handle` answers `subscribe` with only `CoreSnapshot` | Core stays complete without the dispatcher; no caller uses that path |
| the process-wide `static` result | see "Addon state" |

### Small user-visible changes

None expected. The bottom strip has the same DOM, except that the container
class is `.bottom-items`. Nobody looked at the GUI (no GUI allowed); the
render tests cover the meters, the scope rows, the dash, the popover
buckets, the refresh link, and the diagnostics section.

### Tests

| Suite | Milestone 1 | Milestone 5, before the merge | Milestone 5, merged with the Activity kind seam |
|---|---|---|---|
| `cargo test --workspace` | 121 | 122 (tomod 115) | 130 (tomod 121, tomo-proto 7, tomo_app_lib 2) |
| vitest | 29 files, 197 tests | 30 files, 202 tests | 31 files, 218 tests |
| torture harness | 283 checks | 298 checks | 298 checks |

New: `scripts/torture/usage.sh` (15 checks, written and green before the
move), `polls_only_with_a_subscriber_and_a_stale_result`,
`an_addon_does_not_name_another_addon`, the TypeScript test "an addon
imports no other addon folder", and render tests for the scope rows, the
dash, `usage_changed` and the snapshot, the popover and the refresh link,
and the diagnostics section. Removed: the test of the dead `usageSummary`.

### Performance

Measured on 2026-09-15 with the commands in
[addons-baseline.md](addons-baseline.md), release build, data dirs
`/tmp/tomo-addons-usage-*`. The owner used the machine during the runs.
Another agent built in parallel during some of them.

One difference from the baseline: the bench daemon ran with
`TOMO_USAGE_MOCK` pointing at a file with a far `fetched_at_ms`, so that it
did not read the keychain or call the network. The subscribed windows
therefore had no usage fetch. In the baseline, one real fetch (`security`,
`curl`, `codex app-server`) could fall in the first subscribed window.

Round trips (`addons-bench.py ops 3`, median of the trial medians):

| Metric | Baseline | Milestone 5, before the merge | Milestone 5, merged |
|---|---|---|---|
| Reattach | 7.66 ms | 7.83 ms | 7.81 ms |
| of which `subscribe` | 0.51 ms | 0.41 ms | 0.41 ms |
| of which `pane_attach` | 7.14 ms | 7.42 ms | 7.41 ms |
| Worktree switch | 0.14 ms | 0.10 ms | 0.10 ms |
| Worktree switch with attach | 9.26 ms | 7.87 ms | 7.61 ms |
| Refresh | 164.31 ms | 133.87 ms | 124.40 ms |
| Process poll, fresh | 23.41 ms | 20.79 ms | 12.30 ms |
| Process poll, cached | 0.63 ms | 0.53 ms | 0.39 ms |

Idle (`addons-bench.py idle 60`, 3 windows each):

| Metric | Baseline | Before the merge (runs) | Merged (runs) |
|---|---|---|---|
| Idle CPU, no subscriber | 0.13 % | 0.12 % (0.12, 0.13, 0.12) | **0.13 %** (0.12, 0.13, 0.13) |
| Idle CPU, one subscriber | 1.05 % | not measured | **0.77 %** (0.78, 0.77, 0.68) |
| RSS at window end, no subscriber | 14.6 MB | 14.6 MB (14.6, 14.6, 14.6) | **14.5 MB** (14.5, 14.5, 14.5) |
| RSS at window end, subscribed | 14.6 MB | not measured | **14.7 MB** (14.7, 15.1, 13.2) |

The merge came in between the two sets, so the subscribed windows ran only
on the merged tree.

`scripts/perf.sh` (merged tree, 3 runs, median):

| Step | Baseline file | Milestone 1 | Milestone 5 (runs) |
|---|---|---|---|
| socket ready | 8.1 ms | 106.4 ms | 99.1 ms (120.9, 99.1, 9.4) |
| hello (error reply) | 41.7 ms | 46.6 ms | 34.0 ms |
| subscribe | 1.4 ms | 1.8 ms | 0.7 ms |
| worktrees visible after launch | 224.8 ms | 321.3 ms | 214.4 ms |
| summaries done after launch | 437.9 ms | 546.5 ms | 382.9 ms |
| `worktree_refresh` | 175.7 ms | 206.3 ms | 155.1 ms |
| `ps` fresh | 8.7 ms | 10.7 ms | 7.4 ms |
| `ps` cached | 0.3 ms | 0.3 ms | 0.3 ms |
| `worktree_list` | 0.2 ms | 0.2 ms | 0.2 ms |
| idle CPU, 20 s subscribed | 0.5 % | 0.5 % | 0.4 % |
| RSS | 16 MB | 15 MB | 17 MB |

`socket ready` has the same spread as in milestone 1: the third run was
9.4 ms. Milestone 1 found that the base commit gives the same slow first
runs on this machine.

Soak (`scripts/soak/busy.sh 300`, debug daemon, merged tree, 2 runs; no
usage mock, as in the baseline):

| Metric | Baseline | Run 1 | Run 2 |
|---|---|---|---|
| Result | PASS | PASS (22.5 MB at 60 s, 21.9 MB at the end) | PASS (20.7 MB at 60 s, 20.5 MB at the end) |
| tomod RSS min, max, last | 20, 23, 20 MB | 21, 28, 21 MB | 19, 28, 20 MB |
| tomod CPU max | 10.3 % | 9 % | 12 % |
| `tomo ps --json` min..max | 31..90 ms | 27..244 ms | 26..346 ms |
| `tomo worktree list --json` min..max | 26..53 ms | 24..48 ms | 23..318 ms |
| Events | 429 | 426 | 397 |

Gate: pass, with one number at the limit. No round trip is more than 1 ms
and 20 % slower (reattach is 0.15 ms slower). Idle CPU is 0.13 % without and
0.77 % with a subscriber. Idle RSS is below 18 MB. Both soaks pass, but
their maximum RSS is 28 MB, which is the limit and 5 MB above the baseline.
The RSS goes back to 20 MB, so it is a peak, not growth. The cause is not
found: milestone 1 did not run the soak, the soak runs on the tree that
includes the Activity kind seam, and the usage addon adds only one small
`Vec` of snapshots. The CLI peaks in run 2 (346 ms, 318 ms) came while
another agent built; the last samples were 40 ms and 26 ms. Measure the
soak again at the next milestone on a quiet machine. GUI cold launch and GUI
RSS: not measured (no GUI allowed).

## Milestone 2 result: GitHub

### What moved

| From | To |
|---|---|
| `PullRequest`, `PrStatusResult` in `tomo-proto/src/lib.rs` | `crates/tomo-proto/src/addons/github.rs` (the generated names do not change) |
| `crates/tomod/src/github.rs`, the `PrStatus` arm in `Daemon::handle`, `Inner.prs`, the `GitHubActivity::PrMerged` call site | `crates/tomod/src/addons/github/mod.rs` (the `gh` call, the cache, the handler) and `model.rs` (the pure rules) |
| `Call::PrStatus` in the `is_slow` list of `server.rs` | `dispatch::is_slow` |
| `git::github_repo`, `Repo.github`, `GitHubRepo` | removed from Core and the wire; `githubOwner` in `app/src/addons/github/model.ts` |
| the cached pull request and the `pr_merged` fallback in Towns `model::history` | `github::known_pr`, which `dispatch::town_pr` gives to Towns |
| `PrSection` in `RightSidebar.tsx`; `SECTIONS.pr` and the PR marker in `shell/RightRail.tsx`; `"pr"` in `RIGHT_SECTIONS` | `PrSection.tsx` and `prMarker` in `app/src/addons/github/`, through the `inspectorSections` slot |
| the `pr` signal in `activityModel.ts`, `Signals.tsx`, and `shell/LeftRail.tsx` | `prSignals` in `app/src/addons/github/model.ts`, through the `worktreeSignals` slot and the generic `AddonSignal` |
| `State.prs` and the `pr_changed` reducer in `store.ts` | `app/src/addons/github/state.ts` |
| the GitHub avatar URL in `RepoAvatar` (`Sidebar.tsx`) | `app/src/addons/github/Avatar.tsx`, through the `repoAvatar` slot |

### Seams

The daemon got no new `Seams` field. GitHub is pull-based and takes part in
no Core operation.

| Seam | Where | Why it is the narrowest option |
|---|---|---|
| `dispatch::is_slow` | `server.rs` asks it before it runs a call inline | `server.rs` is Core and must not name `Call::PrStatus`. One `matches!` in the composition root keeps the rule that a subprocess call runs in its own task. |
| `towns::history(daemon, slug, pr: fn(&str, &[ActivityEvent]) -> Option<TownPr>)` | `dispatch.rs` passes `town_pr` | Towns needs three facts. A plain function pointer keeps both addons free of each other. Without GitHub, the root passes `\|_, _\| None`. An event, a shared table, or a client join is wider, and the CLI and the harness read `town_history` too. |
| GUI `inspectorSections` | `RightSidebar.tsx` renders them after `git`; `shell/RightRail.tsx` renders the buttons and markers; `store.ts` gives the ids to `sanitizeUi` | The section had one fixed place after `git`. One insertion point keeps that order without a position field. |
| GUI `worktreeSignals` | `signalsFor` in `Signals.tsx` gives them to `nowSignals` as `addon` | The PR signal came last. Addon signals keep that place, and the cap of three stays in one function. The signal is data (`AddonSignal`), so the left rail can print it as text. |
| GUI `repoAvatar` | `RepoAvatar` in `Sidebar.tsx`, which the sidebar and Home render | The avatar was the only reader of `Repo.github`. One component slot, where the first addon wins, like `worktreeNameField`. |

### Client state decision

The rail marker and the NOW signals are selectors that core components run
through `useStore`. A private store like the one of Towns would not make
those components render again. So `app/src/addons/github/state.ts` declares
the optional key `prs` on the core `State` through TypeScript module
augmentation, and it is the only writer. Core never names the key. If the
GitHub folder is deleted, the key goes away from the type.

Rejected options:

- Hooks as slots. Core would call addon hooks in a loop over `builtins`.
- A second subscription inside `useStore`. Its selector cache keys on the
  core state object, so an addon change alone would not show.

### Daemon state decision

The cache is a process-wide `static Mutex` in the addon, like the Usage
result. The lock order is `Daemon::lock` first, then the cache.
`pr_status` never takes the Core lock while it holds the cache lock.

Rejected options:

- A generic addon state field on `Daemon`. That is a service locator.
- The `kv` table. It would change the behavior after a restart and add a
  write for each answer.

### Background rule

Unchanged. The daemon has no GitHub poller. `gh` runs only inside a
`pr_status` call without a cached pull request younger than 60 s. The
inspector section asks when it mounts, every 120 s while it is open, and on
refresh. `tomo pr` asks once. The rail marker, the NOW signals, and the town
history read the cache only. `scripts/torture/github.sh` checks the cache
with a call counter in the fake `gh`, and `github.test.tsx` checks the
120 s poll and its stop on unmount.

### Wire and schema changes

- **Changed:** `Repo.github` and `GitHubRepo` are removed (commit `4904e59`).
  The generated `GitHubRepo.ts` is deleted. `Repo.remote_url` stays. The
  only consumer, the GUI repo avatar, changed in the same commit. The
  installed CLI never read the field. An installed GUI older than this
  change shows no repo avatar against a newer daemon; nothing fails. A newer
  GUI against an older daemon works, because it reads `remote_url`.
- **Unchanged:** `pr_status`, `pr_changed`, `PullRequest`, `PrStatusResult`,
  `town_history`, `TownPr`, every method and event name, and every other
  snapshot field.
- **SQLite:** no change.
- **Client UI state:** a saved `rightSection: "pr"` stays valid while GitHub
  is built in. Without GitHub, `sanitizeUi` drops it.

### GitHub deletion test (milestone 2)

Done with `remove_github.py`, a script of exact replacements, on a throwaway
branch from the merge commit `4c50df1`, then deleted. The removal changed 23
files: 637 lines deleted, 10 lines added. Outside the three deleted folders
and the regenerated `GitHubActivity.ts`, `PrStatusResult.ts`,
`PullRequest.ts`, `Event.ts`, and `index.ts`, these are the only lines that
changed:

| File | Change |
|---|---|
| `crates/tomod/src/addons/mod.rs` | remove `pub mod github;` |
| `crates/tomod/src/dispatch.rs` | `use crate::addons::{github, towns, usage};` becomes `use crate::addons::{towns, usage};`; `ActivityEvent` and `TownPr` leave the `tomo_proto` import; `is_slow` returns `false` and its parameter becomes `_call`; the `TownHistory` arm passes `\|_, _\| None`; remove the `PrStatus` arm and `fn town_pr` |
| `crates/tomo-proto/src/lib.rs` | remove `pub mod github;`, `pub use addons::github::*;`, `Call::PrStatus`, `Event::PrChanged`, the `PrStatusResult` and `GitHubActivity` `export_all` lines, and `GitHubActivity::PrMerged` with `"pr_merged"` in the test `addon_kinds_keep_their_stored_strings` |
| `crates/tomo-cli/src/main.rs` | remove `Cmd::Pr` and its handler (7 lines) |
| `crates/tomo-cli/src/print.rs` | remove `print::pr` (16 lines) |
| `app/src/addons/index.ts` | remove the `github` import; `builtins` becomes `[towns, usage]` |
| `app/src/addons/activity.ts` | remove the `githubActivity` import and its entry |
| `scripts/torture/run-all.sh` | remove `github` from the list |

The `github` entry of `OWNED_NOUNS` can stay. It is a test list, and it
keeps GitHub nouns out of Core after the removal too.

Result with GitHub removed:

| Check | Result |
|---|---|
| `TOMO_WRITE_TYPES=1 cargo test -p tomo-proto` | pass |
| `cargo test --workspace` | pass: 127 tests (tomod 118, tomo-proto 7, tomo_app_lib 2); no new compiler warning |
| `npx tsc --noEmit` | exit 0 |
| `npx vite build` | pass |
| `npx vitest run` | 31 files, 220 tests pass |
| `scripts/torture/archive.sh` | 17 passed, 0 failed |
| `scripts/torture/terminal.sh` | 17 passed, 0 failed |
| `scripts/torture/towns.sh` (town history without a pull request) | 11 passed, 0 failed |

The first try, from commit `53e9b79` before the merge of Usage, found one
failure, and the test did its job. The core test `Activity.test.tsx`
asserted the GitHub view of a `pr_merged` row. Without the addon that row
renders as a plain row by design. Commit `ef95913` moved the case into
`github.test.tsx`. The second try above passed.

`tomo pr` goes away with the addon. The `.pr-*` and `.check-*` CSS
selectors stay as dead selectors.

### Coupling that stays

| Coupling | Why it stays |
|---|---|
| `Call::PrStatus`, `Event::PrChanged`, and the re-export in `tomo-proto/src/lib.rs` | composition root; the typed wire needs the variants |
| `tomo pr` in `crates/tomo-cli/src/main.rs` and `print::pr` | one clap tree; they are listed deletion lines |
| `dispatch::is_slow` and `dispatch::town_pr` | composition root |
| `.pr-open`, `.pr-merged`, `.pr-closed`, `.check-passed`, `.check-failed` in `styles/base.css`, and `.pr-title` in `styles/layout.css` | they share rule lists with the core `.state-*` classes; a move could change the cascade |
| `TownHistory.pr` and `TownPr` | the Towns wire type; the field is `null` without GitHub |
| the `prs` key on the client `State` | declared by the addon; see "Client state decision" |
| the placeholder `git@github.com:org/repo.git` in the clone dialog | example text for any Git remote |

### Problems found in milestone 2 (not fixed)

1. An archive, a move, or a restore at a new path does not clear or move
   the cache entry. After a rebind, the new id starts without a cache, so a
   merged pull request can record `pr_merged` again. `worktree_rebound`
   could move the entry. This milestone keeps the behavior.
2. After a daemon restart, the next merged answer records `pr_merged` again.
   `github.sh` reports it as a known limitation.
3. `pr_changed` fires on each new fetch of an open pull request, because
   `fetched_at_ms` is part of the equality. An open inspector gets one extra
   store update every 120 s. It does no harm.

### Tests

| Suite | Before milestone 2 | Milestone 2 (before the merge) | After the merge of Usage |
|---|---|---|---|
| `cargo test --workspace` | 128 | 131 (tomod 122, tomo-proto 7, tomo_app_lib 2) | 133 (tomod 124, tomo-proto 7, tomo_app_lib 2) |
| vitest | 30 files, 212 tests | 31 files, 226 tests | 32 files, 232 tests |
| torture harness | 283 checks in 15 scripts | 302 checks in 16 scripts, 1 known | 317 checks in 17 scripts, 1 known |

New tests: 6 in `crates/tomod/src/addons/github/model.rs`; 12 in
`app/src/addons/github/github.test.tsx` (10 characterization tests written
before the move); 1 addon section case in `uiState.test.ts`; the GitHub noun
test in `boundary.test.ts`; `scripts/torture/github.sh` (19 checks and 1
known). Tests that moved: `github.rs::parses_checks_from_both_rollup_shapes`
to `model.rs`; `towns::model::a_cached_pull_request_wins_over_the_merge_event`
to `a_cached_pull_request_wins_over_the_newest_merge_event` in `model.rs`;
`git.rs::parses_github_remotes` to the owner test in `github.test.tsx`; the
`pr_merged` case of `Activity.test.tsx` and the PR case of
`activity.test.ts` to `github.test.tsx` and a generic addon signal case. No
test was removed without a replacement.

### Performance

Measured on 2026-09-15 with `addons-bench.py` on the merge commit `4c50df1`
(GitHub and Usage), release build, data dir `/tmp/tomo-addons-github-bench`.
Another agent built in parallel during the session, and the owner used the
machine. The bench does not call `pr_status`. So the numbers show the code
paths that always run: discovery without the GitHub parse, `subscribe`, and
the dispatcher.

Round trips (`addons-bench.py ops 3`, median of the trial medians):

| Metric | Baseline | Activity kind seam | Milestone 2, after the merge |
|---|---|---|---|
| Reattach | 7.66 ms | 7.48 ms | 7.90 ms |
| of which `subscribe` | 0.51 ms | 0.46 ms | 0.38 ms |
| of which `pane_attach` | 7.14 ms | 6.97 ms | 7.51 ms |
| Worktree switch | 0.14 ms | 0.13 ms | 0.08 ms |
| Worktree switch with attach | 9.26 ms | 7.90 ms | 7.15 ms |
| Refresh | 164.31 ms | 166.34 ms | 124.88 ms (trials 112.74, 128.82, 124.88) |
| Process poll, fresh | 23.41 ms | 13.45 ms | 19.12 ms |
| Process poll, cached | 0.63 ms | 0.30 ms | 0.49 ms |

Idle (`addons-bench.py idle 60`, 3 windows each):

| Metric | Baseline | Activity kind seam | Milestone 2, after the merge |
|---|---|---|---|
| Idle CPU, no subscriber | 0.13 % | 0.10 % | 0.12 % (0.12, 0.17, 0.08) |
| Idle CPU, one subscriber | 1.05 % | 0.75 % | 0.83 % (0.83, 0.75, 0.90) |
| RSS at window end, no subscriber | 14.6 MB | 14.8 MB | 12.1 MB (14.0, 12.0, 12.1) |
| RSS at window end, subscribed | 14.6 MB | 14.6 MB | 12.8 MB (12.0, 12.8, 13.3) |

The first three windows without a subscriber ran directly after `setup` and
`ops`. They gave 0.10, 0.13, and 0.13 % CPU, but the RSS stayed at 35.3 MB.
The memory came back during the subscribed windows, which started at
14.9 MB. The no-subscriber rows above are a second set of three windows,
after the memory settled. The baseline saw the same effect: its first window
started at 31.2 MB.

Gate: pass. The largest increase is `pane_attach`, 0.37 ms above the
baseline, which is less than 1 ms. Idle CPU and RSS are below the limits.
The main JS chunk is 720.79 kB after the merge (720.40 kB before), below the
800 KB budget. Not measured: GUI cold launch and GUI RSS (no GUI allowed).
Not run: `scripts/perf.sh` and the soak.

### Stop conditions

None was hit. Near: TypeScript module augmentation is a feature that some
readers do not expect. `state.ts` and this section explain it. The slot code
(three `Addon` fields, three helper lines, `AddonSignal`, and
`railSections`) is about the size of the PR code that left the core client
files.

## Milestone 3 result: Actions

### What moved

| From | To |
|---|---|
| `crates/tomod/src/features/actions.rs` | `crates/tomod/src/addons/actions/model.rs` (`git mv`) |
| `ActionMode`, `ActionShow`, `ActionDef`, `ActionSet`, `ActionRunResult` in `tomo-proto/src/lib.rs` | `crates/tomo-proto/src/addons/actions.rs` |
| `Inner.actions`, `reload_actions`, `action_def`, `running_action_pane`, `queue_action_event`, `record_action`, `action_or_placeholder`, `run_action`, `stop_action`, `action_crashed`, and the four action arms in `daemon.rs` | `crates/tomod/src/addons/actions/mod.rs`, through `dispatch.rs`, `worktree_files`, and `pane_exited` |
| the action branch in `on_exit` | `actions::exited`, the `pane_exited` seam |
| the `.tomo.toml` check in `watch.rs` | the `worktree_files` names |
| `actions` in the Core snapshot | `Snapshot.actions`, filled from `actions::snapshot()` in `dispatch.rs` |
| `PaneRow.action_id` and the `panes.action_id` reads and writes | `PaneState.source`, in memory; `Pane.action_id` is derived |
| the `RuntimeEndpoint.label` lookup in `inner.actions` | the source label |
| `ActionBar`, `EndpointMark`, `ActionWarning` in `WorktreeHeader.tsx` | `app/src/addons/actions/Topbar.tsx`, through `topbar` |
| `runningActionItems`, `actionItem`, and the restart and stop items of `endpointMenu` in `menus.ts` | `app/src/addons/actions/commands.ts`, through `worktreeMenu` and `endpointMenu` |
| `actionEntries` in `Palette.tsx` | `paletteEntries` |
| `runWorktreeAction`, `stopWorktreeAction`, `restartWorktreeAction`, and the `action:` prefix in `actions.ts`; `activeActionSet`, `runningActionIds`, `liveEndpointFor`, and the Action part of `keyBindings` in `store.ts` | `commands.ts`, through `shortcuts` |
| `State.actions`, the `actions_changed` case, and `actions` in `applySnapshot` | `app/src/addons/actions/state.ts`, `onSnapshot`, `onFrame` |
| the Action name and Restart of the crash toast in `attention.ts` | the pane source and the `paneSource` slot |
| the running action tests in `menus.test.ts` | `app/src/addons/actions/actions.test.tsx` |

### The pane source

This is the Core provenance field that Runtime uses in milestone 4:

```rust
pub struct PaneSource { pub kind: String, pub id: String, pub label: String }
// PaneState.source: Option<PaneSource>; Pane.source on the wire
```

- **Who sets it.** The spawner, directly after `spawn_in_worktree`. Actions sets `{ kind: "action", id, label }`.
- **What Core does with it.** Core keeps it in memory, sends it in `Pane.source`, and gives it to `pane_exited`. Core never reads `kind`.
- **Restore.** It is not stored, so a restored or reopened pane has no source. That is the behavior from before the split: restore removed the Action link, and reopen dropped it. So no restore seam is necessary.
- **Why this shape is the narrowest.** Each reader needs one field. The owner needs `kind` to find its own panes (stop, restart, and crash rules) without a Core enum of addon names. The owner needs `id` as its key. A reader that is not the owner needs `label` to name the pane (endpoint labels, the crash toast, the Agentation runtime line) without an import of the owner. A generic JSON payload was rejected, because three typed strings are all that the readers need. A `PaneSourceKind` enum in Core was rejected, because Core would name every addon.
- **Compatibility.** `Pane.action_id` stays on the wire. `pane_view` derives it with `PaneSource::action_id`, which is next to the type in `lib.rs` with the constant `ACTION_SOURCE_KIND`. Installed GUIs and CLIs still get the field. `RuntimeEndpoint.action_id` uses the same helper.
- **How Runtime uses it.** `runtime::observe` reads `inner.panes[pane_id].source`. The `label` becomes `RuntimeEndpoint.label`. `PaneSource::action_id` fills `RuntimeEndpoint.action_id` and the `action` field of the runtime hooks. The Runtime addon must read only `PaneSource` and must not import the Actions addon. If it must show the owner of a source that is not an Action, it can add `RuntimeEndpoint.source` and keep `action_id` as a derived field.

### Seams

Daemon: `worktree_files` and `pane_exited` (see "Seams"). These options were rejected:

- A `snapshot` seam. The first version had one. The merge of milestone 5 made `dispatch.rs` fill each addon field of `Snapshot`, so Actions uses that path, and the seam was removed.
- A restore seam. The source is in memory only, so restore has nothing to remove.
- The milestone 0 plan of a discovery seam plus a watcher classifier. One `worktree_files` list gives the file name and the reload to both.

Core additions: `PaneSource` and `ACTION_SOURCE_KIND` in `lib.rs`, `PaneState.source`, `Daemon::stop_pane`, and crate-wide `focus_pane` and `push_attention`.

GUI: `topbar` (`buttons`, `marks`), `worktreeMenu`, `endpointMenu`, `paletteEntries`, `shortcuts`, and `paneSource`. Each slot replaces one hard-coded Action site and renders at one place. Six slots are more than Towns or Usage needed, but each is one optional field and one `flatMap`. One "Action contribution" object was rejected, because it would put an Actions-shaped API into the client core.

### Decisions

- **`AttentionKind::Crash` is Core.** It is the attention word for "a process that a pane source started exited, and Tomo did not stop it". The owner of the source decides when to raise it. Only Actions raises it, so a shell or an agent that exits with a non-zero code raises nothing, as before. The Rust characterization test checks a shell that exits with code 1. A Core rule "every owned process that exits with a non-zero code is a crash" was rejected, because it adds crash items for ordinary shells.
- **A closed Action pane records nothing.** `pane close`, `tab close`, and archive remove the pane before its process exits, so `on_exit` finds no pane: no `action_stopped` and no `action.exited`. This was problem 3 of milestone 0. The code does not change. A fix is not one line: three Core paths would have to record before `remove_pane`, and Core would have to know the owner of the source. `docs/actions.md` and `docs/activity.md` describe the behavior, and the Rust test pins it.
- **The sets stay in a `static`.** See "Addon state".
- **`HookAction` stays in Core.** The runtime hooks also fill `HookEvent.action`. The first version moved the type to the Actions proto module; the deletion test plan showed that Core `runtime.rs` would not compile without the addon, so it went back to `lib.rs`.
- **The `panes.action_id` column.** No code reads or writes it. An old database keeps it; a new database does not get it, as with `worktree_meta.town_slug`. An older daemon on a new database adds the column again with its own migration.

### Wire and schema changes

- New: `Pane.source` (`PaneSource | null`) and the generated `PaneSource.ts`.
- Unchanged: every method, event, and field name, also `Pane.action_id`, `Snapshot.actions`, `RuntimeEndpoint.action_id`, and `HookEvent.action`. `actions` is now the last key of the `subscribe` JSON; the clients do not depend on key order.
- SQLite: no table or column is dropped. No code reads or writes `panes.action_id`.

### Coupling that stays

| Coupling | Why it stays |
|---|---|
| `Call::Action*`, `Event::ActionsChanged`, `Snapshot.actions`, the `action.*` names in `HOOK_EVENTS`, and the re-export in `lib.rs` | composition root |
| `Pane.action_id`, `PaneSource::action_id`, and `ACTION_SOURCE_KIND` in `lib.rs` | compatibility with installed clients; remove them when no client reads `Pane.action_id` |
| `HookEvent.action` and `HookAction` | the hook envelope; runtime events fill it too |
| `AttentionKind::Crash`, and the fallback title "Action crashed" in `notifyRoute.ts` | a Core attention kind (see "Decisions"); user-visible copy |
| `RuntimeEndpoint.action_id`, and `!e.action_id` in `overflowMenu` (the endpoints that no Action owns) | Runtime client code; milestone 4 |
| `EvidenceBundle.action_id` and the runtime line of `AnnotationsSend` | Agentation; the line now reads the pane source |
| `tomo action` in `crates/tomo-cli` | the layout rule keeps one clap tree |
| `.actionbar`, `.action-btn`, `.action-live`, `.action-warn` in `styles/layout.css` | `.actionbar` and `.action-btn` also style the editor button; a move could change the cascade |
| the addon reads the core client `State.endpoints` and `RuntimeEndpoint.action_id` | Runtime is still client core |
| the Action sections of `continuity.sh`, `runtime.sh`, and `activity.sh`, and `Activity.test.tsx` | cross-feature tests; see "Actions deletion test" |

### Small user-visible changes

- The label of a running endpoint comes from the pane source, which holds the Action label at run time. Before, the label came from the current `.tomo.toml`. The two differ only when the label changes while the Action runs.
- The Agentation runtime line names an Action only while its pane runs. The GUI always sends `action_id: null`, so no user sees this path.
- An `endpoint_discovered` Activity row takes its name from the pane source. When the pane is gone, the row shows the payload `action_id`, not the label.
- "open" and "copy" in the submenu of a running Action load `actions.ts` lazily, one microtask later.

### Tests

| Suite | Before milestone 3 (master `5360fab`) | Milestone 3 on `5360fab` | Milestone 3 merged with milestone 2 (`b769d5d`) |
|---|---|---|---|
| `cargo test --workspace` | 130 | 131 (tomod 122) | 134 (tomod 125, tomo-proto 7, tomo_app_lib 2) |
| vitest | 31 files, 218 tests | 32 files, 227 tests | 33 files, 241 tests |
| torture harness | 298 checks in 16 scripts | 299 checks (`actions.sh` 24 → 25) | 318 checks in 17 scripts, 1 known (in `github.sh`) |

The characterization tests came first (commit `978d462`) and passed on the
code before the move:

- `actions_characterization` in `addons/actions/tests.rs` runs a real daemon
  with PTYs, Git, and hook scripts through `dispatch::handle`. It checks
  the list and its defaults, the snapshot, a run with its source, the reuse
  of a live pane, stop, restart, a crash (attention item, activity, and
  `action.crashed`), an exit with 0, an external run, an unknown id, a pane
  close that records nothing, a shell exit that is no crash, and a restore
  that does not run the command again.
- `app/src/addons/actions/actions.test.tsx` renders the topbar (order, dot,
  warning), a click and a right click, the snapshot, the overflow menu, the
  endpoint menu, the running Action submenu, the palette entries, the
  shortcut binding, the shortcut reference, and the crash toast with Restart.

Also new: the `source` check in `actions.sh`, the Action nouns in
`OWNED_NOUNS`, and the TypeScript Action noun test. Moved: the 3 parser
tests (with `model.rs`) and the 2 running Action menu tests from
`menus.test.ts` (now 1 test). Changed: the store activity test and the glyph
test use core kinds, so that they do not name Actions. No test was removed.

### Performance

Measured on 2026-09-15 with the commands in
[addons-baseline.md](addons-baseline.md), release build, data dir
`/tmp/tomo-addons-actions-bench`, on commit `d1b0879` (milestone 3 merged with
milestone 5, before the merge of milestone 2). The merge of milestone 2
changed no Action code path. As in milestone 5, `TOMO_USAGE_MOCK` pointed at
a file with a far `fetched_at_ms`, so no window called the network. Other
agents built in parallel, and the owner used the machine.

Round trips (`addons-bench.py ops 3`, median of the trial medians):

| Metric | Baseline | Milestone 5, merged | Milestone 3 |
|---|---|---|---|
| Reattach | 7.66 ms | 7.81 ms | 7.76 ms |
| of which `subscribe` | 0.51 ms | 0.41 ms | 0.39 ms |
| of which `pane_attach` | 7.14 ms | 7.41 ms | 7.40 ms |
| Worktree switch | 0.14 ms | 0.10 ms | 0.08 ms |
| Worktree switch with attach | 9.26 ms | 7.61 ms | 7.53 ms |
| Refresh | 164.31 ms | 124.40 ms | 128.08 ms (trials 162.84, 128.08, 123.84) |
| Process poll, fresh | 23.41 ms | 12.30 ms | 19.00 ms |
| Process poll, cached | 0.63 ms | 0.39 ms | 0.55 ms |

Idle (`addons-bench.py idle 60`, 3 windows each):

| Metric | Baseline | Milestone 5, merged | Milestone 3 (runs) |
|---|---|---|---|
| Idle CPU, no subscriber | 0.13 % | 0.13 % | **0.12 %** (0.12, 0.13, 0.12) |
| Idle CPU, one subscriber | 1.05 % | 0.77 % | **1.00 %** (1.00, 0.92, 1.03) |
| RSS at window end, no subscriber | 14.6 MB | 14.5 MB | **11.9 MB** (39.6, 10.3, 11.9) |
| RSS at window end, subscribed | 14.6 MB | 14.7 MB | **13.3 MB** (13.0, 13.4, 13.3) |

The first idle window started directly after the `ops` run, as in the
baseline, and the memory went back in the next window. The subscribed CPU
is higher than in milestone 5 and lower than the baseline. The change adds
no timer and no work on a monitor tick: the reload runs only at a discovery
and at a watcher change, as before. The fresh process poll is between the
baseline and milestone 5, and the change does not touch the poll.

Gate: pass. No round trip is more than 1 ms and 20 % slower than the
baseline (reattach is 0.10 ms slower). Idle CPU is 0.12 % without and 1.00 %
with a subscriber. Idle RSS is below 18 MB. The main JS chunk is 721.44 kB
after both merges (720.03 kB at the GUI commit), below the 800 KB budget.
Not measured: GUI cold launch and GUI RSS (no GUI allowed). Not run:
`scripts/perf.sh` and the soak.

### Stop conditions

None was hit. Near:

- Six GUI slots. The move removed 192 lines from core client files and added
  60; the slot types added 28 lines. So the slot code is smaller than the
  Action code that left the client core.
- Process-wide daemon state (`static`), as in Usage and GitHub. The cost is
  one Rust characterization test for three scenarios.
- An addon module that `addons/index.ts` loads cannot import `actions.ts` at
  module start. Two menu items use a lazy import. See "Module load".

## Milestone 6 result: Browser

### Decision

**Browser stays a built-in pane kind. It is not an addon.** Its code moved
into three browser modules, and the closed `PaneKind` and the `Layout.tsx`
switch stay. The PRD says to abstract Browser only if that makes the code
simpler. The count below shows that an extraction adds more parts than it
removes.

Why Browser is Core and Core client, not an opinion:

- A pane that has no PTY is a Core fact. `start_pty`, `pane_view.live`,
  `terminal_only`, restore, and reopen must know it. Tabs, pane layout, and
  layout persistence are Core, and the PRD does not move them.
- The page is Client work: the Tauri host owns the child webviews, and the
  main window is a child webview only because of Browser.
- The opinion is Agentation. It annotates a page and sends it to an agent.
  With Browser in the Core client, Agentation depends on Core like every
  other addon, and needs no addon-to-addon exception.

### Question 1: a pane renderer registry

A registry maps a pane kind id to a client renderer. Count of the change:

| Side | Registry | Closed switch (kept) |
|---|---|---|
| `Layout.tsx` | a lookup in `builtins`, and a fallback for an unknown kind | 1 line: `kind === "browser"` |
| `Addon` type and `addons/index.ts` | a `paneRenderers` field and a helper (about 5 lines) | none |
| Type safety | `Pane.kind` must become a string so that Core names no addon; 4 GUI checks (`Layout.tsx`, `Tabs.tsx`, `commands/discovery.ts`, `browser/browser.ts`) and 12 Rust `PaneKind` matches in 4 files lose the compiler check | `"terminal" \| "browser"`, generated from the Rust enum |
| Module load | `BrowserPane.tsx` imports `actions.ts` and `menus.ts`. A module that `addons/index.ts` loads must not do that (see "Module load"), so the pane must load lazily. That changes when `browser_create` runs, and nobody can see the result without a window. | no change |
| Pane persistence and restore | `panes.kind` is already `TEXT`; the read must keep an unknown string | no change |
| Layout validation | none; `layout.rs` does not read the kind | none |
| Reopen (`tab_reopen` restores the URL) | `ClosedPane::Browser` becomes a generic `ClosedPane::Surface { kind, url }` and a generic `create_surface_pane`, or a new reopen seam | no change |
| Drag and drop, pane zoom | none; `LayoutDnd.tsx` and `zoomed` do not read the kind | none |
| App zoom | none; `boundsOf` in the pane scales by `appearance.zoom` | none |

The registry alone does not make Browser removable: the tab preview, the four
commands, the spawn menu, the browser menu, the File menu, and the command
group still name Browser. The addons.md rule from milestone 0 was: "Change
the switch to a renderer map only if the map is shorter than the switch."
It is not shorter. **Result: keep the switch.**

### Question 2: can Browser be deleted believably?

Only after these changes:

1. Proto: `PaneKind` becomes a string newtype (the `ActivityKind` pattern),
   and `Pane.url` stays as a generic surface address. An addon payload on
   `Pane` would be generic JSON, which the laws forbid.
2. Daemon: the three kind checks in `daemon.rs` become "not a terminal".
   Reopen gets a generic surface record. The addon gets `browser_open` and
   `browser_navigate` through `dispatch.rs`, and Core makes `place_pane` and a
   URL setter public to the crate.
3. GUI: new slots for the pane renderer, the spawn menu items (two places),
   the File menu item, and "open a URL in Tomo". The four commands move
   after the core actions in the palette and the shortcut reference, which
   the user sees.
4. Tauri host: it is one crate. The eight webview commands, `build.rs`, the
   `default.json` permissions, and `open_main_window` stay, or the deletion
   edits four host files.
5. Agentation: an "Allowed addon dependencies" row, and a toolbar slot that
   one addon offers to another. No mechanism for that exists.

What Core would still keep: a pane kind string with "no PTY" meaning, the
`url` field and column, a generic surface create and reopen, and the host
window layout. So the deletion removes the view and two calls, and leaves
the rest of Browser in Core under generic names. That is the stop condition
"addon framework code exceeds feature simplification". **Result: not
extracted. No deletion test was run, because nothing was extracted.**

### Question 3: open a URL in Tomo

Eight call sites in six files open a URL in the worktree browser: terminal Cmd-click
(`terminalHooks.ts`), the checkpoint banner and the runtime popover
(`WorktreeHeader.tsx`), the Activity "Open App" link, the palette endpoint
entry, two runtime menu items (`menus.ts`), and the running Action submenu
(`addons/actions/commands.ts`). They all call `openEndpoint(url,
worktreeId?)` in `actions.ts`.

| Option | Moving parts | Verdict |
|---|---|---|
| A typed command in the registry | `Action.run` takes no arguments; a URL argument changes the type of every command for one kind of caller | rejected |
| A small Core client capability, with the system browser as the fallback when no Browser addon exists | one slot ("the first addon wins") and one fallback line | the right option **if** Browser ever becomes an addon; `openEndpoint` is already the one entry point, so only its body changes |
| Browser is a built-in client capability | none: `openEndpoint` calls `openInBrowser` directly | **chosen**, fewest moving parts |

`openEndpoint` without a worktree already opens the system browser.

### What moved

| From | To |
|---|---|
| `create_browser_pane` and the `BrowserOpen` and `BrowserNavigate` arms in `daemon.rs` | `crates/tomod/src/features/browser.rs` (`create_browser_pane`, `browser_open`, `browser_navigate`); the arms call them |
| `app/src/BrowserPane.tsx` | `app/src/browser/BrowserPane.tsx` (`git mv`, imports changed only) |
| `normalizeUrl` in `BrowserPane.tsx`; `openBrowser`, `openInBrowser`, `browserHostFailed`, `browserCommand` in `actions.ts` | `app/src/browser/browser.ts` |
| the `.browser-*` rules at the end of `styles/terminal.css` | `app/src/browser/browser.css`, imported directly after `terminal.css`, so the cascade order does not change (the built CSS is 61.46 kB, as before) |
| the eight child webview commands and their helpers in `app/src-tauri/src/lib.rs` | `app/src-tauri/src/browser.rs`; the command names do not change, so `build.rs` and the capabilities do not change |

What did not move, and why:

- `browserMenu` stays in `menus.ts`. It uses the private helpers of that file
  (`paneContext`, `copyMenu`, `sendToItem`), like `paneMenu`.
- The four commands stay in `commands/discovery.ts`. The registry loads
  `commands/*.ts` by file name, so a `commands/browser.ts` file would change
  the command order.
- `openEndpoint` stays in `actions.ts`, because seven callers import it.
- `PaneKind`, `Pane.url`, `Call::BrowserOpen`, `Call::BrowserNavigate`, the
  `panes.kind` and `panes.url` columns, `ClosedPane::Browser`, and
  `tomo browser open` stay. They are the Core part of the pane kind.
- The Agentation parts stay where they are. Milestone 7 moves them.

Seams: none. Slots: none. Wire, schema, and CLI: no change. The bindings did
not change. Behavior: no change is intended; the pane code and its bounds
logic (the frame loop and the zoom scale) are the same lines.

The new module `features/browser.rs` makes `Daemon::place_pane` public to
the crate. Browser code in `app/src/browser/browser.ts` imports `actions.ts`
(`focusPane`, `openWorktree`), and `actions.ts` imports `openInBrowser`. The
cycle runs nothing at module load, like the existing cycle between
`actions.ts` and `commands/*.ts`.

### Agentation boundary for milestone 7

Today every piece below is inside Browser or Core. After milestone 7,
Agentation must depend on Browser, and Browser must not name Agentation.

**GUI, `app/src/browser/BrowserPane.tsx`:**

- imports only for Agentation: `Copy`, `MessageSquarePlus`, `SendHorizontal`, `DropdownMenu*`, `MenuItems`, `MenuItem`, `copyText`, `agentsOf`, `failToast`, `showStatus`, `KIND_LABEL`, `EvidenceBundle`, and `rpc` (only for `annotations_send`)
- `Feedback`, `FeedbackEvent`, `INSTRUCTION`, `NO_FEEDBACK`, `notes`
- the state `annotate`, `feedback`, `menuOpen`, and the `agents` selector
- the `browser://feedback` listener in the mount effect
- `setFeedback(NO_FEEDBACK)` in the `browser://state` listener (a new URL resets the count)
- `sendOpen` in the `browser_set_visible` effect (the send menu hides the webview)
- the `browser_set_annotate` effect
- `send` (the `annotations_send` call and `browser_clear_annotations`), `copyFeedback`, `sendItems`
- the toolbar part after the URL field: Annotate, the count, Copy feedback, the Send menu
- CSS in `app/src/browser/browser.css`: `.browser-annotate-on`, `.browser-count`, and `.browser-count` in the 359 px container rule

**Tauri host:**

- `lib.rs`: `AGENTATION_JS`, `AnnotatePanes` and its `manage`, `agentation_script`, `browser_set_annotate`, `browser_clear_annotations`, `feedback_pane`, `browser_feedback`, their three handler entries, and the two tests
- `browser.rs`: `use crate::{agentation_script, AnnotatePanes}`, the re-injection in `on_page_load` of `browser_create`, and the flag removal in `browser_close`
- `build.rs`: `browser_set_annotate`, `browser_clear_annotations`, `browser_feedback`
- `capabilities/default.json`: `allow-browser-set-annotate`, `allow-browser-clear-annotations`; `capabilities/browser.json` (the whole file: remote pages may call `browser_feedback`)
- `app/src-tauri/agentation/agentation.js`, and its build: `app/agentation/`, `vite.agentation.config.ts`, the `build:agentation` script and the `agentation` dependency in `package.json`

**Daemon, `crates/tomod/src/daemon.rs`:** the `Call::AnnotationsSend` arm (the live agent check, the PTY write with `pasted`, the runtime line from the pane source, the `AgentationActivity::AnnotationsSent` event, the `annotation.sent` hook), `evidence_text`, `evidence_title`, and the tests `evidence_text_lists_annotations_in_order` and `evidence_text_uses_the_markdown_body`. `pasted` is generic and stays.

**Proto, `crates/tomo-proto/src/lib.rs`:** `Call::AnnotationsSend` and `"annotation.sent"` in `HOOK_EVENTS` (they stay in the composition root); `Annotation` and `EvidenceBundle` (they move to `addons/agentation.rs`, next to `AgentationActivity`); the `EvidenceBundle` `export_all` line.

**Other:** `app/src/addons/agentation/activity.ts` exists already. `scripts/torture/browser.sh` section 5 is Agentation. `docs/browser.md` "Feedback overlay" and "Evidence bundle" go to an Agentation doc.

The contribution hooks that Browser must offer, and nothing more:

| Hook | Where Browser calls it | Shape |
|---|---|---|
| browser toolbar slot | `BrowserPane.tsx`, after the URL field and before open-external, in `builtins` order | `browserToolbar?: ComponentType<{ paneId: Id; worktreeId: Id; url: string; setCovering: (covering: boolean) => void }>`. The pane hides the webview while `covered` or any item is covering. The item resets its own count when `url` changes. |
| page-load hook | `browser::browser_create`, on `PageLoadEvent::Finished` | a static list in the host composition root, `&[fn(&Webview, &str)]` (webview, pane id); Agentation re-injects for a flagged pane |
| close hook | `browser::browser_close` | a static list `&[fn(&AppHandle, &str)]`; Agentation removes the flag |
| paste into an agent pane | a Core daemon function that `addons/agentation` calls from `dispatch.rs` | `Daemon::paste_to_agent(inner, pane_id, text)`: the live agent check, `pasted`, and the PTY write; it returns the agent and the hook pane. `record` and `events::envelope` exist already. |

Agentation needs no Browser call on the daemon side, and Browser needs no
Agentation type.

### Problems found in milestone 6 (not fixed)

1. `BrowserPane` runs the `browser_set_annotate` effect on mount with
   `enabled: false`. `agentation_script(false)` holds the whole bundle inside
   its `if (!window.__tomoAgentation)` guard, so the host evaluates the
   bundle (about 620 kB) into a page that the user never annotated.
   `docs/browser.md` says that such a page does not load it. The call can
   also come before the webview exists and record a `browser_set_annotate`
   diagnostic. The toolbar slot of milestone 7 can call it only on a toggle.
   A human must confirm this in a window.
2. `normalizeUrl("localhost:3000")` returns `localhost:3000`, because
   `localhost:` matches the scheme pattern. The webview then gets a URL
   that `Url::parse` reads as the scheme `localhost`. `example.com/x` works.

### Tests

| Suite | Before milestone 6 (`39f2448`) | Milestone 6 | Merged with master `951aa1d` |
|---|---|---|---|
| `cargo test --workspace` | 134 (tomod 125, tomo-proto 7, tomo_app_lib 2) | 134 | 144 passed and 1 ignored (tomod 135) |
| vitest | 33 files, 241 tests | 34 files, 252 tests | not changed by the merge |
| `npx tsc --noEmit`, `npx vite build` | pass | pass; main JS 721.35 kB | not changed by the merge |
| `TOMO_WRITE_TYPES=1 cargo test -p tomo-proto` | pass | pass, no change in `app/src/generated` | |
| `browser.sh`, `continuity.sh`, `layout.sh`, `layout-move.sh` | 19, 19, 15, 47 | 19, 19, 15, 47 passed, 0 failed | |

New: `app/src/browser/browser.test.tsx` (11 tests), written and green before
the move (commit `3339cfd`). It checks `normalizeUrl`, the zoomed bounds of
`browser_create`, the frame loop that sends only a change, the hide under the
palette, the navigation of its own pane only, the stop and close on unmount,
the layout switch, `openInBrowser` with and without a live pane,
`openEndpoint` without a worktree, and the browser menu. No test was removed.

### GUI checks for a human

Native child webviews cannot be checked without a window. Do these in the
installed app after a merge:

1. Open a browser pane with "New browser", with `+` → browser, and with split with → browser. The page paints inside the pane box.
2. Change the app zoom (zoom in, zoom out, reset). The page follows the box.
3. Collapse and open the left sidebar and the right inspector, drag a splitter, and resize the window. The page follows at once, with no lag and no offset.
4. Open the palette, a context menu, and a dialog over the pane. The page hides, and comes back when they close.
5. Back, forward, reload (buttons and shortcuts), Enter in the URL field, and "open in external browser".
6. Click a link inside the page: the URL field and the pane legend change. Restart the daemon: the pane comes back at the last URL.
7. Cmd-click a URL in a terminal: the live browser pane of the worktree goes to the URL; without one, a new browser tab opens.
8. "Open App" in the checkpoint banner and in Activity, "open" in the runtime popover and menus, and the palette endpoint entry.
9. Switch tabs away and back (the page reloads). Close the browser tab and reopen it: same URL.
10. Zoom a browser pane in a split, then unzoom.
11. Hover an inactive tab whose first pane is a browser: no preview. Drag a terminal pane onto that tab.
12. Make the pane narrow: under 360 px the count and open-external hide; under 260 px forward hides.
13. Agentation: Annotate on, add a note, see the count, Copy feedback, send to an agent (the text arrives), navigate (the count resets), reload with Annotate on (the toolbar comes back), close the pane.
14. Problem 1 above: in the Web Inspector of a page that was never annotated, check if `window.__tomoAgentation` exists.

### Performance

Measured on 2026-09-15 with `addons-bench.py`, release build, data dir
`/tmp/tomo-addons-browser-bench`, on the tree merged with master `951aa1d`.
As in milestones 3 and 5, `TOMO_USAGE_MOCK` pointed at a file with a far
`fetched_at_ms`, so no window called the network. The owner used the
machine. The change moves code and adds no work to a daemon path, so the
numbers show noise only.

| Metric | Baseline | Milestone 3 | Milestone 6 |
|---|---|---|---|
| Reattach | 7.66 ms | 7.76 ms | 7.51 ms |
| of which `subscribe` | 0.51 ms | 0.39 ms | 0.37 ms |
| of which `pane_attach` | 7.14 ms | 7.40 ms | 7.16 ms |
| Worktree switch | 0.14 ms | 0.08 ms | 0.10 ms |
| Worktree switch with attach | 9.26 ms | 7.53 ms | 8.20 ms |
| Refresh | 164.31 ms | 128.08 ms | 172.83 ms (trials 134.71, 172.83, 174.24) |
| Process poll, fresh | 23.41 ms | 19.00 ms | 10.39 ms |
| Process poll, cached | 0.63 ms | 0.55 ms | 0.39 ms |
| Idle CPU, no subscriber | 0.13 % | 0.12 % | **0.13 %** (0.13, 0.13, 0.13) |
| Idle CPU, one subscriber | 1.05 % | 1.00 % | **0.78 %** (0.78, 0.68, 0.90) |
| RSS at window end, no subscriber | 14.6 MB | 11.9 MB | **14.8 MB** (15.0, 14.8, 14.8) |
| RSS at window end, subscribed | 14.6 MB | 13.3 MB | **14.8 MB** (14.5, 14.8, 15.0) |

Gate: pass. Refresh is 8.5 ms (5 %) slower than the baseline, which is
below the 20 % limit; one refresh sample was 331 ms while the machine was
busy, and discovery code did not change. Idle CPU and RSS are below the
limits. The main JS chunk is 721.35 kB and the CSS 61.46 kB. Not measured:
GUI cold launch and GUI RSS (no GUI allowed). Not run: `scripts/perf.sh`,
the soak, and the full `run-all.sh`.

### Stop conditions

Hit for the extraction path: "addon framework code exceeds feature
simplification" and "generic JSON or strings replace typed APIs". So the
direct implementation stays. Not hit for the isolation: no new seam, slot,
or type; `daemon.rs` lost 66 lines and `actions.ts` 44.

## Candidates

| Candidate | Verdict | Top leaks today (see the map) |
|---|---|---|
| towns | **done** | none in Core; see "Coupling that stays" |
| github | **done** | none in Core; see "Milestone 2 result: GitHub" |
| actions | **done** | none in Core; see "Milestone 3 result: Actions" |
| runtime | addon | `Inner.endpoints`, `Snapshot.endpoints`, the `RuntimeActivity` call site in `runtime.rs`; `RuntimeEndpoint.action_id` and `label` now come from the Core `PaneSource` |
| usage | **done** | none in Core; see "Milestone 5 result: Usage" |
| browser | **built-in pane kind** | not an addon; see "Milestone 6 result: Browser" |
| agentation | addon on Core client Browser | `AnnotationsSend` arm with the `AgentationActivity` call site, `annotation.sent` hook, all UI inside `app/src/browser/BrowserPane.tsx`, inject code inside Tauri `browser::browser_create`; see "Agentation boundary for milestone 7" |
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

Done. See "Milestone 3 result: Actions". Changes from the plan:

- The provenance label is a new Core `Pane.source`, not `Pane.action_id`. `action_id` is derived from the source, and the column is no longer used.
- The source is in memory only, so restore and reopen need no seam.
- One `worktree_files` seam replaces the planned discovery seam and the watcher classifier.
- The pane exit seam was built as planned.
- `AttentionKind::Crash` stays a Core kind; Actions decides when to raise it.
- `keyBindings` reads a `shortcuts` slot.
- The `action_stopped` question is decided: a closed pane records nothing, as the code did.

### 4. Runtime

Risks:

- The `lsof` cost per tick. Keep the rule "no candidate pids means no `lsof`".
- `CheckpointBanner` and `Activity.tsx` use an endpoint for "Open App".
- `RuntimeProtocol::Https` is never produced.

Narrowest seam: a monitor tick seam `fn(&Arc<Daemon>)` after `poll_once`, called with the lock released, exactly where `scan_endpoints` runs today (`monitor.rs`). Runtime reads the Core `PaneSource` from milestone 3; `observe` no longer reads `inner.actions`. See "The pane source" in "Milestone 3 result: Actions".

### 5. Usage

Done. See "Milestone 5 result: Usage". Built as planned: `addons::start`,
`Snapshot.usage` filled in the composition root, a bottom-strip slot, a
diagnostics section slot, and `scripts/torture/usage.sh` with
`TOMO_USAGE_MOCK` before the move. Not built: `Daemon::has_subscriber()`.
The poll reads `inner.clients` in one line, as `monitor.rs` and `system.rs`
do. A shared helper for the three is a Core refactor for another change.

### 6. Browser (study)

Done. See "Milestone 6 result: Browser". Change from the plan: Browser did
not become an addon. `PaneKind` stays, and the code moved into three browser
modules. The plan below is kept for the record.

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
3. **Decided in milestone 3.** `action_stopped` on pane close. `remove_pane` removes the pane before `hangup`, so `on_exit` returns early, and no activity or `action.exited` hook runs. The code stays as it is, and the docs describe it. See "Decisions" in "Milestone 3 result: Actions".
4. **Fixed.** Stale docs. The Activity kind seam fixed two: `docs/activity.md` lists `annotations_sent`, and `docs/architecture.md` gives the measured main bundle size. Milestone 5 fixed the other two: `docs/usage.md` describes `scope`, and `README.md` puts usage in the bottom strip.
5. **Open.** `scripts/perf.sh` sends `hello` with `protocol: 1` and subscribes before discovery ends.
6. **Partly fixed in milestone 5.** Dead code. `usageSummary` and `percentOf` are removed. Still open: `townBySlug` (`app/src/addons/towns/Towns.tsx`) has no importer.
