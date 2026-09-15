import { appUrl } from "../../activityKinds";
import { payloadString } from "../../activityModel";
import type { ActivityEvent, RuntimeActivity } from "../../generated";
import type { State } from "../../store";
import type { ActivityKindView } from "../types";

const who = (e: ActivityEvent, s: State) => {
  const actionId = payloadString(e, "action_id");
  return (e.worktree_id ? s.actions[e.worktree_id]?.actions : undefined)?.find((a) => a.id === actionId)?.label ?? payloadString(e, "label") ?? actionId ?? "action";
};

export const runtimeActivity: Record<RuntimeActivity, ActivityKindView> = {
  endpoint_discovered: { who, url: (e, s) => appUrl(e, s) },
};
