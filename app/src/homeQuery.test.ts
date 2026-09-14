import { describe, expect, it } from "vitest";
import { filterWorktrees, groupWorktrees, sortWorktrees, type QueryContext } from "./homeQuery";
import type { AgentPresence, Worktree } from "./types";

function wt(id: string, extra: Partial<Worktree> = {}): Worktree {
  return {
    id, repo_id: "r1", path: `/w/${id}`, name: id, branch: "main", head: "abc", detached: false, is_main: false, exists: true, git: null,
    metadata: { display_name: null, project: null, state: null, tags: [] }, last_active_ms: null, first_seen_ms: null, archived_at_ms: null, archiving: false, town_slug: null, tab_count: 0, pane_count: 0, ...extra,
  };
}
const agent = (worktree_id: string, state: AgentPresence["state"]): AgentPresence => ({ pane_id: `p-${worktree_id}`, worktree_id, kind: "claude", state, session_ref: null, authority: "lifecycle", updated_at_ms: 0, pid: null });
const states = [{ id: "active", label: "Active", order: 20 }, { id: "exploring", label: "Exploring", order: 10 }, { id: "merged", label: "Merged", order: 40 }];
const ctx: QueryContext = { repos: [{ id: "r1", name: "holly", path: "/r1", exists: true, remote_url: null, github: null }], agents: [agent("a", "waiting"), agent("b", "working")], attention: [], states };
const base = { query: "", filters: [], view: "list" as const, sort: "name" as const, group: "repo" as const, showArchived: false };
const list = [
  wt("a", { metadata: { display_name: null, project: "LR", state: "merged", tags: ["lr"] } }),
  wt("b", { metadata: { display_name: null, project: null, state: "exploring", tags: [] }, last_active_ms: 5 }),
  wt("c", { archived_at_ms: 10, first_seen_ms: 99 }),
];

describe("home query", () => {
  it("hides archived unless asked and ORs values within a kind, ANDs across kinds", () => {
    expect(filterWorktrees(list, base, ctx).map((w) => w.id)).toEqual(["a", "b"]);
    expect(filterWorktrees(list, { ...base, showArchived: true }, ctx)).toHaveLength(3);
    expect(filterWorktrees(list, { ...base, filters: [{ kind: "state", value: "merged" }, { kind: "state", value: "exploring" }] }, ctx)).toHaveLength(2);
    expect(filterWorktrees(list, { ...base, filters: [{ kind: "state", value: "exploring" }, { kind: "tag", value: "lr" }] }, ctx)).toHaveLength(0);
    expect(filterWorktrees(list, { ...base, filters: [{ kind: "agent", value: "waiting" }] }, ctx).map((w) => w.id)).toEqual(["a"]);
    expect(filterWorktrees(list, { ...base, filters: [{ kind: "archived", value: "yes" }] }, ctx).map((w) => w.id)).toEqual(["c"]);
    expect(filterWorktrees(list, { ...base, filters: [{ kind: "state", value: "merged" }] }, ctx).map((w) => w.id)).toEqual(["a"]);
    expect(filterWorktrees(list, { ...base, showArchived: true, filters: [{ kind: "state", value: "" }] }, ctx).map((w) => w.id)).toEqual(["c"]);
    expect(filterWorktrees(list, { ...base, query: "LR" }, ctx).map((w) => w.id)).toEqual(["a"]);
    expect(filterWorktrees(list, { ...base, query: "explor" }, ctx).map((w) => w.id)).toEqual(["b"]);
  });

  it("sorts by attention, created, state", () => {
    expect(sortWorktrees(list, "attention", ctx).map((w) => w.id)).toEqual(["a", "b", "c"]);
    expect(sortWorktrees(list, "created", ctx).map((w) => w.id)).toEqual(["c", "a", "b"]);
    expect(sortWorktrees(list, "state", ctx).map((w) => w.id)).toEqual(["b", "a", "c"]);
  });

  it("groups by none into one group", () => {
    expect(groupWorktrees(list, "none", ctx)).toHaveLength(1);
  });

  it("groups by state in config order with empty columns kept and no state last", () => {
    expect(groupWorktrees(list, "state", ctx).map((g) => g.key)).toEqual(["Exploring", "Active", "Merged", "no state"]);
    expect(groupWorktrees(list, "state", ctx).map((g) => g.items.map((w) => w.id))).toEqual([["b"], [], ["a"], ["c"]]);
    expect(groupWorktrees([wt("x", { metadata: { display_name: null, project: null, state: "ghost", tags: [] } })], "state", ctx).map((g) => g.key)).toEqual(["Exploring", "Active", "Merged", "ghost"]);
  });
});
