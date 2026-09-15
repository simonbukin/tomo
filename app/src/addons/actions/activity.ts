import { restartWorktreeAction } from "../../actions";
import { goToPane } from "../../activityKinds";
import { payloadString } from "../../activityModel";
import type { ActionActivity, ActivityEvent } from "../../generated";
import type { State } from "../../store";
import type { ActivityKindView, ActivityRowAction } from "../types";

const actionId = (e: ActivityEvent) => payloadString(e, "action_id");

const who = (e: ActivityEvent, s: State) =>
  (e.worktree_id ? s.actions[e.worktree_id]?.actions : undefined)?.find((a) => a.id === actionId(e))?.label ?? payloadString(e, "label") ?? actionId(e) ?? "action";

const logs: ActivityRowAction = { label: (e, s) => (e.pane_id && s.panes[e.pane_id] ? "Logs" : null), run: (e) => goToPane(e) };

const restart: ActivityRowAction = {
  label: (e) => (e.worktree_id && actionId(e) ? "Restart" : null),
  run: (e) => e.worktree_id && actionId(e) && restartWorktreeAction(e.worktree_id, actionId(e)!),
};

export const actionsActivity: Record<ActionActivity, ActivityKindView> = {
  action_started: { status: "working", who },
  action_stopped: { status: "idle", who, actions: [restart] },
  action_completed: { status: "complete", who },
  action_crashed: { status: "failed", who, actions: [logs, restart] },
};
