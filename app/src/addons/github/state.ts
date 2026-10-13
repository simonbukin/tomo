import type { PrStatusResult, PullRequest } from "../../generated";
import { setState, type State } from "../../store";
import type { Frame, Id } from "../../types";

declare module "../../store" {
  interface State {
    /** The last `pr_status` answer for each worktree. The GitHub addon declares this key and is its only writer. */
    prs?: Record<Id, PrStatusResult>;
  }
}

export const prStatusOf = (s: State, worktreeId: Id): PrStatusResult | undefined => s.prs?.[worktreeId];

export const prOf = (s: State, worktreeId: Id): PullRequest | null => prStatusOf(s, worktreeId)?.pr ?? null;

/** Every pull request of the worktree, newest first. An answer from a daemon before `prs` gives its one `pr`. */
export function prsOf(s: State, worktreeId: Id): PullRequest[] {
  const status = prStatusOf(s, worktreeId);
  if (status?.prs.length) return status.prs;
  return status?.pr ? [status.pr] : [];
}

export function setPrStatus(worktreeId: Id, status: PrStatusResult): void {
  setState((s) => ({ prs: { ...s.prs, [worktreeId]: status } }));
}

export function applyGitHubFrame(frame: Frame): void {
  if (frame.event !== "pr_changed") return;
  const { worktree_id, pr, prs } = frame.data as { worktree_id: Id; pr: PullRequest | null; prs: PullRequest[] };
  setPrStatus(worktree_id, { available: true, reason: null, pr, prs });
}
