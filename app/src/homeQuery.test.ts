import { describe, expect, it } from "vitest";
import { NO_TAG, filterWorktrees, groupWorktrees, movedTags, sortWorktrees, type QueryContext } from "./homeQuery";
import type { AgentPresence, Worktree } from "./types";

function wt(id: string, extra: Partial<Worktree> = {}): Worktree {
  return {
    id, repo_id: "r1", path: `/w/${id}`, name: id, branch: "main", head: "abc", detached: false, is_main: false, exists: true, git: null,
    metadata: { display_name: null, tags: [] }, last_active_ms: null, first_seen_ms: null, archived_at_ms: null, archiving: false, tab_count: 0, pane_count: 0, ...extra,
  };
}
const agent = (worktree_id: string, state: AgentPresence["state"]): AgentPresence => ({ pane_id: `p-${worktree_id}`, worktree_id, kind: "claude", state, session_ref: null, authority: "lifecycle", updated_at_ms: 0, pid: null });
const ctx: QueryContext = { repos: [{ id: "r1", name: "holly", path: "/r1", exists: true, remote_url: null }], agents: [agent("a", "waiting"), agent("b", "working")], attention: [] };
const base = { query: "", scope: { kind: "all" as const }, filters: [], view: "list" as const, sort: "name" as const, group: "repo" as const, showArchived: false };
const list = [
  wt("a", { metadata: { display_name: null, tags: ["lr", "merged"] } }),
  wt("b", { metadata: { display_name: null, tags: ["exploring"] }, last_active_ms: 5 }),
  wt("c", { archived_at_ms: 10, first_seen_ms: 99 }),
];

describe("home query", () => {
  it("hides archived unless asked and ORs values within a kind, ANDs across kinds", () => {
    expect(filterWorktrees(list, base, ctx).map((w) => w.id)).toEqual(["a", "b"]);
    expect(filterWorktrees(list, { ...base, showArchived: true }, ctx)).toHaveLength(3);
    expect(filterWorktrees(list, { ...base, filters: [{ kind: "tag", value: "merged" }, { kind: "tag", value: "exploring" }] }, ctx)).toHaveLength(2);
    expect(filterWorktrees(list, { ...base, filters: [{ kind: "tag", value: "exploring" }, { kind: "agent", value: "waiting" }] }, ctx)).toHaveLength(0);
    expect(filterWorktrees(list, { ...base, filters: [{ kind: "agent", value: "waiting" }] }, ctx).map((w) => w.id)).toEqual(["a"]);
    expect(filterWorktrees(list, { ...base, filters: [{ kind: "archived", value: "yes" }] }, ctx).map((w) => w.id)).toEqual(["c"]);
    expect(filterWorktrees(list, { ...base, query: "LR" }, ctx).map((w) => w.id)).toEqual(["a"]);
    expect(filterWorktrees(list, { ...base, query: "explor" }, ctx).map((w) => w.id)).toEqual(["b"]);
  });

  it("sorts by attention and created", () => {
    expect(sortWorktrees(list, "attention", ctx).map((w) => w.id)).toEqual(["a", "b", "c"]);
    expect(sortWorktrees(list, "created", ctx).map((w) => w.id)).toEqual(["c", "a", "b"]);
  });

  it("groups by none into one group", () => {
    expect(groupWorktrees(list, "none", ctx)).toHaveLength(1);
  });

  it("moves a board card from one tag column to another", () => {
    expect(movedTags(["lr", "review"], "#review", "#merged")).toEqual(["lr", "merged"]);
    expect(movedTags([], NO_TAG, "#lr")).toEqual(["lr"]);
    expect(movedTags(["lr", "merged"], "#lr", "#merged")).toEqual(["merged"]);
    expect(movedTags(["lr"], "#lr", NO_TAG)).toEqual([]);
  });

  it("puts a worktree under each of its tags, with no tag last", () => {
    expect(groupWorktrees(list, "tag", ctx).map((g) => [g.key, g.items.map((w) => w.id)])).toEqual([["#exploring", ["b"]], ["#lr", ["a"]], ["#merged", ["a"]], ["no tag", ["c"]]]);
  });
});
