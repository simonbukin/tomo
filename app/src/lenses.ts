import { byManualOrder } from "./order";
import { agentsOf, needsAttention, sortWorktrees, type QueryContext } from "./homeQuery";
import type { Id, Repo, SidebarLens, SidebarSort, Worktree, WorktreePrefill } from "./types";

export const LENSES: readonly SidebarLens[] = ["repo", "tag", "focus"];

export const LENS_LABEL: Record<SidebarLens, string> = {
  repo: "repositories",
  tag: "tags",
  focus: "focus",
};

export interface LensGroup {
  /** Unique within a lens. The collapse key, and the React key. */
  key: string;
  label: string;
  items: Worktree[];
  /** Set only in the repository lens, where a group is a real repository. */
  repo: Repo | null;
  /** What a new worktree made from this group starts with. */
  prefill: WorktreePrefill;
}

export interface LensOptions {
  repos: Repo[];
  sort: SidebarSort;
  manualOrder: Record<string, Id[]>;
  repoOrder: Id[];
}

const NO_TAG = "no tag";

export const FOCUS_SECTIONS = ["needs attention", "active", "recent", "archived"] as const;

const OTHER_REPO: Repo = { id: "", path: "", name: "other", exists: true, remote_url: null };

function focusSection(w: Worktree, ctx: QueryContext): string {
  if (w.archived_at_ms) return "archived";
  if (needsAttention(w, ctx)) return "needs attention";
  if (agentsOf(ctx.agents, w.id).length > 0) return "active";
  return "recent";
}

function byRepo(list: Worktree[], ctx: QueryContext, o: LensOptions): LensGroup[] {
  const ordered = o.sort === "manual" ? byManualOrder(o.repos, o.repoOrder, (r) => r.id) : o.repos;
  const groups = ordered
    .map((repo) => ({
      key: repo.id,
      label: repo.name,
      repo,
      prefill: { repoId: repo.id },
      items: sortWorktrees(list.filter((w) => w.repo_id === repo.id), o.sort, ctx, o.manualOrder[repo.id] ?? []),
    }))
    .filter((g) => g.items.length > 0 || !g.repo.exists);
  const orphans = sortWorktrees(list.filter((w) => !o.repos.some((r) => r.id === w.repo_id)), o.sort, ctx);
  return orphans.length > 0 ? [...groups, { key: "", label: OTHER_REPO.name, repo: OTHER_REPO, prefill: {}, items: orphans }] : groups;
}

function bucket(list: Worktree[], keyOf: (w: Worktree) => string[]): Map<string, Worktree[]> {
  const map = new Map<string, Worktree[]>();
  for (const w of list) for (const key of keyOf(w)) map.set(key, [...(map.get(key) ?? []), w]);
  return map;
}

function labelled(
  map: Map<string, Worktree[]>,
  lens: SidebarLens,
  ctx: QueryContext,
  o: LensOptions,
  label: (key: string) => string,
  rank: (key: string, items: Worktree[]) => number,
  prefill: (key: string) => WorktreePrefill = () => ({}),
): LensGroup[] {
  return [...map.entries()]
    .sort(([ka, ia], [kb, ib]) => rank(ka, ia) - rank(kb, ib) || ka.localeCompare(kb))
    .map(([key, items]) => ({ key: `${lens}:${key}`, label: label(key), repo: null, prefill: prefill(key), items: sortWorktrees(items, o.sort, ctx) }));
}

/**
 * Arrange the same worktrees a different way. A lens filters and groups only; it
 * never reads or writes worktree state, and it adds no object of its own.
 */
export function lensGroups(list: Worktree[], lens: SidebarLens, ctx: QueryContext, o: LensOptions): LensGroup[] {
  switch (lens) {
    case "repo":
      return byRepo(list, ctx, o);
    case "tag":
      return labelled(bucket(list, (w) => (w.metadata.tags.length > 0 ? w.metadata.tags : [NO_TAG])), lens, ctx, o, (k) => (k === NO_TAG ? k : `#${k}`), (k, items) => (k === NO_TAG ? Number.MAX_SAFE_INTEGER : -items.length), (k) => (k === NO_TAG ? {} : { tags: [k] }));
    case "focus":
      return labelled(bucket(list, (w) => [focusSection(w, ctx)]), lens, ctx, o, (k) => k, (k) => FOCUS_SECTIONS.indexOf(k as (typeof FOCUS_SECTIONS)[number]));
  }
}
