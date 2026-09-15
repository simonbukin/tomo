# Development

This document makes Tomo easy for a coding agent to change. Read it before
you edit.

## Layout

```text
Cargo.toml                 workspace
crates/tomo-proto/         wire types: Call, Event, entities. The contract.
crates/tomod/              daemon
  src/main.rs              startup, single-instance check, signal handling (composition root)
  src/dispatch.rs          addon calls to their addon, every other Call to Daemon::handle (composition root)
  src/daemon.rs            state, the Core Call handler, Seams, tabs/panes, restore
  src/server.rs            socket accept loop, per-connection framing
  src/addons/mod.rs        the static addon list, seams(), migrate(), start(), the dependency test (composition root)
  src/addons/towns/        Japan Towns: calls, towns table, seams, dataset and pick
  src/addons/usage/        provider usage: Claude and Codex adapters, last result, poll, usage_get, notices
  src/store.rs             SQLite schema and queries
  src/pty.rs               PTY spawn, scrollback buffer, query stripping
  src/layout.rs            pure split-tree operations
  src/git.rs               git child processes and porcelain parsers
  src/procs.rs             process table, ownership, aggregation, agent detection
  src/monitor.rs           periodic poll: cwd, titles, heuristics, resources
  src/agents.rs            authority merge, hook mapping, spawn plans, hook JSON
  src/integrations.rs      user-level hook installation
  src/watch.rs             Git directory and .tomo.toml watcher, discovery trigger
  src/config.rs            config.toml, defaults, paths
  src/events.rs            hook envelopes, hook processes, the archive gate
  src/features/actions.rs  .tomo.toml parser for repo-defined Actions
crates/tomo-cli/           `tomo` binary
  src/main.rs              clap definitions and command handlers
  src/client.rs            socket client, daemon autostart
  src/print.rs             human output
app/                       Tauri client
  src-tauri/src/lib.rs     socket bridge, `rpc` command, daemon autostart
  src/generated/           TypeScript types generated from tomo-proto; do not edit
  src/types.ts             re-exports src/generated plus view-only types
  src/api.ts               invoke wrapper, event pump, pane output fan-out
  src/store.ts             state, event reducer, selectors
  src/actions.ts           every user action; the palette and keys call these
  src/keys.ts              keybinding parse and match
  src/*.tsx                views
  src/addons/index.ts      the builtins list (composition root)
  src/addons/types.ts      the Addon type: the slots that addons fill
  src/addons/towns/        Japan Towns view, ceremony, create field, state, CSS, data
  src/addons/usage/        usage meters, bucket popover, diagnostics section, state
integrations/pi/           Pi extension source, embedded into tomod
docs/                      this documentation
scripts/install.sh         release build and install
```

## Build, run, test

```bash
cargo test                       # Rust unit tests (proto, daemon); fails if app/src/generated is stale
TOMO_WRITE_TYPES=1 cargo test -p tomo-proto   # regenerate app/src/generated from tomo-proto
cargo build                      # debug binaries in target/debug
pnpm --dir app install
pnpm --dir app build             # tsc --noEmit, then vite build
pnpm --dir app test              # vitest
```

Run the app against a scratch data directory so your real state stays
untouched:

```bash
cargo build -p tomod -p tomo-cli
TOMO_DATA_DIR=/tmp/tomo-dev pnpm --dir app tauri dev
```

The dev app finds `target/debug/tomod` and `target/debug/tomo` on its own.
Drive the same daemon from a shell:

```bash
export TOMO_DATA_DIR=/tmp/tomo-dev
target/debug/tomo repo add ~/Projects/something
target/debug/tomo worktree list
```

After you change `tomod`, run `target/debug/tomo daemon stop`. The app
restarts the daemon with the new binary.

Logs: the daemon writes to stderr, which the app and the CLI redirect to
`<data dir>/tomod.log`. Set `RUST_LOG=debug` for more.

## Add a daemon operation end to end

1. **Contract.** Add a variant to `Call` in `crates/tomo-proto/src/lib.rs`.
   Put the payload in a named struct when it has more than three fields and
   derive `TS` on it. Add an `Event` variant when clients must learn about
   the change without asking. Then run
   `TOMO_WRITE_TYPES=1 cargo test -p tomo-proto` to regenerate
   `app/src/generated/`; commit those files. Plain `cargo test` fails while
   they are stale.
2. **Daemon.** Add a match arm in `Daemon::handle` in
   `crates/tomod/src/daemon.rs`. For an addon call, add the arm in
   `crates/tomod/src/dispatch.rs` and the handler in the addon folder
   instead (see [addons.md](addons.md)). Lock `self.lock()` for as short a time as
   possible. Do not hold the lock across `.await`. Persist through `Store`
   and emit with `Daemon::emit`. Add the call to `server::is_slow` when it
   runs Git or anything else that takes more than a few milliseconds.
3. **CLI.** Add a subcommand in `crates/tomo-cli/src/main.rs`, call
   `c.call(Call::…)`, and print through `print.rs` with a `--json` branch.
4. **Frontend.** Import the generated types (`app/src/types.ts` re-exports
   `app/src/generated`). Handle the event in `applyFrame` in
   `app/src/store.ts`. Expose the action in `app/src/actions.ts` so the
   palette and keybindings get it for free.
6. **Hook event.** If the change is a workflow transition, build a
   `HookEvent` with `events::envelope` and push it to `inner.hook_queue`
   while you hold the lock; `Daemon::handle` flushes the queue after the
   request. Add the name to `HOOK_EVENTS` in `tomo-proto` and to
   `docs/hooks.md`.
5. **Docs.** Add the command to `docs/cli.md`.

## Conventions

- No comments. Choose a better name or a smaller function. A doc comment is
  allowed on a module or on a choice a reader cannot see in the code.
- Pure functions for logic, side effects at the edges. Parsers (`git.rs`),
  tree operations (`layout.rs`), classification (`procs.rs`), and merging
  (`agents.rs`) take values and return values. Tests live next to them.
- The daemon owns behavior. The GUI renders state and calls operations. Do
  not put runtime logic in a React component.
- Every persisted field has a category: authoritative, cached, or
  recoverable. Say which one in `docs/data-model.md` when you add a column.
- Prefer a boring dependency to a clever one. Prefer no dependency to a
  boring one.
- One runnable check per non-trivial piece of logic. No test frameworks
  beyond `cargo test` and vitest.

## UI primitives

Before you implement any menu, dialog, popover, tooltip, select, button, or
command surface, look in `app/src/components/ui/`. Do not hand-roll a
generic interaction primitive. The primitives wrap Base UI and own focus,
keyboard navigation, ARIA roles, portals, collision positioning, outside
click, and Escape. Tomo owns the look through CSS classes and tokens in
`app/src/styles/`. See `docs/ui.md` for the rules and the torture page.

## Where things are decided

| Question                              | Place                                   |
|---------------------------------------|-----------------------------------------|
| Which env vars a pane gets or loses   | `Daemon::pane_env`, `Daemon::inherited_env_to_remove` |
| How an agent is launched or resumed   | `agents::spawn_plan`                    |
| What a hook event means               | `agents::hook_outcome`                  |
| Whether a weaker signal may overwrite | `agents::merge`                         |
| What counts as owned or observed      | `procs::classify`                       |
| How a moved worktree keeps its data   | `Daemon::rebind`, called from `Daemon::discover` (gitdir) and `restore_worktree` |
| Which pane gets auto-closed on exit   | `Daemon::on_exit` (exit code 0 only)    |
| Default keybindings                   | `config::default_keybindings`           |
| Which hooks run for an event          | `events::matching_hooks`, `Daemon::dispatch` |
| The only synchronous hook             | `Daemon::gate` (`worktree.before_archive`) |
| Which states are valid                | `config.states`, checked in `MetadataSet` |
| Config validation                     | `config::check`                         |
| Layout mutations                      | `layout::{split,remove,resize,equalize,swap,rotate,insert,move_within,move_to_edge,reorder}`, applied in `moves.rs` |
| Town naming and unlocks               | `addons::towns::{name_worktree, unlock, rebind}`, joined through `Seams` |
| Which addons exist and where they join Core | `addons::seams`, `addons::start`, `dispatch::handle`, `app/src/addons/index.ts` |
| When usage fetches and what it warns about | `addons::usage::{get, run, crossings}` |
| What `.tomo.toml` accepts             | `features::actions::parse`              |
| How an action runs, reuses, or stops  | `Daemon::run_action`, `Daemon::stop_action` |
| Whether an archive commits or refuses | `Daemon::archive_checkpoint`            |

## Verification without model tokens

Validate in this order; each step is cheaper than the next:

1. Pure Rust and TypeScript unit tests (`cargo test`, `pnpm --dir app test`).
2. Fake processes: `scripts/fixtures/fake-playwright-tree`,
   `scripts/fixtures/memory-hog`, `scripts/fixtures/cwd-wanderer`.
3. Fake agents and hooks: `scripts/fixtures/fake-agent` speaks the real
   hook protocol through `tomo hook claude`; point `[agents.claude]` at it.
4. Deterministic harnesses against a scratch daemon:
   `scripts/torture/run-all.sh` (terminal, agents, provenance, layout) and
   `scripts/soak/busy.sh <minutes> <report path>`.
5. Real CLI and TUI programs in a pane (`vim`, `less`, `top`, `fzf`).
6. One short real Claude, Codex, and Pi session each.
7. Daily use.

Never spawn a real agent only to create process activity or a state
transition; the fixtures do that for free. `scripts/perf.sh` records the
daemon numbers listed in `architecture.md`.

## Known limitations

- Agent state comes from hooks and a process heuristic. There is no
  screen-signature detection. An agent without hooks shows `working` or
  `unknown`.
- Codex reports only after `tomo integrations install`, because Codex reads
  hooks from user-level files only.
- The daemon reloads `config.toml` when the file changes and sends
  `config_changed`, so the theme, the terminal font, and keybindings apply at
  once. A terminal that is already open keeps its shell.
- Switching worktrees unmounts xterm and replays up to 1 MB of scrollback on
  return. This is fast but not free.
- zsh may print a stray inverse `%` on the first prompt. The shell starts
  at the stored size before the GUI reports its real size.
- Some desktop automation tools deliver keyboard input to the webview but
  not click events. Real clicks work.
- The daemon uses one global mutex. Fine for one user; revisit if a call
  ever holds it for more than a few milliseconds.
