import { flushSync } from "react-dom";
import { freshPointer, originPoint, revealRadius, type Origin, type Point } from "./motionModel";
import { setUi } from "./store";
import type { UiState } from "./types";

export type { Origin } from "./motionModel";

export type TransitionKind = "reveal" | "theme";

let seen: (Point & { at: number }) | null = null;

export function watchPointer(target: Window): () => void {
  const note = (e: PointerEvent) => {
    seen = { x: e.clientX, y: e.clientY, at: Date.now() };
  };
  target.addEventListener("pointerdown", note, { passive: true });
  return () => target.removeEventListener("pointerdown", note);
}

/**
 * Applies `update` and lets the browser move between the two states. The state changes inside
 * the callback so the browser can snapshot both; `flushSync` makes React commit before it does.
 * Where the browser cannot do this, the state still changes and nothing animates.
 */
export function transition(kind: TransitionKind, update: () => void, origin: Origin = "pointer"): void {
  if (typeof document.startViewTransition !== "function") {
    update();
    return;
  }
  const viewport = { width: window.innerWidth, height: window.innerHeight };
  const from = originPoint(origin, freshPointer(seen, Date.now()), viewport);
  const root = document.documentElement;
  root.style.setProperty("--reveal-x", `${Math.round(from.x)}px`);
  root.style.setProperty("--reveal-y", `${Math.round(from.y)}px`);
  root.style.setProperty("--reveal-radius", `${Math.ceil(revealRadius(from, viewport))}px`);
  root.dataset.transition = kind;
  const run = document.startViewTransition(() => flushSync(update));
  const done = () => {
    if (root.dataset.transition === kind) delete root.dataset.transition;
  };
  run.finished.then(done, done);
}

/** A move to another view, scope, or worktree: a new layer, revealed from where the person acted. */
export const navigate = (patch: Partial<UiState>, origin: Origin = "pointer"): void => transition("reveal", () => setUi(patch), origin);
