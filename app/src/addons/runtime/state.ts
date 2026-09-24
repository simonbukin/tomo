import type { RuntimeEndpoint } from "../../generated";
import { setState, type State } from "../../store";
import type { Frame, Id, Snapshot } from "../../types";

declare module "../../store" {
  interface State {
    /** The endpoints of each worktree that has one. The Runtime addon declares this key and is its only writer. */
    endpoints?: Record<Id, RuntimeEndpoint[]>;
  }
}

export const endpointsOf = (s: State, worktreeId: Id): RuntimeEndpoint[] => s.endpoints?.[worktreeId] ?? [];

export function replaceEndpoints(snapshot: Snapshot): void {
  const byWorktree = (snapshot.endpoints ?? []).reduce<Record<Id, RuntimeEndpoint[]>>((out, e) => ({ ...out, [e.worktree_id]: [...(out[e.worktree_id] ?? []), e] }), {});
  setState({ endpoints: byWorktree });
}

export function applyRuntimeFrame(frame: Frame): void {
  if (frame.event !== "endpoints_changed") return;
  const { worktree_id, endpoints } = frame.data as { worktree_id: Id; endpoints: RuntimeEndpoint[] };
  setState((s) => {
    const { [worktree_id]: _, ...rest } = s.endpoints ?? {};
    return { endpoints: endpoints.length ? { ...s.endpoints, [worktree_id]: endpoints } : rest };
  });
}
