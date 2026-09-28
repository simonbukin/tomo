import type { LinearIssue, LinearStatus } from "../../generated";
import { setState, type State } from "../../store";
import type { Frame, Id, Snapshot } from "../../types";

declare module "../../store" {
  interface State {
    /** The last Linear answer of the daemon. The Linear addon declares this key and is its only writer. */
    linear?: LinearStatus;
  }
}

export const linearIssueOf = (s: State, worktreeId: Id): LinearIssue | null => s.linear?.links.find((l) => l.worktree_id === worktreeId)?.issue ?? null;

export const replaceLinear = (snapshot: Snapshot): void => setState({ linear: snapshot.linear });

export function applyLinearFrame(frame: Frame): void {
  if (frame.event === "linear_changed") setState({ linear: (frame.data as { status: LinearStatus }).status });
}
