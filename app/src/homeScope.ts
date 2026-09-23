import { agentsOf, needsAttention, repoName, type QueryContext } from "./homeQuery";
import type { AppRow } from "./appsModel";
import type { HomeScope, Repo, Worktree } from "./types";

export const ALL: HomeScope = { kind: "all" };

export function sameScope(a: HomeScope, b: HomeScope): boolean {
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case "all":
      return true;
    case "repo":
      return a.repoId === (b as { repoId: string }).repoId;
    case "tag":
      return a.tag === (b as { tag: string }).tag;
  }
}

/** The worktrees a scope covers. Every scope reads fields the worktree already has. */
export function scopeWorktrees(list: Worktree[], scope: HomeScope): Worktree[] {
  switch (scope.kind) {
    case "all":
      return list;
    case "repo":
      return list.filter((w) => w.repo_id === scope.repoId);
    case "tag":
      return list.filter((w) => w.metadata.tags.includes(scope.tag));
  }
}

export function scopeTitle(scope: HomeScope, repos: Repo[]): string {
  switch (scope.kind) {
    case "all":
      return "all work";
    case "repo":
      return repoName(repos, scope.repoId);
    case "tag":
      return `#${scope.tag}`;
  }
}

export function scopeKind(scope: HomeScope): string {
  return scope.kind === "all" ? "" : scope.kind === "repo" ? "repository" : scope.kind;
}

export interface Tally {
  worktrees: number;
  agents: number;
  apps: number;
  attention: number;
  lastActiveMs: number | null;
}

/** Apps arrive from the caller, because only an addon finds a running app. With none, the count is zero. */
export function tally(list: Worktree[], ctx: QueryContext, apps: readonly AppRow[] = []): Tally {
  const live = list.filter((w) => !w.archived_at_ms);
  const ids = new Set(live.map((w) => w.id));
  const times = live.map((w) => w.last_active_ms).filter((t): t is number => typeof t === "number");
  return {
    worktrees: live.length,
    agents: live.reduce((n, w) => n + agentsOf(ctx.agents, w.id).length, 0),
    apps: apps.filter((a) => ids.has(a.worktreeId)).length,
    attention: live.filter((w) => needsAttention(w, ctx)).length,
    lastActiveMs: times.length > 0 ? Math.max(...times) : null,
  };
}

/** The hour comes from the caller, so the greeting stays a plain function of its input. */
export function greeting(hour: number): string {
  if (hour < 5) return "Still up.";
  if (hour < 12) return "Good morning.";
  if (hour < 18) return "Good afternoon.";
  return "Good evening.";
}

export function statusLine(t: Tally): string {
  if (t.worktrees === 0) return "Nothing active.";
  const active = `${t.worktrees} ${t.worktrees === 1 ? "worktree" : "worktrees"} active.`;
  if (t.attention === 0) return active;
  return `${active} ${t.attention} ${t.attention === 1 ? "needs" : "need"} your attention.`;
}

export interface RepoSummary extends Tally {
  repo: Repo;
}

/**
 * One row per repository for the global overview. A repository with no live
 * worktree still appears, because an empty repository is a real fact about the
 * workspace, not an absence to hide.
 */
export function repoSummaries(list: Worktree[], repos: Repo[], ctx: QueryContext, apps: readonly AppRow[] = []): RepoSummary[] {
  return repos
    .map((repo) => ({ repo, ...tally(scopeWorktrees(list, { kind: "repo", repoId: repo.id }), ctx, apps) }))
    .sort((a, b) => (b.lastActiveMs ?? 0) - (a.lastActiveMs ?? 0) || a.repo.name.localeCompare(b.repo.name));
}
