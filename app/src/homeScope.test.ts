import { describe, expect, it } from "vitest";
import { ALL, repoSummaries, sameScope, scopeTitle, scopeWorktrees, tally } from "./homeScope";
import type { QueryContext } from "./homeQuery";
import type { AgentPresence, AgentState, HomeScope, Repo, Worktree } from "./types";

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
  metadata: { display_name: null, project: null, state: null, tags: [], ...over.metadata },
});

const repo = (id: string, over: Partial<Repo> = {}): Repo => ({ id, path: `/r/${id}`, name: id, exists: true, remote_url: null, ...over });

const agent = (worktree_id: string, state: AgentState) =>
  ({ pane_id: `p-${worktree_id}-${state}`, worktree_id, kind: "claude", state, session_ref: null, updated_at_ms: 0, pid: null }) as unknown as AgentPresence;

const ctx = (over: Partial<QueryContext> = {}): QueryContext => ({ repos: [], agents: [], attention: [], states: [], ...over });

describe("scopeWorktrees", () => {
  const list = [
    wt({ id: "a", repo_id: "r1", metadata: { project: "atlas", tags: ["design"] } }),
    wt({ id: "b", repo_id: "r2", metadata: { project: "atlas", tags: [] } }),
    wt({ id: "c", repo_id: "r1" }),
  ];

  it("returns everything for the all scope", () => {
    expect(scopeWorktrees(list, ALL)).toHaveLength(3);
  });

  it("filters by repository", () => {
    expect(scopeWorktrees(list, { kind: "repo", repoId: "r1" }).map((w) => w.id)).toEqual(["a", "c"]);
  });

  it("filters by project across repositories", () => {
    expect(scopeWorktrees(list, { kind: "project", project: "atlas" }).map((w) => w.id)).toEqual(["a", "b"]);
  });

  it("filters by tag", () => {
    expect(scopeWorktrees(list, { kind: "tag", tag: "design" }).map((w) => w.id)).toEqual(["a"]);
  });

  it("treats a missing project as the empty project", () => {
    expect(scopeWorktrees(list, { kind: "project", project: "" }).map((w) => w.id)).toEqual(["c"]);
  });
});

describe("sameScope", () => {
  const cases: HomeScope[] = [ALL, { kind: "repo", repoId: "r1" }, { kind: "project", project: "atlas" }, { kind: "tag", tag: "design" }];

  it("matches a scope with itself", () => {
    for (const s of cases) expect(sameScope(s, { ...s })).toBe(true);
  });

  it("separates different scopes", () => {
    for (const a of cases) for (const b of cases) if (a !== b) expect(sameScope(a, b)).toBe(false);
  });

  it("separates two scopes of the same kind with different values", () => {
    expect(sameScope({ kind: "repo", repoId: "r1" }, { kind: "repo", repoId: "r2" })).toBe(false);
  });
});

describe("tally", () => {
  it("counts live worktrees, agents, and attention, and takes the newest activity", () => {
    const list = [wt({ id: "a", last_active_ms: 100 }), wt({ id: "b", last_active_ms: 900 }), wt({ id: "old", archived_at_ms: 1, last_active_ms: 5000 })];
    const t = tally(list, ctx({ agents: [agent("a", "working"), agent("b", "waiting")] }));
    expect(t).toEqual({ worktrees: 2, agents: 2, attention: 1, lastActiveMs: 900 });
  });

  it("ignores an exited agent", () => {
    expect(tally([wt({ id: "a" })], ctx({ agents: [agent("a", "exited")] })).agents).toBe(0);
  });

  it("reports no activity when nothing has run", () => {
    expect(tally([wt({ id: "a" })], ctx()).lastActiveMs).toBeNull();
  });

  it("counts nothing for an empty list", () => {
    expect(tally([], ctx())).toEqual({ worktrees: 0, agents: 0, attention: 0, lastActiveMs: null });
  });
});

describe("repoSummaries", () => {
  const repos = [repo("r1", { name: "tomo" }), repo("r2", { name: "labor" }), repo("r3", { name: "quiet" })];
  const list = [wt({ id: "a", repo_id: "r1", last_active_ms: 100 }), wt({ id: "b", repo_id: "r2", last_active_ms: 900 })];

  it("orders repositories by most recent activity", () => {
    expect(repoSummaries(list, repos, ctx()).map((r) => r.repo.name)).toEqual(["labor", "tomo", "quiet"]);
  });

  it("keeps a repository that has no worktrees", () => {
    const quiet = repoSummaries(list, repos, ctx()).find((r) => r.repo.name === "quiet");
    expect(quiet).toMatchObject({ worktrees: 0, agents: 0, lastActiveMs: null });
  });

  it("counts each repository separately", () => {
    const summaries = repoSummaries(list, repos, ctx({ agents: [agent("a", "working")] }));
    expect(summaries.find((r) => r.repo.name === "tomo")).toMatchObject({ worktrees: 1, agents: 1 });
    expect(summaries.find((r) => r.repo.name === "labor")).toMatchObject({ worktrees: 1, agents: 0 });
  });
});

describe("scopeTitle", () => {
  it("names each scope", () => {
    const repos = [repo("r1", { name: "tomo" })];
    expect(scopeTitle(ALL, repos)).toBe("all work");
    expect(scopeTitle({ kind: "repo", repoId: "r1" }, repos)).toBe("tomo");
    expect(scopeTitle({ kind: "project", project: "atlas" }, repos)).toBe("atlas");
    expect(scopeTitle({ kind: "tag", tag: "design" }, repos)).toBe("#design");
  });
});
