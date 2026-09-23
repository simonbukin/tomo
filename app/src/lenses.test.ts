import { describe, expect, it } from "vitest";
import { FOCUS_SECTIONS, LENSES, lensGroups, tagPrefill, type LensOptions } from "./lenses";
import type { QueryContext } from "./homeQuery";
import type { AgentPresence, AgentState, Repo, Worktree } from "./types";

const wt = (over: Partial<Worktree> & { id: string }): Worktree => ({
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

const repo = (id: string, over: Partial<Repo> = {}): Repo => ({ id, path: `/r/${id}`, name: id, exists: true, remote_url: null, ...over });

const agent = (worktree_id: string, state: AgentState) =>
  ({ pane_id: `p-${worktree_id}-${state}`, worktree_id, kind: "claude", state, session_ref: null, updated_at_ms: 0, pid: null }) as unknown as AgentPresence;

const ctx = (over: Partial<QueryContext> = {}): QueryContext => ({ repos: [], agents: [], attention: [], ...over });
const opts = (over: Partial<LensOptions> = {}): LensOptions => ({ repos: [], sort: "name", manualOrder: {}, repoOrder: [], ...over });

const labels = (groups: { label: string }[]) => groups.map((g) => g.label);
const names = (groups: { items: Worktree[] }[]) => groups.map((g) => g.items.map((w) => w.name));

describe("repository lens", () => {
  it("groups worktrees under their repository", () => {
    const repos = [repo("r1", { name: "tomo" }), repo("r2", { name: "labor" })];
    const list = [wt({ id: "a", repo_id: "r1" }), wt({ id: "b", repo_id: "r2" }), wt({ id: "c", repo_id: "r1" })];
    const groups = lensGroups(list, "repo", ctx({ repos }), opts({ repos }));
    expect(labels(groups)).toEqual(["tomo", "labor"]);
    expect(names(groups)).toEqual([["a", "c"], ["b"]]);
    expect(groups[0].repo?.id).toBe("r1");
  });

  it("collects worktrees with no known repository under other", () => {
    const repos = [repo("r1")];
    const groups = lensGroups([wt({ id: "a", repo_id: "r1" }), wt({ id: "lost", repo_id: "gone" })], "repo", ctx({ repos }), opts({ repos }));
    expect(labels(groups)).toEqual(["r1", "other"]);
    expect(groups[1].items.map((w) => w.name)).toEqual(["lost"]);
  });

  it("keeps a missing repository that has no worktrees", () => {
    const repos = [repo("r1", { exists: false })];
    expect(labels(lensGroups([], "repo", ctx({ repos }), opts({ repos })))).toEqual(["r1"]);
  });

  it("drops an existing repository that has no worktrees", () => {
    const repos = [repo("r1"), repo("r2")];
    const groups = lensGroups([wt({ id: "a", repo_id: "r1" })], "repo", ctx({ repos }), opts({ repos }));
    expect(labels(groups)).toEqual(["r1"]);
  });
});

describe("tag lens", () => {
  it("lists a worktree under each of its tags", () => {
    const list = [wt({ id: "a", metadata: { tags: ["design", "infra"] } as Worktree["metadata"] }), wt({ id: "b", metadata: { tags: ["design"] } as Worktree["metadata"] })];
    const groups = lensGroups(list, "tag", ctx(), opts());
    expect(labels(groups)).toEqual(["#design", "#infra"]);
    expect(names(groups)).toEqual([["a", "b"], ["a"]]);
  });

  it("puts untagged worktrees last", () => {
    const list = [wt({ id: "a" }), wt({ id: "b", metadata: { tags: ["design"] } as Worktree["metadata"] })];
    expect(labels(lensGroups(list, "tag", ctx(), opts()))).toEqual(["#design", "no tag"]);
  });
});

describe("focus lens", () => {
  const list = [
    wt({ id: "quiet" }),
    wt({ id: "busy" }),
    wt({ id: "stuck" }),
    wt({ id: "old", archived_at_ms: 1 }),
  ];
  const context = ctx({ agents: [agent("busy", "working"), agent("stuck", "waiting")] });

  it("orders the sections and files each worktree once", () => {
    const groups = lensGroups(list, "focus", context, opts());
    expect(labels(groups)).toEqual(["needs attention", "active", "recent", "archived"]);
    expect(names(groups)).toEqual([["stuck"], ["busy"], ["quiet"], ["old"]]);
  });

  it("uses only the known sections", () => {
    for (const g of lensGroups(list, "focus", context, opts())) expect(FOCUS_SECTIONS).toContain(g.label);
  });

  it("hides an empty section", () => {
    const groups = lensGroups([wt({ id: "quiet" })], "focus", ctx(), opts());
    expect(labels(groups)).toEqual(["recent"]);
  });
});

describe("every lens", () => {
  const repos = [repo("r1")];
  const list = [wt({ id: "a" }), wt({ id: "b", metadata: { tags: ["t"] } as Worktree["metadata"] })];

  it("gives every group a unique key", () => {
    for (const lens of LENSES) {
      const keys = lensGroups(list, lens, ctx({ repos }), opts({ repos })).map((g) => g.key);
      expect(new Set(keys).size).toBe(keys.length);
    }
  });

  it("shows every worktree at least once", () => {
    for (const lens of LENSES) {
      const shown = new Set(lensGroups(list, lens, ctx({ repos }), opts({ repos })).flatMap((g) => g.items.map((w) => w.id)));
      expect(shown).toEqual(new Set(["a", "b"]));
    }
  });

  it("returns no group for no worktrees, except a missing repository", () => {
    for (const lens of LENSES) expect(lensGroups([], lens, ctx(), opts())).toEqual([]);
  });

  it("starts a tag's new worktree in the repository its worktrees share, and in none when they differ", () => {
    const one = [wt({ id: "a", repo_id: "holly" }), wt({ id: "b", repo_id: "holly" })];
    expect(tagPrefill("labor", one)).toEqual({ repoId: "holly", tags: ["labor"] });
    expect(tagPrefill("labor", [...one, wt({ id: "c", repo_id: "tomo" })])).toEqual({ tags: ["labor"] });
  });

  it("prefills a new worktree with what its group has in common", () => {
    const prefills = (lens: (typeof LENSES)[number]) => lensGroups(list, lens, ctx({ repos }), opts({ repos })).map((g) => [g.label, g.prefill]);
    expect(prefills("repo")).toEqual([["r1", { repoId: "r1" }]]);
    expect(prefills("tag")).toEqual([["#t", { repoId: "r1", tags: ["t"] }], ["no tag", {}]]);
    expect(prefills("focus").every(([, p]) => JSON.stringify(p) === "{}")).toBe(true);
  });
});
