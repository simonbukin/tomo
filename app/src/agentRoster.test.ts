import { describe, expect, it } from "vitest";
import { agentRoster, rosterSize } from "./agentRoster";
import type { AgentPresence, AgentState, Repo, Worktree } from "./types";

const wt = (over: Omit<Partial<Worktree>, "metadata"> & { id: string; metadata?: Partial<Worktree["metadata"]> }): Worktree => ({
  repo_id: "r1",
  path: `/w/${over.id}`,
  name: over.id,
  branch: null,
  head: "abc1234",
  detached: false,
  is_main: false,
  exists: true,
  git: null,
  last_active_ms: null,
  first_seen_ms: null,
  archived_at_ms: null,
  archiving: false,
  tab_count: 0,
  pane_count: 0,
  ...over,
  metadata: { display_name: null, tags: [], ...over.metadata },
});

const repo = (id: string, name = id): Repo => ({ id, path: `/r/${id}`, name, exists: true, remote_url: null });

const agent = (pane: string, worktree_id: string, state: AgentState, updated_at_ms = 0): AgentPresence => ({
  pane_id: pane,
  worktree_id,
  kind: "claude",
  state,
  session_ref: null,
  authority: "lifecycle",
  updated_at_ms,
  pid: null,
});

const repos = [repo("r1", "tomo"), repo("r2", "labor")];
const worktrees = [wt({ id: "main", repo_id: "r1" }), wt({ id: "ui", repo_id: "r1" }), wt({ id: "costing", repo_id: "r2" })];

describe("agentRoster", () => {
  it("puts a waiting agent before a working one, and idle last", () => {
    const agents = [agent("p1", "main", "idle"), agent("p2", "ui", "working"), agent("p3", "costing", "waiting")];
    expect(agentRoster(agents, worktrees, repos).map((r) => r.state)).toEqual(["waiting", "working", "idle"]);
  });

  it("drops an agent that exited", () => {
    const agents = [agent("p1", "main", "exited"), agent("p2", "ui", "working")];
    expect(agentRoster(agents, worktrees, repos).map((r) => r.paneId)).toEqual(["p2"]);
  });

  it("names the repository and the worktree", () => {
    const [row] = agentRoster([agent("p1", "costing", "working")], worktrees, repos);
    expect(row).toMatchObject({ repo: "labor", worktree: "costing", paneId: "p1", worktreeId: "costing" });
  });

  it("keeps an agent whose worktree is gone, and says so", () => {
    const [row] = agentRoster([agent("p1", "vanished", "working")], worktrees, repos);
    expect(row).toMatchObject({ worktree: "unknown", repo: "?", worktreeId: "vanished" });
  });

  it("orders agents in the same state by most recent first", () => {
    const agents = [agent("old", "main", "working", 10), agent("new", "ui", "working", 900)];
    expect(agentRoster(agents, worktrees, repos).map((r) => r.paneId)).toEqual(["new", "old"]);
  });

  it("returns nothing for no agents", () => {
    expect(agentRoster([], worktrees, repos)).toEqual([]);
  });

  it("carries no task, goal, or plan", () => {
    const [row] = agentRoster([agent("p1", "main", "working")], worktrees, repos);
    expect(Object.keys(row).sort()).toEqual(["kind", "paneId", "repo", "state", "updatedAtMs", "worktree", "worktreeId"]);
  });
});

describe("rosterSize", () => {
  it("counts only the agents that are still present", () => {
    expect(rosterSize([agent("p1", "main", "working"), agent("p2", "ui", "exited"), agent("p3", "costing", "waiting")])).toBe(2);
  });

  it("counts nothing when no agent runs", () => {
    expect(rosterSize([])).toBe(0);
  });
});
