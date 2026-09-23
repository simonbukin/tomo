import { byManualOrder, mainFirst } from "./order";
import { needsMeItem } from "./activityModel";
import type { AgentPresence, AttentionItem, Filter, HomeOptions, Repo, SidebarSort, Worktree } from "./types";

export interface QueryContext {
  repos: Repo[];
  agents: AgentPresence[];
  attention: AttentionItem[];
}

export const NO_TAG = "no tag";

export function repoName(repos: Repo[], repoId: string): string {
  return repos.find((r) => r.id === repoId)?.name ?? "?";
}

export function agentsOf(agents: AgentPresence[], worktreeId: string): AgentPresence[] {
  return agents.filter((a) => a.worktree_id === worktreeId && a.state !== "exited");
}

export function needsAttention(w: Worktree, ctx: QueryContext): boolean {
  return agentsOf(ctx.agents, w.id).some((a) => a.state === "waiting") || ctx.attention.some((a) => a.worktree_id === w.id && needsMeItem(a, ctx.agents));
}

function agentStateOf(w: Worktree, ctx: QueryContext): string {
  const list = agentsOf(ctx.agents, w.id);
  if (list.some((a) => a.state === "waiting")) return "waiting";
  if (list.some((a) => a.state === "working")) return "working";
  if (list.some((a) => a.state === "idle")) return "idle";
  return "none";
}

export function matchesFilter(w: Worktree, f: Filter, ctx: QueryContext): boolean {
  switch (f.kind) {
    case "repo":
      return w.repo_id === f.value;
    case "tag":
      return w.metadata.tags.includes(f.value);
    case "agent":
      return agentStateOf(w, ctx) === f.value;
    case "archived":
      return (f.value === "yes") === !!w.archived_at_ms;
    case "attention":
      return needsAttention(w, ctx);
  }
}

export function matchesQuery(w: Worktree, query: string, ctx: QueryContext): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const hay = [w.name, w.branch ?? "", w.metadata.tags.join(" "), repoName(ctx.repos, w.repo_id), w.path]
    .join(" ")
    .toLowerCase();
  return hay.includes(q);
}

export function filterWorktrees(list: Worktree[], o: HomeOptions, ctx: QueryContext): Worktree[] {
  const explicitArchived = o.filters.some((f) => f.kind === "archived");
  return list.filter((w) => {
    if (!o.showArchived && !explicitArchived && w.archived_at_ms) return false;
    if (!matchesQuery(w, o.query, ctx)) return false;
    const byKind = new Map<string, Filter[]>();
    for (const f of o.filters) byKind.set(f.kind, [...(byKind.get(f.kind) ?? []), f]);
    return [...byKind.values()].every((group) => group.some((f) => matchesFilter(w, f, ctx)));
  });
}

export function sortWorktrees(list: Worktree[], sort: HomeOptions["sort"] | SidebarSort, ctx: QueryContext, manual: string[] = []): Worktree[] {
  if (sort === "manual") return mainFirst(byManualOrder(list, manual, (w) => w.id));
  const rank = (w: Worktree) => (needsAttention(w, ctx) ? 0 : agentStateOf(w, ctx) === "working" ? 1 : 2);
  const recent = (w: Worktree) => w.last_active_ms ?? 0;
  return mainFirst([...list].sort((a, b) => {
    switch (sort) {
      case "name":
        return a.name.localeCompare(b.name);
      case "recent":
        return recent(b) - recent(a) || a.name.localeCompare(b.name);
      case "created":
        return (b.first_seen_ms ?? 0) - (a.first_seen_ms ?? 0) || a.name.localeCompare(b.name);
      case "attention":
        return rank(a) - rank(b) || recent(b) - recent(a) || a.name.localeCompare(b.name);
    }
  }));
}

/** The tags after a board drag from the column `from` to the column `to`. Column keys are `#tag` or `NO_TAG`. */
export function movedTags(tags: readonly string[], from: string, to: string): string[] {
  const tagOf = (key: string) => (key === NO_TAG ? null : key.replace(/^#/, ""));
  const [source, target] = [tagOf(from), tagOf(to)];
  const kept = tags.filter((t) => t !== source);
  return target === null || kept.includes(target) ? kept : [...kept, target];
}

/** A worktree belongs to each of its tags, and to one group of every other grouping. */
export function groupKeys(w: Worktree, group: HomeOptions["group"], ctx: QueryContext): string[] {
  switch (group) {
    case "tag":
      return w.metadata.tags.length > 0 ? w.metadata.tags.map((t) => `#${t}`) : [NO_TAG];
    case "repo":
      return [repoName(ctx.repos, w.repo_id)];
    case "none":
      return [""];
  }
}

export function groupWorktrees(list: Worktree[], group: HomeOptions["group"], ctx: QueryContext): { key: string; items: Worktree[] }[] {
  const map = new Map<string, Worktree[]>();
  for (const w of list) {
    for (const key of groupKeys(w, group, ctx)) map.set(key, [...(map.get(key) ?? []), w]);
  }
  const keys = [...map.keys()].sort((a, b) => {
    if (a.startsWith("no ")) return 1;
    if (b.startsWith("no ")) return -1;
    return a.localeCompare(b);
  });
  return keys.map((key) => ({ key, items: map.get(key) ?? [] }));
}
