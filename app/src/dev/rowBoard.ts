import { aPane } from "../test-fixtures";
import type { LinearLink, RuntimeEndpoint } from "../generated";
import type { AgentPresence, AgentState, AttentionItem, Frame, GitSummary, Pane, Repo, Subagent, Worktree } from "../types";

export const BOARD_REPO: Repo = { id: "board", path: "/Users/you/tomo/worktrees", name: "board", exists: true, remote_url: null };

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const GB = 1024 ** 3;

export const BOARD_WARN_BYTES = 2 * GB;

const git = (branch: string, patch: Partial<GitSummary> = {}): GitSummary => ({
  branch,
  head: "abc1234",
  detached: false,
  dirty: false,
  files_changed: 0,
  untracked: 0,
  conflicts: 0,
  insertions: 0,
  deletions: 0,
  ahead: 0,
  behind: 0,
  upstream: `origin/${branch}`,
  ...patch,
});

const wt = (name: string, branch: string, now: number, patch: Partial<Worktree> = {}): Worktree => ({
  id: `board-${name}`,
  repo_id: BOARD_REPO.id,
  path: `/Users/you/tomo/worktrees/tomo/${name}`,
  name,
  branch,
  head: "abc1234",
  detached: false,
  is_main: false,
  exists: true,
  git: git(branch),
  metadata: { display_name: null, tags: [] },
  last_active_ms: now - 10 * MIN,
  first_seen_ms: now - DAY,
  archived_at_ms: null,
  archiving: false,
  tab_count: 1,
  pane_count: 1,
  ...patch,
});

const agent = (name: string, kind: AgentPresence["kind"], state: AgentState, updated: number, patch: Partial<AgentPresence> = {}): AgentPresence => ({
  pane_id: `board-${name}-p0`,
  worktree_id: `board-${name}`,
  kind,
  state,
  session_ref: null,
  authority: "lifecycle",
  updated_at_ms: updated,
  pid: null,
  estimated: false,
  seen: false,
  ...patch,
});

const sub = (id: string, label: string, state: AgentState, description: string, started: number): Subagent => ({ id, label, description, state, started_at_ms: started, updated_at_ms: started });

export interface Board {
  worktrees: Worktree[];
  agents: AgentPresence[];
  attention: AttentionItem[];
  panes: Pane[];
  rowErrors: Record<string, { op: string; message: string }>;
  rssBytes: Record<string, number>;
  linear: LinearLink[];
  frames: Frame[];
  /** The row that is open now, drawn inverted. */
  active: string;
  /** The worktrees of the Hover boards, in their order. */
  hovers: string[];
}

/** The rows of the approved Sidebar board and the worktrees of the Hover boards, as store data. */
export function rowBoard(now: number): Board {
  const worktrees = [
    wt("isahaya", "simon/lint-burndown-2", now, {
      path: "/Users/you/tomo/worktrees/acme/isahaya",
      git: git("simon/lint-burndown-2", { dirty: true, files_changed: 12, insertions: 340, deletions: 56, untracked: 2, ahead: 3 }),
      metadata: { display_name: null, tags: ["design-system"] },
      last_active_ms: now - 4 * MIN,
      first_seen_ms: now - 2 * DAY,
    }),
    wt("kobe", "fix/login-redirect", now, { git: git("fix/login-redirect", { files_changed: 3, insertions: 41, deletions: 12 }), metadata: { display_name: null, tags: ["auth"] }, last_active_ms: now - MIN, first_seen_ms: now - 5 * HOUR }),
    wt("nagano", "feat/upload-retry", now),
    wt("sapporo", "main", now, { is_main: true, path: "/Users/you/Projects/tomo", last_active_ms: now - 2 * HOUR }),
    wt("tottori", "feat/checkout-with-a-rather-long-branch-name", now, {
      path: "/Users/you/tomo/worktrees/shop/tottori",
      git: git("feat/checkout-with-a-rather-long-branch-name", { dirty: true, conflicts: 2, files_changed: 5, insertions: 88, deletions: 20, ahead: 3, behind: 1 }),
      last_active_ms: now - 5 * HOUR,
      first_seen_ms: now - 3 * DAY,
    }),
    wt("storybook", "exp/storybook", now, { git: git("exp/storybook", { dirty: true, files_changed: 1, insertions: 3 }) }),
    wt("beppu", "chore/deps", now),
    wt("hakodate", "feat/api-docs", now),
    wt("otaru", "feat/search", now, { last_active_ms: now - 12 * MIN }),
    wt("kyoto", "spike/codex", now),
    wt("izu", "feat/big-import", now),
    wt("nara", "old/cleanup", now),
    wt("ise", "old/experiment", now, { archiving: true }),
    wt("mito", "feat/moved", now, { exists: false }),
    wt("kofu", "feat/old-sync", now, { archived_at_ms: now - 3 * DAY }),
  ];
  const agents = [
    agent("isahaya", "claude", "working", now - 4 * MIN, {
      session_ref: "a5a5e1f0b2c312cc",
      subagents: [
        sub("i1", "general-purpose", "working", "Before/after stories for the buttons", now - 4 * MIN),
        sub("i2", "general-purpose", "working", "Before/after stories for the cards", now - 4 * MIN),
        sub("i3", "general-purpose", "waiting", "asks to run the visual tests", now - MIN),
        sub("i4", "Explore", "exited", "find every eslint-disable", now - 7 * MIN),
        sub("i5", "Plan", "exited", "order the burndown", now - 12 * MIN),
      ],
    }),
    agent("kobe", "claude", "waiting", now - MIN, { session_ref: "9c8d0a1b2c3d2b25" }),
    agent("nagano", "claude", "done", now - 3 * MIN),
    agent("sapporo", "claude", "idle", now - 2 * HOUR, { session_ref: "44b1aa00bb11c0de" }),
    agent("tottori", "claude", "idle", now - 5 * HOUR, { session_ref: "1f0e5566778877aa" }),
    agent("storybook", "claude", "dead", now - 10 * MIN),
    agent("beppu", "claude", "idle", now - DAY, { sleep: "asleep" }),
    agent("otaru", "codex", "done", now - 12 * MIN, { session_ref: "7e21c0ffee0009f1" }),
    agent("kyoto", "pi", "unknown", now - 20 * MIN),
    agent("izu", "claude", "working", now - 8 * MIN),
  ];
  const attention: AttentionItem[] = [
    { id: "board-kobe-ask", worktree_id: "board-kobe", pane_id: "board-kobe-p0", level: "attention", message: "allow Bash: pnpm test --filter auth?", created_at_ms: now - MIN, viewed_at_ms: null, kind: "waiting", url: null, agent_kind: "claude", resolved_at_ms: null },
    { id: "board-isahaya-crash", worktree_id: "board-isahaya", pane_id: "board-isahaya-storybook", level: "attention", message: "Storybook exited with code -1", created_at_ms: now - 2 * MIN, viewed_at_ms: null, kind: "crash", url: null, agent_kind: null, resolved_at_ms: null },
  ];
  const panes = [aPane({ id: "board-storybook-p0", worktree_id: "board-storybook", live: false, exit_code: 1 })];
  const endpoint = (worktree: string, label: string, port: number, discovered: number): RuntimeEndpoint => ({
    id: `board-${worktree}:${port}`,
    worktree_id: `board-${worktree}`,
    pane_id: `board-${worktree}-web`,
    action_id: null,
    pid: 100 + port,
    process: "node",
    protocol: "http",
    status: 200,
    probing: false,
    host: "localhost",
    port,
    label,
    discovered_at_ms: discovered,
    source: null,
  });
  const pr = (worktree: string, number: number, title: string, patch: Record<string, unknown>): Frame =>
    ({ seq: 0, event: "pr_changed", data: { worktree_id: `board-${worktree}`, pr: { number, title, url: "", state: "open", draft: false, review_decision: null, mergeable: null, checks_passed: 0, checks_failed: 0, checks_pending: 0, fetched_at_ms: 1, ...patch } } }) as Frame;
  const frames: Frame[] = [
    pr("isahaya", 412, "Lint burndown, part 2", { checks_passed: 6, review_decision: "review_required" }),
    pr("kobe", 398, "Stop the login redirect loop", { draft: true }),
    pr("tottori", 377, "New checkout", { checks_passed: 4, checks_failed: 2 }),
    pr("otaru", 88, "Cmd-K search", { state: "merged", checks_passed: 5 }),
    { seq: 0, event: "endpoints_changed", data: { worktree_id: "board-isahaya", endpoints: [endpoint("isahaya", "web", 3003, now - 22 * MIN)] } } as Frame,
    { seq: 0, event: "endpoints_changed", data: { worktree_id: "board-hakodate", endpoints: [endpoint("hakodate", "docs", 4000, now - 30 * MIN)] } } as Frame,
  ];
  const linear: LinearLink[] = [
    { worktree_id: "board-isahaya", issue: { identifier: "ENG-12", title: "Burn down the lint backlog", url: "", state: { name: "In Review", kind: "started", color: "#8a6fd1" }, assignee: "Simon", priority: "Medium" } },
    { worktree_id: "board-otaru", issue: { identifier: "ENG-9", title: "Search everything", url: "", state: { name: "Done", kind: "completed", color: "#2f8a44" }, assignee: "Simon", priority: "Medium" } },
  ];
  return {
    worktrees,
    agents,
    attention,
    panes,
    rowErrors: { "board-nara": { op: "archive", message: "a pane still writes to the folder" } },
    rssBytes: { "board-izu": 2.1 * GB },
    linear,
    frames,
    active: "board-otaru",
    hovers: ["board-isahaya", "board-kobe", "board-tottori", "board-otaru", "board-sapporo"],
  };
}
