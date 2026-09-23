import type { Branch, Pane, PaneResult, Tab, Worktree, WorktreeOpened } from "./generated";

export const aWorktree = (patch: Partial<Worktree> = {}): Worktree => ({
  id: "w1",
  repo_id: "r1",
  path: "/src/kobe",
  name: "kobe",
  branch: "feat/kobe",
  head: "abc1234",
  detached: false,
  is_main: false,
  exists: true,
  git: null,
  metadata: { display_name: null, tags: [] },
  last_active_ms: null,
  first_seen_ms: null,
  archived_at_ms: null,
  archiving: false,
  tab_count: 0,
  pane_count: 0,
  ...patch,
});

export const aPane = (patch: Partial<Pane> = {}): Pane => ({
  id: "p1",
  tab_id: "t1",
  worktree_id: "w1",
  title: "zsh",
  user_title: null,
  cwd: "/src/kobe",
  cols: 80,
  rows: 24,
  pid: null,
  live: true,
  origin: "live",
  exit_code: null,
  agent: null,
  created_at_ms: 0,
  source: null,
  action_id: null,
  process_cmd: null,
  kind: "terminal",
  url: null,
  ...patch,
});

export const aTab = (patch: Partial<Tab> = {}): Tab => ({
  id: "t1",
  worktree_id: "w1",
  title: "1",
  position: 0,
  layout: { type: "leaf", pane_id: "p1" },
  active_pane_id: "p1",
  is_active: true,
  ...patch,
});

export const aBranch = (patch: Partial<Branch> = {}): Branch => ({ name: "main", remote: null, upstream: null, committed_at_ms: 0, ...patch });

export const aPaneResult = (patch: Partial<PaneResult> = {}): PaneResult => ({ pane: aPane(), tab: aTab(), ...patch });

export const aWorktreeOpened = (patch: Partial<WorktreeOpened> = {}): WorktreeOpened => ({ worktree: aWorktree(), tabs: [], ...patch });
