import type { AgentState } from "./types";

/** The one status vocabulary: sidebar, Home, tabs, Activity, palette, and previews all map to it. */
export type Status = "working" | "needs" | "idle" | "complete" | "failed" | "unknown";

export const GLYPH: Record<Status, string> = { working: "●", needs: "◉", idle: "○", complete: "✓", failed: "×", unknown: "?" };

const DOT: Record<Status, string> = { working: "state-working", needs: "state-waiting", idle: "state-idle", complete: "state-ok", failed: "state-fail", unknown: "state-unknown" };

const AGENT: Record<AgentState | "none", Status | null> = { working: "working", waiting: "needs", idle: "idle", exited: "idle", unknown: "unknown", none: null };

export const agentStatus = (state: AgentState | "none"): Status | null => AGENT[state];

/** Classes for the round status dot that stands for the glyph in dense rows. */
export const dotClass = (status: Status | null): string => `state ${status ? DOT[status] : "state-none"}`;

/** How a branch stands with its upstream. An addon that watches the branch picks one. */
export type BranchTone = "open" | "closed" | "merged" | "pending" | "failed";

const TINT: Record<Status, string> = { working: "tint-working", needs: "tint-needs", idle: "tint-idle", complete: "tint-ok", failed: "tint-fail", unknown: "tint-unknown" };

/** Colors an icon by status, the way `dotClass` colors a dot. */
export const tintClass = (status: Status | null): string => (status ? TINT[status] : "tint-none");
