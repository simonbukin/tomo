# Development

This document makes Tomo easy for a coding agent to change. Read it before
you edit.

## Layout

```text
Cargo.toml                 workspace
crates/tomo-proto/         wire types: Call, Event, entities. The contract.
crates/tomod/              daemon
  src/main.rs              startup, single-instance check, signal handling
  src/daemon.rs            state, dispatch of every Call, tabs/panes, restore
  src/server.rs            socket accept loop, per-connection framing
  src/store.rs             SQLite schema and queries
  src/pty.rs               PTY spawn, scrollback buffer, query stripping
  src/layout.rs            pure split-tree operations
  src/git.rs               git child processes and porcelain parsers
  src/procs.rs             process table, ownership, aggregation, agent detection
  src/monitor.rs           periodic poll: cwd, titles, heuristics, resources
  src/agents.rs            authority merge, hook mapping, spawn plans, hook JSON
  src/integrations.rs      user-level hook installation
  src/watch.rs             Git directory watcher and discovery trigger
  src/config.rs            config.toml, defaults, paths
crates/tomo-cli/           `tomo` binary
  src/main.rs              clap definitions and command handlers
  src/client.rs            socket client, daemon autostart
  src/print.rs             human output
app/                       Tauri client
  src-tauri/src/lib.rs     socket bridge, `rpc` command, daemon autostart
  src/types.ts             TypeScript mirror of tomo-proto
  src/api.ts               invoke wrapper, event pump, pane output fan-out
  src/store.ts             state, event reducer, selectors
  src/actions.ts           every user action; the palette and keys call these
  src/keys.ts              keybinding parse and match
  src/*.tsx                views
integrations/pi/           Pi extension source, embedded into tomod
docs/                      this documentation
scripts/install.sh         release build and install
```

## Build, run, test

```bash
cargo test                       # Rust unit tests (proto, daemon)
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
   Put the payload in a named struct when it has more than three fields. Add
   an `Event` variant when clients must learn about the change without
   asking.
2. **Daemon.** Add a match arm in `Daemon::handle` in
   `crates/tomod/src/daemon.rs`. Lock `self.lock()` for as short a time as
   possible. Do not hold the lock across `.await`. Persist through `Store`
   and emit with `Daemon::emit`. Add the call to `server::is_slow` when it
   runs Git or anything else that takes more than a few milliseconds.
3. **CLI.** Add a subcommand in `crates/tomo-cli/src/main.rs`, call
   `c.call(Call::…)`, and print through `print.rs` with a `--json` branch.
4. **Frontend.** Mirror the types in `app/src/types.ts`. Handle the event in
   `applyFrame` in `app/src/store.ts`. Expose the action in
   `app/src/actions.ts` so the palette and keybindings get it for free.
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

## Where things are decided

| Question                              | Place                                   |
|---------------------------------------|-----------------------------------------|
| Which env vars a pane gets or loses   | `Daemon::pane_env`, `Daemon::inherited_env_to_remove` |
| How an agent is launched or resumed   | `agents::spawn_plan`                    |
| What a hook event means               | `agents::hook_outcome`                  |
| Whether a weaker signal may overwrite | `agents::merge`                         |
| What counts as owned or observed      | `procs::classify`                       |
| How a moved worktree keeps its data   | `Daemon::discover` (gitdir rebinding)   |
| Which pane gets auto-closed on exit   | `Daemon::on_exit` (exit code 0 only)    |
| Default keybindings                   | `config::default_keybindings`           |

## Known limitations

- Agent state comes from hooks and a process heuristic. There is no
  screen-signature detection. An agent without hooks shows `working` or
  `unknown`.
- Codex reports only after `tomo integrations install`, because Codex reads
  hooks from user-level files only.
- Most config changes need `tomo daemon stop`. The GUI reads `config.toml`
  on each `config_get`, so keybindings, fonts, and theme apply on the next
  window open.
- Switching worktrees unmounts xterm and replays up to 1 MB of scrollback on
  return. This is fast but not free.
- zsh may print a stray inverse `%` on the first prompt. The shell starts
  at the stored size before the GUI reports its real size.
- Some desktop automation tools deliver keyboard input to the webview but
  not click events. Real clicks work.
- The daemon uses one global mutex. Fine for one user; revisit if a call
  ever holds it for more than a few milliseconds.
