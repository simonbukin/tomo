import { useEffect, useLayoutEffect, useRef } from "react";
import { coversFor, type CoverTarget, type Scene } from "./coverPlan";
import { playCover } from "./glyphCoverPlay";
import { activeTab, paneIds, useStore, type State } from "./store";

const POINTER_FRESH_MS = 1500;
const POINTER_REACH_PX = 160;

const sceneOf = (s: State): Scene => {
  const worktreeId = s.ui.view === "worktree" ? s.ui.activeWorktreeId : null;
  const tab = activeTab(s, worktreeId);
  const leaves = tab ? paneIds(tab.layout) : [];
  return {
    view: s.ui.view,
    worktreeId,
    tabId: tab?.id ?? null,
    tabIds: worktreeId ? (s.tabs[worktreeId] ?? []).map((t) => t.id) : [],
    leaves,
    asleep: leaves.filter((id) => s.agents[id]?.sleep),
  };
};

const targetOf = (t: CoverTarget): HTMLElement | null =>
  t.kind === "center"
    ? document.querySelector<HTMLElement>("main.center")
    : t.kind === "layout"
      ? document.querySelector<HTMLElement>("main.center .layout-root")
      : document.querySelector<HTMLElement>(`[data-pane-id="${CSS.escape(t.paneId)}"]`);

const near = (el: HTMLElement, p: { x: number; y: number }) => {
  const r = el.getBoundingClientRect();
  const dx = Math.max(r.left - p.x, 0, p.x - r.right), dy = Math.max(r.top - p.y, 0, p.y - r.bottom);
  return Math.hypot(dx, dy) <= POINTER_REACH_PX;
};

/** Plays the glyph cover that each change of the centre gets: see coverPlan.ts. */
export function useCovers() {
  const key = useStore((s) => (s.loaded ? JSON.stringify(sceneOf(s)) : ""));
  const last = useRef<Scene | null>(null);
  const pointer = useRef<{ x: number; y: number; at: number } | null>(null);

  useEffect(() => {
    const down = (e: PointerEvent) => (pointer.current = { x: e.clientX, y: e.clientY, at: performance.now() });
    window.addEventListener("pointerdown", down, true);
    return () => window.removeEventListener("pointerdown", down, true);
  }, []);

  useLayoutEffect(() => {
    if (!key) return;
    const next: Scene = JSON.parse(key);
    const plans = coversFor(last.current, next);
    last.current = next;
    const p = pointer.current;
    const recent = p && performance.now() - p.at < POINTER_FRESH_MS ? p : null;
    for (const plan of plans) {
      const host = targetOf(plan.target);
      if (!host) continue;
      const origin = plan.fromPointer && recent && near(host, recent) ? recent : undefined;
      playCover(host, { style: plan.style, reverse: plan.reverse, origin });
    }
  }, [key]);
}
