import { useEffect, useRef, useSyncExternalStore } from "react";
import { rpc } from "./api";
import { activeTab, failQuietly, useStore, type State } from "./store";
import type { AgentState, Id } from "./types";

/** A turn that ends while you look stays done this long, so the change is visible. */
export const SEEN_DELAY_MS = 1500;

/** The agent pane that you look at: its pane has focus in a focused, visible window. */
export interface SeenView {
  paneId: Id | null;
  state: AgentState | null;
  seen: boolean;
  windowActive: boolean;
}

/**
 * When to tell the daemon that you saw the agent, in ms, or null for never. A done or a dead agent that
 * nobody saw is seen at once when you come to it, and after `SEEN_DELAY_MS` when it changed while you looked.
 */
export function seenDelay(prev: SeenView | null, next: SeenView): number | null {
  const unseen = next.state === "done" || (next.state === "dead" && !next.seen);
  if (!next.windowActive || !next.paneId || !unseen) return null;
  const watching = prev?.windowActive && prev.paneId === next.paneId;
  return watching ? SEEN_DELAY_MS : 0;
}

function shownAgent(s: State): Omit<SeenView, "windowActive"> {
  const paneId = s.ui.view === "worktree" ? (activeTab(s, s.ui.activeWorktreeId)?.active_pane_id ?? null) : null;
  const agent = paneId ? s.agents[paneId] : undefined;
  return { paneId, state: agent?.state ?? null, seen: agent?.seen ?? false };
}

const WINDOW_EVENTS = ["focus", "blur", "visibilitychange"] as const;

const subscribeWindow = (notify: () => void) => {
  WINDOW_EVENTS.forEach((e) => window.addEventListener(e, notify));
  return () => WINDOW_EVENTS.forEach((e) => window.removeEventListener(e, notify));
};

const windowActive = () => document.visibilityState === "visible" && document.hasFocus();

/** Calls `agent_seen` for the agent pane that you look at. See rule 3 in docs/agent-states.md. */
export function useAgentSeen(): void {
  const shown = useStore(shownAgent);
  const active = useSyncExternalStore(subscribeWindow, windowActive);
  const prev = useRef<SeenView | null>(null);
  useEffect(() => {
    const next = { ...shown, windowActive: active };
    const delay = seenDelay(prev.current, next);
    prev.current = next;
    if (delay === null || !next.paneId) return;
    const paneId = next.paneId;
    const timer = window.setTimeout(() => void rpc("agent_seen", { pane_id: paneId }).catch(failQuietly("agent_seen")), delay);
    return () => window.clearTimeout(timer);
  }, [shown, active]);
}
