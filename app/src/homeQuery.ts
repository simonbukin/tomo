import type { AgentPresence, AttentionItem, Filter, HomeOptions, Repo, SidebarSort, StateDef, Worktree } from "./types";

export interface QueryContext {
  repos: Repo[];
  agents: AgentPresence[];
  attention: AttentionItem[];
  states: StateDef[];
}

export const NO_STATE = "no state";

export function orderedStates(states: StateDef[]): StateDef[] {
  return [...states].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
}

export function stateLabel(states: StateDef[], id: string | null | undefined): string | null {
  if (!id) return null;
  return states.find((s) => s.id === id)?.label ?? id;
}

function stateRank(states: StateDef[], id: string | null): number {
  if (!id) return Number.MAX_SAFE_INTEGER;
  const idx = orderedStates(states).findIndex((s) => s.id === id);
  return idx < 0 ? Number.MAX_SAFE_INTEGER - 1 : idx;
}

export function repoName(repos: Repo[], repoId: string): string {
  return repos.find((r) => r.id === repoId)?.name ?? "?";
}

export function agentsOf(agents: AgentPresence[], worktreeId: string): AgentPresence[] {
  return agents.filter((a) => a.worktree_id === worktreeId && a.state !== "exited");
}

export function needsAttention(w: Worktree, ctx: QueryContext): boolean {
  return agentsOf(ctx.agents, w.id).some((a) => a.state === "waiting") || ctx.attention.some((a) => a.worktree_id === w.id && !a.viewed_at_ms);
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
    case "state":
      return (w.metadata.state ?? "") === f.value;
    case "repo":
      return w.repo_id === f.value;
    case "project":
      return (w.metadata.project ?? "") === f.value;
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
  const hay = [w.name, w.branch ?? "", w.metadata.project ?? "", w.metadata.state ?? "", stateLabel(ctx.states, w.metadata.state) ?? "", w.metadata.tags.join(" "), repoName(ctx.repos, w.repo_id), w.path]
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

export function sortWorktrees(list: Worktree[], sort: HomeOptions["sort"] | SidebarSort, ctx: QueryContext): Worktree[] {
  const rank = (w: Worktree) => (needsAttention(w, ctx) ? 0 : agentStateOf(w, ctx) === "working" ? 1 : 2);
  const recent = (w: Worktree) => w.last_active_ms ?? 0;
  return [...list].sort((a, b) => {
    switch (sort) {
      case "name":
        return a.name.localeCompare(b.name);
      case "recent":
        return recent(b) - recent(a) || a.name.localeCompare(b.name);
      case "created":
        return (b.first_seen_ms ?? 0) - (a.first_seen_ms ?? 0) || a.name.localeCompare(b.name);
      case "attention":
        return rank(a) - rank(b) || recent(b) - recent(a) || a.name.localeCompare(b.name);
      case "state":
        return stateRank(ctx.states, a.metadata.state) - stateRank(ctx.states, b.metadata.state) || recent(b) - recent(a) || a.name.localeCompare(b.name);
    }
  });
}

export function groupKey(w: Worktree, group: HomeOptions["group"], ctx: QueryContext): string {
  switch (group) {
    case "state":
      return stateLabel(ctx.states, w.metadata.state) ?? NO_STATE;
    case "repo":
      return repoName(ctx.repos, w.repo_id);
    case "project":
      return w.metadata.project ?? "no project";
    case "none":
      return "";
  }
}

export function groupWorktrees(list: Worktree[], group: HomeOptions["group"], ctx: QueryContext): { key: string; items: Worktree[] }[] {
  const order = group === "state" ? [...orderedStates(ctx.states).map((s) => s.label), NO_STATE] : null;
  const map = new Map<string, Worktree[]>();
  if (group === "state") for (const key of order ?? []) map.set(key, []);
  for (const w of list) {
    const key = groupKey(w, group, ctx);
    map.set(key, [...(map.get(key) ?? []), w]);
  }
  const keys = [...map.keys()].sort((a, b) => {
    if (order) {
      const ia = order.indexOf(a);
      const ib = order.indexOf(b);
      return (ia < 0 ? order.length - 1 : ia) - (ib < 0 ? order.length - 1 : ib) || a.localeCompare(b);
    }
    if (a.startsWith("no ")) return 1;
    if (b.startsWith("no ")) return -1;
    return a.localeCompare(b);
  });
  return keys.map((key) => ({ key, items: map.get(key) ?? [] })).filter((g) => g.items.length > 0 || (group === "state" && g.key !== NO_STATE));
}
