# Addons

An addon is an opinion that uses Core. This base ships with no addons. It
keeps the seams, so that you can add your own.

For six complete examples, see the
[`simon-main`](https://github.com/simonbukin/tomo/tree/simon-main) branch:
Towns (a collection map that names worktrees), GitHub (pull request status and
tags), Usage (Claude and Codex allowances), Actions (repo buttons from
`.tomo.toml`), Runtime (it finds the ports that your panes listen on), and
Agentation (browser annotations sent to an agent). Each one touches the same
roots that this page describes. `git diff main...simon-main` shows all of it.

## Three questions

Ask these questions about each new piece of code:

1. Is this reality that Tomo observes or keeps alive? Then it is **Core**.
2. Is this how one program shows Tomo to a person? Then it is **Client**.
3. Is this an opinion that uses Core to interpret or compose? Then it is an **Addon**.

Core never imports an addon. Two tests enforce this rule:
`core_does_not_import_addons` in `crates/tomod/src/addons/mod.rs` and
`app/src/addons/boundary.test.ts`.

## The composition roots

An addon joins Tomo in these files only.

| Layer | File | What you add |
|---|---|---|
| Wire | `crates/tomo-proto/src/lib.rs` | `pub mod addons { pub mod <name>; }`, and your `Call`, `Event`, and `Snapshot` fields |
| Daemon | `crates/tomod/src/addons/mod.rs` | `pub mod <name>;`, a field in `State`, your seams in `seams()`, a table in `migrate`, a task in `start` |
| Daemon | `crates/tomod/src/dispatch.rs` | one arm per `Call`, and your fields in the `Snapshot` |
| GUI | `app/src/addons/index.ts` | your `Addon` in `builtins` |
| GUI | `app/src/addons/activity.ts` | Activity row views for your activity kinds |
| GUI host | `app/src-tauri/src/lib.rs` | browser hooks and Tauri commands, only if you need the webview |
| CLI | `crates/tomo-cli/src/main.rs` | a subcommand, if you want one |

After a change to the wire types, run `TOMO_WRITE_TYPES=1 cargo test -p
tomo-proto` and `pnpm --dir app gen:schemas`.

## Daemon seams

`Seams` in `crates/tomod/src/daemon.rs` lists the places where Core calls an
addon:

- `worktree_namer`: names the directory of a new worktree.
- `worktree_created`, `worktree_rebound`: run after a create, a move, or a restore.
- `worktree_files`: a file in each worktree root that the addon reads, such as `.tomo.toml`.
- `pane_exited`: runs when a pane process exits.
- `process_polled`: runs after each process poll.
- `hook_events`: the names of the hook events that the addon fires, so that a
  hook in `config.toml` can name them. The addon puts its own data on the
  event under its own key in `HookEvent.addons`, for example `"action": { "id", "label" }`.

Addon state lives in `addons::State`, under the same lock as Core state. Use
`addons::state(inner)` and `addons::state_mut(inner)` to reach it.

## GUI slots

`Addon` in `app/src/addons/types.ts` lists every slot, with one comment each.
The main ones:

- `views`: a whole view with its own sidebar entry, like Map.
- `inspectorSections`, `gitDetail`, `gitMarker`: the right inspector.
- `worktreeSignals`, `signalLine`, `branchMark`: marks on worktree rows and cards.
- `topbar`, `worktreeMenu`, `paletteEntries`, `commands`, `shortcuts`: actions.
- `bottomItem`, `diagnosticsSection`: the bottom strip and the diagnostics report.
- `apps`, `appUrl`, `paneSource`, `sourceMark`, `sourceMenu`: running apps and panes that an addon starts. The Apps view shows only when an addon has `apps`.
- `onSnapshot`, `onFrame`, `mount`: read daemon state and events.

## A small first addon

1. Make `app/src/addons/<name>/index.ts` that exports an `Addon` with an `id`,
   a `label`, a `description`, and one slot, for example `inspectorSections`.
2. Add it to `builtins` in `app/src/addons/index.ts`.
3. Run the app. Settings lists it under addons.
4. When it needs data that the daemon has not got, add a `Call` and a daemon
   module, as in the table above.

Keep the addon's CSS beside it and import it from `app/src/styles/index.css`.
Use the tokens in `app/src/styles/tokens.css`, so that a theme restyles it.
