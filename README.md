# tomo

**somewhere to put your agents.** small, local, and yours.

Tomo keeps your worktrees, your terminals, and the agents working in them in
one window. It tells you which agent is working, which one is waiting for you,
and which one is eating the machine.

It does not replace Git, your editor, your shell, or your agents. It keeps the
room organized.

## Install

macOS only, for now.

```bash
git clone https://github.com/simonbukin/tomo && tomo/scripts/install.sh
tomo integrations install
```

The script builds the release binaries, puts `tomo` and `tomod` in
`~/.local/bin`, and puts `Tomo.app` in `/Applications`. The second line adds
the hooks for Claude, Codex, and Pi; they do nothing outside a Tomo terminal.

Open Tomo.app, add a repository with the plus button, and every worktree of it
turns up in the sidebar. Click one and a shell opens there. `⌘K` is the command
palette; `⌘⇧A` jumps to the next agent that wants you.

## The shape of it

| part | what it is |
|---|---|
| `tomod` | a local Rust daemon. It owns the terminals, the state, and the agent signals. |
| `tomo` | the command line client. Agents and scripts talk to Tomo through it. |
| Tomo.app | a window. Close it and nothing dies; open it again and everything reconnects. |

The worktree is the unit. Terminals, agents, processes, ports, and attention
all roll up to one.

## A few commands

```bash
tomo status                      # daemon, counts, integrations
tomo worktree list               # every worktree, with its agents
tomo agent spawn codex --cwd .   # start an agent in a new pane here
tomo notify "need a human"       # raise attention from inside a pane
tomo worktree archive .          # checkpoint, close, remove, keep the branch
```

Add `--json` to any of them.

## Making it yours

Everything below is a file you can edit.

- **Config** lives in `~/Library/Application Support/tomo/config.toml`. Tomo
  writes a commented default on first run. Themes, fonts, keybindings, your own
  workflow states.
- **Actions** are commands a repository declares in `.tomo.toml`. They become
  buttons and palette entries in every worktree of it.
- **Hooks** run your commands on events like `agent.waiting` or
  `worktree.created`, with the event JSON on stdin.
- **Addons** add their own state, their own commands, and their own place in
  the window. The core stays small on purpose.

```toml
[[actions]]
id = "storybook"
label = "Storybook"
command = "pnpm storybook"
show = "topbar"
```

## Docs

[architecture](docs/architecture.md) ·
[cli](docs/cli.md) ·
[hooks](docs/hooks.md) ·
[actions](docs/actions.md) ·
[theming](docs/theming.md) ·
[addons](docs/addons.md) ·
[agent integrations](docs/agent-integrations.md) ·
[development](docs/development.md)

[DESIGN.md](DESIGN.md) is how it is meant to look and why.

## Building on it

```bash
cargo test --workspace
cd app && pnpm install && pnpm test
```

The landing page is one static file at [site/index.html](site/index.html), with
no build step.

## Don't like something?

All good. Fork it and do whatever you want with it. It is public domain, there
is no licence to argue with, and nobody is going to ask what you did to it.
