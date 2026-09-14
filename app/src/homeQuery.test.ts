import { describe, expect, it } from "vitest";
import { filterWorktrees, groupWorktrees, sortWorktrees } from "./homeQuery";
import type { AgentPresence, Worktree } from "./types";

function wt(id: string, extra: Partial<Worktree> = {}): Worktree {
  return {
    id, repo_id: "r1", path: `/w/${id}`, name: id, branch: "main", head: "abc", detached: false, is_main: false, exists: true, git: null,
    metadata: { display_name: null, project: null, priority: null, tags: [] }, last_active_ms: null, tab_count: 0, pane_count: 0, ...extra,
  };
}
const agent = (worktree_id: string, state: AgentPresence["state"]): AgentPresence => ({ pane_id: `p-${worktree_id}`, worktree_id, kind: "claude", state, session_ref: null, authority: "lifecycle", updated_at_ms: 0, pid: null });
const ctx = { repos: [{ id: "r1", name: "holly", path: "/r1", exists: true, remote_url: null, github: null }], agents: [agent("a", "waiting"), agent("b", "working")], attention: [] };
const base = { query: "", filters: [], view: "list" as const, sort: "priority" as const, group: "repo" as const, showArchived: false };
const list = [
  wt("a", { metadata: { display_name: null, project: "LR", priority: 2, tags: ["lr"] } }),
  wt("b", { metadata: { display_name: null, project: null, priority: 1, tags: [] }, last_active_ms: 5 }),
  wt("c", { archived_at_ms: 10, first_seen_ms: 99 }),
];

describe("home query", () => {
  it("hides archived unless asked and ORs values within a kind, ANDs across kinds", () => {
    expect(filterWorktrees(list, base, ctx).map((w) => w.id)).toEqual(["a", "b"]);
    expect(filterWorktrees(list, { ...base, showArchived: true }, ctx)).toHaveLength(3);
    expect(filterWorktrees(list, { ...base, filters: [{ kind: "priority", value: "1" }, { kind: "priority", value: "2" }] }, ctx)).toHaveLength(2);
    expect(filterWorktrees(list, { ...base, filters: [{ kind: "priority", value: "1" }, { kind: "tag", value: "lr" }] }, ctx)).toHaveLength(0);
    expect(filterWorktrees(list, { ...base, filters: [{ kind: "agent", value: "waiting" }] }, ctx).map((w) => w.id)).toEqual(["a"]);
    expect(filterWorktrees(list, { ...base, filters: [{ kind: "archived", value: "yes" }] }, ctx).map((w) => w.id)).toEqual(["c"]);
    expect(filterWorktrees(list, { ...base, query: "LR" }, ctx).map((w) => w.id)).toEqual(["a"]);
  });

  it("sorts by priority, attention, created", () => {
    expect(sortWorktrees(list, "priority", ctx).map((w) => w.id)).toEqual(["b", "a", "c"]);
    expect(sortWorktrees(list, "attention", ctx).map((w) => w.id)).toEqual(["a", "b", "c"]);
    expect(sortWorktrees(list, "created", ctx).map((w) => w.id)).toEqual(["c", "a", "b"]);
  });

  it("groups by priority in fixed order", () => {
    expect(groupWorktrees(list, "priority", ctx).map((g) => g.key)).toEqual(["p1", "p2", "no priority"]);
    expect(groupWorktrees(list, "none", ctx)).toHaveLength(1);
  });
});
