import { endpointUrl, httpEndpoints } from "./activityModel";
import { focusPane, openWorktree, restoreWorktree } from "./actions";
import { addonActivity } from "./addons/activity";
import type { ActivityKindView, ActivityRowAction } from "./addons/types";
import type { CoreActivity } from "./generated";
import type { Status } from "./glyphs";
import { endpointsOf, type State } from "./store";
import { KIND_LABEL, type ActivityEvent } from "./types";

export function goToPane(e: ActivityEvent): void {
  if (e.worktree_id) openWorktree(e.worktree_id);
  if (e.pane_id) window.setTimeout(() => focusPane(e.pane_id!), 80);
}

/** The first HTTP endpoint of the event's worktree, for an "Open App" link. */
export function appUrl(e: ActivityEvent, s: State): string | null {
  const endpoint = e.worktree_id ? httpEndpoints(endpointsOf(s, e.worktree_id))[0] : undefined;
  return endpoint ? endpointUrl(endpoint) : null;
}

const you = () => "You";

const goToAgent: ActivityRowAction = {
  label: (e, s) => (e.agent_kind && e.pane_id && s.panes[e.pane_id] ? `Go to ${KIND_LABEL[e.agent_kind]}` : null),
  run: (e) => goToPane(e),
};

const restore: ActivityRowAction = {
  label: (e, s) => (s.worktrees.find((w) => w.id === e.worktree_id)?.archived_at_ms ? "Restore" : null),
  run: (e) => e.worktree_id && restoreWorktree(e.worktree_id),
};

const CORE_ACTIVITY: Record<CoreActivity, ActivityKindView> = {
  agent_started: { status: "working", actions: [goToAgent] },
  agent_waiting: { status: "needs", actions: [goToAgent] },
  agent_exited: { status: "idle", actions: [goToAgent] },
  checkpoint_created: { status: "needs", url: appUrl, actions: [goToAgent] },
  checkpoint_resolved: { status: "complete" },
  state_changed: { who: you },
  archived: { who: you, actions: [restore] },
  restored: { who: you },
  hook_failed: { status: "failed" },
};

const PLAIN: ActivityKindView = {};

/** Core kinds first, then the addons in `addonActivity` order. A kind that nobody knows renders as a plain row. */
export function activityView(kind: string): ActivityKindView {
  return (CORE_ACTIVITY as Record<string, ActivityKindView>)[kind] ?? addonActivity.find((views) => views[kind])?.[kind] ?? PLAIN;
}

export const activityStatus = (kind: string): Status | null => activityView(kind).status ?? null;
