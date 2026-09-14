# Tomo

Tomo is a small, fast macOS desktop tool for local development work that is
spread across Git repositories, Git worktrees, terminals, and coding agents.

Tomo is not an IDE and not an agent orchestrator. It answers these questions
at a glance:

- What repositories and worktrees exist?
- Which ones am I working on?
- What terminals and agents run in each?
- Which agents need my attention?
- Which worktree consumes my machine?
- After a restart, how do I get back to where I was?

The worktree is the unit of context. Terminals, agents, processes, resource
use, metadata, and attention all roll up to a worktree.

Tomo has three parts:

| Part    | Role                                                                  |
|---------|-----------------------------------------------------------------------|
| `tomod` | Local Rust daemon. Owns terminals, state, agent signals, persistence. |
| `tomo`  | Command-line client. Agents and shell scripts use it.                 |
| Tomo.app| Tauri desktop client. A disposable view of the daemon.                |

Close the window and nothing dies. Reopen it and everything reconnects.

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

## Five useful commands

```bash
tomo status                          # daemon, counts, integration state
tomo worktree list                   # every known worktree with agents
tomo agent spawn codex --cwd .       # start Codex in a new pane of this worktree
tomo notify "Need approval"          # raise attention from inside a pane
tomo ps --worktree .                 # process tree and memory for this worktree
```

Add `--json` to any command for structured output.

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
- [docs/development.md](docs/development.md) — build, run, test, and change
  Tomo
- [docs/data-model.md](docs/data-model.md) — SQLite tables, identities, and
  config keys
