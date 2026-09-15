import type { AgentationActivity } from "../../generated";
import type { ActivityKindView } from "../types";

export const agentationActivity: Record<AgentationActivity, ActivityKindView> = {
  annotations_sent: { who: () => "You" },
};
