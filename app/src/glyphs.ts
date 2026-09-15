import type { ActivityKind, AgentState } from "./types";

/** The one status vocabulary: sidebar, Home, tabs, Activity, palette, and previews all map to it. */
export type Status = "working" | "needs" | "idle" | "complete" | "failed" | "unknown";

export const GLYPH: Record<Status, string> = { working: "●", needs: "◉", idle: "○", complete: "✓", failed: "×", unknown: "?" };

const DOT: Record<Status, string> = { working: "state-working", needs: "state-waiting", idle: "state-idle", complete: "state-ok", failed: "state-fail", unknown: "state-unknown" };

const AGENT: Record<AgentState | "none", Status | null> = { working: "working", waiting: "needs", idle: "idle", exited: "idle", unknown: "unknown", none: null };

const ACTIVITY: Partial<Record<ActivityKind, Status>> = {
  agent_started: "working",
  agent_waiting: "needs",
  agent_exited: "idle",
  checkpoint_created: "needs",
  checkpoint_resolved: "complete",
  action_started: "working",
  action_stopped: "idle",
  action_completed: "complete",
  action_crashed: "failed",
  hook_failed: "failed",
  pr_merged: "complete",
};

export const agentStatus = (state: AgentState | "none"): Status | null => AGENT[state];

export const activityStatus = (kind: ActivityKind): Status | null => ACTIVITY[kind] ?? null;

/** Classes for the round status dot that stands for the glyph in dense rows. */
export const dotClass = (status: Status | null): string => `state ${status ? DOT[status] : "state-none"}`;
