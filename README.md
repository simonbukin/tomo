# tomo

**somewhere to put your agents.** small, local, and yours.

Tomo keeps your worktrees, your terminals, and the agents working in them in
one window. It tells you which agent is working, which one is waiting for you,
and which one is eating the machine.

It does not replace Git, your editor, your shell, or your agents. It keeps the
room organized.

## Two branches

- **`main`** is the base: a clean, flat copy for you to install, use, and take
  apart. It has the core, the window, and the addon seams, with no addons and
  no opinions of mine in it.
- **[`simon-main`](https://github.com/simonbukin/tomo/tree/simon-main)** is my
  own Tomo: my config and my six addons. There is a map of Japanese towns that
  names each worktree, GitHub pull request status, Claude and Codex allowances,
  repo buttons, port discovery, and browser annotations for agents. Read it as
  a worked example. `git diff main...simon-main` shows everything that I added.

The base is for you to mess with.

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

The worktree is the unit. Terminals, agents, processes, and attention all roll
up to one. Tags group worktrees and need no config.

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
  writes a commented default on first run: themes, fonts, keybindings, agents.
- **Themes** are 14 colors in `[theme]`. The look itself is one token file,
  `app/src/styles/tokens.css`; [DESIGN.md](DESIGN.md) says how it fits
  together.
- **Hooks** run your commands on events like `agent.waiting` or
  `worktree.created`, with the event JSON on stdin.
- **Addons** add their own state, their own commands, and their own place in
  the window. [docs/addons.md](docs/addons.md) lists every seam and the few
  files that an addon touches.

## Things to build

Ideas, small to large. Each one fits the seams that are already there.

**Make it look like yours**
- A theme: 14 colors, or a new `tokens.css` with a different grid unit and faces.
- A sidebar that works like you think: by owner, by age, by ticket, or as a tree.
- A calmer mode that hides every worktree whose agent is not waiting for you.

**Plug in your tools**
- Linear, Jira, GitHub Issues, or Things: tags as tickets, and a view of your queue.
- Pull request or merge request status, and CI runs for each branch.
- Sentry or log errors for the branch in the inspector.
- Slack, ntfy, or a phone push when an agent waits for too long.

**Work with agents**
- A new agent provider next to Claude, Codex, and Pi.
- A cost or allowance meter in the bottom strip.
- A "hand this to another agent" button that moves a task and its context.
- Repo buttons for your dev server, tests, and storybook.

**Just for fun**
- A collection game: towns, birds, stars, or trains that you unlock with each worktree.
- A streak counter for merged branches.
- A small pet in the corner that sleeps when your agents are idle.

`simon-main` has working versions of several of these.

## Docs

[architecture](docs/architecture.md) ·
[cli](docs/cli.md) ·
[hooks](docs/hooks.md) ·
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
