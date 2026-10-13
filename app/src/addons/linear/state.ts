import type { LinearIssue, LinearLink, LinearStatus } from "../../generated";
import { setState, type State } from "../../store";
import type { Frame, Id, Snapshot } from "../../types";

declare module "../../store" {
  interface State {
    /** The last Linear answer of the daemon. The Linear addon declares this key and is its only writer. */
    linear?: LinearStatus;
  }
}

export const linearLinksOf = (s: State, worktreeId: Id): LinearLink[] => (s.linear?.links ?? []).filter((l) => l.worktree_id === worktreeId);

/** The issue that the branch now names, else the one that the worktree touched last. */
export function linearIssueOf(s: State, worktreeId: Id): LinearIssue | null {
  const links = linearLinksOf(s, worktreeId);
  const newest = [...links].sort((a, b) => b.touched_ms - a.touched_ms)[0];
  return (links.find((l) => l.current) ?? newest)?.issue ?? null;
}

export const replaceLinear = (snapshot: Snapshot): void => setState({ linear: snapshot.linear });

export function applyLinearFrame(frame: Frame): void {
  if (frame.event === "linear_changed") setState({ linear: (frame.data as { status: LinearStatus }).status });
}
