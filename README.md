# tomo

A little workspace for my coding agents.

Tomo keeps worktrees, terminals, agents, running apps, and the things that
need attention in one quiet place. It answers these questions at a glance:

- What repositories and worktrees exist?
- Which ones am I working on?
- What terminals and agents run in each?
- Which agents need my attention?
- Which worktree consumes my machine?
- After a restart, how do I get back to where I was?

It does not replace Git, your editor, your shell, or your agents. It keeps
the room organized.

The worktree is the unit of context. Terminals, agents, processes, resource
use, metadata, and attention all roll up to a worktree.

Tomo has three parts:

| Part    | Role                                                                  |
|---------|-----------------------------------------------------------------------|
| `tomod` | Local Rust daemon. Owns terminals, state, agent signals, persistence. |
| `tomo`  | Command-line client. Agents and shell scripts use it.                 |
| Tomo.app| Tauri desktop client. A disposable view of the daemon.                |

Close the window and nothing dies. Reopen it and everything reconnects.

## What is happening right now

Tomo watches the runtime for you. Listening ports that belong to a pane
show up as endpoints next to their Action (`● App ↗`), open in a browser
surface inside the worktree, and can be annotated and sent to the agent
that already works there. Crashes, agent waits, checkpoints, state
changes, and archives land in one Activity stream; `tomo checkpoint
"Review the new costing UI" --url http://localhost:3000` is how an agent
asks for a human. Usage limits for Claude and Codex show in the bottom
strip. See [docs/runtime.md](docs/runtime.md),
[docs/activity.md](docs/activity.md), [docs/browser.md](docs/browser.md),
and [docs/usage.md](docs/usage.md).

## Install

```bash
git clone <this repository> tomo
cd tomo
scripts/install.sh
```

The script builds the release binaries, copies `tomo` and `tomod` to
`~/.local/bin`, and copies `Tomo.app` to `/Applications`. Make sure that
`~/.local/bin` is on your `PATH`.

Then install the agent integrations once:

```bash
tomo integrations install
```

This adds Tomo hooks to `~/.claude/settings.json` and `~/.codex/hooks.json`
and writes the Pi extension to `~/.pi/agent/extensions/tomo-status.ts`. The
hooks do nothing outside a Tomo terminal. See
[docs/agent-integrations.md](docs/agent-integrations.md).

## First run

1. Open Tomo.app. It starts `tomod` when the daemon is not running.
2. Add a repository with the plus button in the sidebar, or run
   `tomo repo add <path>`.
3. Every Git worktree of that repository appears in the sidebar and on Home.
4. Click a worktree. A shell opens in it.
5. Press `⌘K` for the command palette and `⌘⇧A` to jump to the next agent
   that waits for you.

Configuration lives in `~/Library/Application Support/tomo/config.toml`. Tomo
writes a commented default file on the first start.

## Useful commands

```bash
tomo status                          # daemon, counts, integration state
tomo worktree list                   # every known worktree with agents
tomo agent spawn codex --cwd .       # start Codex in a new pane of this worktree
tomo notify "Need approval"          # raise attention from inside a pane
tomo ps --worktree .                 # process tree and memory for this worktree
tomo worktree metadata set . --state waiting-review   # move it along your workflow
tomo worktree archive .              # done: checkpoint, close terminals, remove the worktree, keep the branch
tomo config check                    # validate config.toml
```

Add `--json` to any command for structured output.

## States and hooks

A worktree has one workflow state (`exploring`, `active`, `waiting-review`,
`merged` by default; define your own under `[[states]]`) and any number of
tags. Home groups by state. Events such as `worktree.state_changed`,
`worktree.created`, and `agent.waiting` run the commands you list under
`[[hooks]]`, with the event JSON on stdin; a hook acts on Tomo through the
`tomo` CLI. See [docs/hooks.md](docs/hooks.md).

An archive commits uncommitted work as `tomo: archive checkpoint` on the
branch before it removes the directory, so a restore brings it back.

## Actions

A repository can name commands in `.tomo.toml`. They show as buttons and
palette entries in each worktree, and `tomo action run <id>` runs them.

```toml
[[actions]]
id = "storybook"
label = "Storybook"
command = "pnpm storybook"
show = "topbar"
```

Tomo never runs an action by itself. See [docs/actions.md](docs/actions.md).

## Pull requests

With the GitHub CLI logged in (`gh auth login`), the right panel and
`tomo pr` show the pull request for the current branch: state, review
decision, and check results. Tomo does not manage pull requests.

## Worktree names

A new worktree without an explicit path is named after a Japanese
municipality (city, town, or village). Each town has a rarity tier by
population, a Wikipedia link, and a place on the map view. Creating
worktrees unlocks towns; `tomo towns list --unlocked` shows the collection.

## Documentation

- [docs/architecture.md](docs/architecture.md) — parts, invariants, what is
  authoritative and what is cached
- [docs/state-and-recovery.md](docs/state-and-recovery.md) — live, restored,
  and resumed panes; what survives what
- [docs/agent-integrations.md](docs/agent-integrations.md) — Claude, Codex,
  and Pi signals and session resume
- [docs/cli.md](docs/cli.md) — every `tomo` command
- [docs/hooks.md](docs/hooks.md) — events, hook configuration, recipes
- [docs/actions.md](docs/actions.md) — repo-defined commands in `.tomo.toml`
- [docs/features/towns.md](docs/features/towns.md) — Japan Towns
- [docs/development.md](docs/development.md) — build, run, test, and change
  Tomo (protocol types are generated from Rust; see there)
- [docs/data-model.md](docs/data-model.md) — SQLite tables, identities, and
  config keys

## About

tomo

made for work in progress.

A small local workspace for Git worktrees, terminals, coding agents, and
everything they leave running.

Don't like it? Fork it and ask your agent to change it.
