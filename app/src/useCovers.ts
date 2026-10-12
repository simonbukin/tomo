import { useEffect, useLayoutEffect, useRef } from "react";
import { coversFor, type CoverTarget, type Plan, type Scene } from "./coverPlan";
import { playCover } from "./glyphCoverPlay";
import { playMask } from "./glyphMaskPlay";
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
      ? document.querySelector<HTMLElement>("main.center .layout-root:not([data-hidden])")
      : document.querySelector<HTMLElement>(`[data-pane-id="${CSS.escape(t.paneId)}"]`);

const near = (el: HTMLElement, p: { x: number; y: number }) => {
  const r = el.getBoundingClientRect();
  const dx = Math.max(r.left - p.x, 0, p.x - r.right), dy = Math.max(r.top - p.y, 0, p.y - r.bottom);
  return Math.hypot(dx, dy) <= POINTER_REACH_PX;
};

type Point = { x: number; y: number };

const oldLayout = (tabId: string) => document.querySelector<HTMLElement>(`main.center .layout-root[data-tab-id="${CSS.escape(tabId)}"][data-hidden]`);

/** A swap shows the old layout on top for a moment and masks it away over the new one, which is already drawn. */
function play(plan: Plan, pointer: Point | null) {
  if (plan.kind === "swap") {
    const old = oldLayout(plan.fromTabId);
    if (old) {
      const origin = plan.fromPointer && pointer && near(old, pointer) ? pointer : undefined;
      old.dataset.leaving = "";
      const mask = playMask(old, { style: plan.style, mode: "conceal", reverse: plan.reverse, origin });
      mask.done.then(() => {
        delete old.dataset.leaving;
        mask.cancel();
      });
      return;
    }
  }
  const target = plan.kind === "swap" ? ({ kind: "layout" } as const) : plan.target;
  const host = targetOf(target);
  if (!host) return;
  const origin = plan.fromPointer && pointer && near(host, pointer) ? pointer : undefined;
  playCover(host, { style: plan.kind === "swap" ? plan.fallback : plan.style, reverse: plan.reverse, origin });
}

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
    plans.forEach((plan) => play(plan, recent));
  }, [key]);
}
