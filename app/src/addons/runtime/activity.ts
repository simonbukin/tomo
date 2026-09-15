import { appUrl } from "../../activityKinds";
import { payloadString } from "../../activityModel";
import type { ActivityEvent, RuntimeActivity } from "../../generated";
import type { State } from "../../store";
import type { ActivityKindView } from "../types";

const who = (e: ActivityEvent, s: State) => (e.pane_id ? s.panes[e.pane_id]?.source?.label : undefined) ?? payloadString(e, "label") ?? payloadString(e, "action_id") ?? "action";

export const runtimeActivity: Record<RuntimeActivity, ActivityKindView> = {
  endpoint_discovered: { who, url: (e, s) => appUrl(e, s) },
};
