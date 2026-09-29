import { durationLabel } from "./previewModel";
import type { AgentPresence, AgentState, Pane, Subagent } from "./types";

/**
 * The one status vocabulary: sidebar, Home, tabs, Activity, palette, and previews all map to it.
 * `done` is a turn that nobody looked at yet; `complete` is work that ended, such as a merged PR or an Action that exited 0.
 * `sleeping` is an agent that Tomo ended after the idle period; `sleeping-done` slept after a turn that nobody looked at.
 */
export type Status = "working" | "needs" | "idle" | "done" | "complete" | "failed" | "unknown" | "sleeping" | "sleeping-done";

export const GLYPH: Record<Status, string> = { working: "●", needs: "◉", idle: "○", done: "■", complete: "✓", failed: "×", unknown: "?", sleeping: "z", "sleeping-done": "Z" };

const DOT: Record<Status, string> = {
  working: "state-working",
  needs: "state-waiting",
  idle: "state-idle",
  done: "state-done",
  complete: "state-complete",
  failed: "state-fail",
  unknown: "state-unknown",
  sleeping: "state-sleeping",
  "sleeping-done": "state-sleeping state-sleeping-done",
};

const AGENT: Record<AgentState | "none", Status | null> = { working: "working", waiting: "needs", done: "done", idle: "idle", dead: "failed", exited: "complete", unknown: "unknown", none: null };

export const agentStatus = (state: AgentState | "none"): Status | null => AGENT[state];

const running = (s: Subagent) => s.state === "working" || s.state === "waiting";

/** The state that an agent shows: a done or idle agent with a subagent that still runs is working. */
export function effectiveState(agent: Pick<AgentPresence, "state" | "subagents">): AgentState {
  const quiet = agent.state === "done" || agent.state === "idle";
  return quiet && (agent.subagents ?? []).some(running) ? "working" : agent.state;
}

/** The mark of an agent: the sleep icon while it sleeps or wakes, else the mark of its state. */
export function agentMark(agent: Pick<AgentPresence, "state" | "subagents" | "sleep">): Status | null {
  if (agent.sleep) return agent.state === "done" ? "sleeping-done" : "sleeping";
  return agentStatus(effectiveState(agent));
}

/** A finished subagent reports `exited`; its mark is a still green square, like a finished turn. */
export const subagentStatus = (state: AgentState): Status | null => (state === "exited" ? "done" : agentStatus(state));

/** What each mark means, for the tooltip and the accessible name of a mark. */
export const STATUS_LABEL: Record<Status, string> = {
  working: "working",
  needs: "needs you",
  idle: "idle",
  done: "done",
  complete: "complete",
  failed: "dead",
  unknown: "no signal",
  sleeping: "sleeping",
  "sleeping-done": "sleeping · done",
};

/** The tooltip of an agent mark: the state, and when it matters, for how long or why. */
export function agentTitle(agent: Pick<AgentPresence, "state" | "subagents" | "updated_at_ms" | "estimated" | "sleep">, now = Date.now()): string {
  const state = effectiveState(agent);
  const since = durationLabel(agent.updated_at_ms, now);
  if (agent.sleep === "waking") return "waking";
  if (agent.sleep) return `sleeping · ${state === "done" ? "done" : "idle"} ${since} · a key wakes it`;
  const text: Partial<Record<AgentState, string>> = {
    working: `working · ${since}`,
    done: `done · finished ${since} ago`,
    dead: "dead · exited",
    unknown: "no signal · run `tomo integrations install`",
  };
  const label = text[state] ?? STATUS_LABEL[agentStatus(state) ?? "unknown"];
  return agent.estimated && state !== "unknown" ? `${label} (estimated from CPU)` : label;
}

/** The `source.kind` of a pane that a pane-mode hook started. */
export const HOOK_SOURCE = "hook";

type HookPane = Pick<Pane, "source" | "hook_exit_code" | "exit_code" | "live">;

/** The mark of a pane-mode hook: working while its command runs, done on exit 0, dead on another exit. Other panes have none. */
export function hookStatus(pane: HookPane): Status | null {
  if (pane.source?.kind !== HOOK_SOURCE) return null;
  const code = pane.hook_exit_code ?? pane.exit_code;
  if (code === null) return pane.live ? "working" : null;
  return code === 0 ? "done" : "failed";
}

export function hookTitle(pane: HookPane): string | undefined {
  const status = hookStatus(pane);
  const code = pane.hook_exit_code ?? pane.exit_code;
  if (status === "working") return "hook running";
  return status ? `hook exited ${code}` : undefined;
}

/** Classes for the status square that stands for the glyph in dense rows. */
export const dotClass = (status: Status | null): string => `state ${status ? DOT[status] : "state-none"}`;

/** The live mark of a worktree or an agent: a status, the archive in progress, or nothing. */
export type Mark = Status | "archiving" | null;

/** The tooltip of a live mark: its meaning, unless `title` says more. */
export const markTitle = (mark: Mark, title?: string): string | undefined =>
  mark === "archiving" ? "archiving" : mark ? (title ?? STATUS_LABEL[mark]) : undefined;

/** How a branch stands with its upstream. An addon that watches the branch picks one. */
export type BranchTone = "open" | "closed" | "merged" | "pending" | "failed";

const TINT: Record<Status, string> = {
  working: "tint-working",
  needs: "tint-needs",
  idle: "tint-idle",
  done: "tint-ok",
  complete: "tint-ok",
  failed: "tint-fail",
  unknown: "tint-unknown",
  sleeping: "tint-idle",
  "sleeping-done": "tint-ok",
};

/** Colors an icon by status, the way `dotClass` colors a square. */
export const tintClass = (status: Status | null): string => (status ? TINT[status] : "tint-none");
