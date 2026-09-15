export type HomeEmpty = "no-repos" | "no-worktrees" | "no-matches" | null;

export function homeEmpty(repoCount: number, activeCount: number, visibleCount: number): HomeEmpty {
  if (repoCount === 0) return "no-repos";
  if (activeCount === 0 && visibleCount === 0) return "no-worktrees";
  if (visibleCount === 0) return "no-matches";
  return null;
}

export type ActivityFilter = "all" | "needs_me" | "worktree";

const ACTIVITY_EMPTY: Record<ActivityFilter, string> = {
  all: "No activity yet.",
  needs_me: "Nothing needs you.",
  worktree: "Nothing happened in this worktree yet.",
};

export function activityEmptyText(filter: ActivityFilter): string {
  return ACTIVITY_EMPTY[filter];
}

export function townsProgress(have: number, total: number): string {
  return `${have} / ${total} municipalities unlocked.`;
}
