import { useLayoutEffect, useRef } from "react";

interface Box {
  top: number;
  left: number;
  width: number;
  height: number;
  node: HTMLElement;
  parent: string | null;
}

const SHUT = "inset(0 0 100% 0)";
const OPEN = "inset(0 0 0 0)";

const MOVE = "flip-move";

/** Stops a slide that is still running and returns where it had got to, so the next slide starts there. */
function settle(node: HTMLElement): { x: number; y: number } {
  const running = node.getAnimations?.().filter((a) => a.id === MOVE) ?? [];
  if (!running.length) return { x: 0, y: 0 };
  const m = new DOMMatrixReadOnly(getComputedStyle(node).transform);
  running.forEach((a) => a.cancel());
  return { x: m.m41, y: m.m42 };
}

/** Layout boxes in the content of `root`, so a scroll between two renders moves nothing. */
function measure(root: HTMLElement, items: HTMLElement[]): Map<string, Box> {
  const origin = root.getBoundingClientRect();
  return new Map(
    items.map((node) => {
      const r = node.getBoundingClientRect();
      const parent = node.parentElement?.closest<HTMLElement>("[data-flip]");
      const box = { top: r.top - origin.top + root.scrollTop, left: r.left - origin.left + root.scrollLeft, width: r.width, height: r.height, node, parent: parent && root.contains(parent) ? parent.dataset.flip! : null };
      return [node.dataset.flip!, box];
    }),
  );
}

/** How far an item moved inside its nearest moving ancestor, so a nested item does not move twice. */
function shift(key: string, prev: Map<string, Box>, next: Map<string, Box>): { dx: number; dy: number } | null {
  const a = prev.get(key)!;
  const b = next.get(key)!;
  if (a.parent !== b.parent) return null;
  const pa = a.parent ? prev.get(a.parent) : null;
  const pb = b.parent ? next.get(b.parent) : null;
  if (b.parent && (!pa || !pb)) return null;
  return { dx: a.left - (pa?.left ?? 0) - (b.left - (pb?.left ?? 0)), dy: a.top - (pa?.top ?? 0) - (b.top - (pb?.top ?? 0)) };
}

/** Where an item sits inside its nearest moving ancestor. */
function local(box: Box, boxes: Map<string, Box>): string | null {
  const parent = box.parent ? boxes.get(box.parent) : null;
  if (box.parent && !parent) return null;
  return `${box.parent}|${Math.round(box.left - (parent?.left ?? 0))},${Math.round(box.top - (parent?.top ?? 0))}`;
}

/** A removed item stays on screen where it was and shuts from the bottom while the items under it slide up. */
function ghost(root: HTMLElement, box: Box, timing: KeyframeAnimationOptions): Animation {
  const g = box.node;
  g.dataset.flipGhost = "";
  g.inert = true;
  g.setAttribute("aria-hidden", "true");
  Object.assign(g.style, { position: "absolute", top: `${box.top}px`, left: `${box.left}px`, width: `${box.width}px`, height: `${box.height}px`, minHeight: "0", margin: "0", transform: "none", pointerEvents: "none" });
  root.appendChild(g);
  const run = g.animate([{ clipPath: OPEN, opacity: 1 }, { clipPath: SHUT, opacity: 0 }], { ...timing, fill: "forwards" });
  run.onfinish = run.oncancel = () => g.remove();
  return run;
}

function motion(root: HTMLElement): KeyframeAnimationOptions | null {
  const css = getComputedStyle(root);
  const duration = parseFloat(css.getPropertyValue("--dur-open")) || 0;
  const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  return duration > 0 && !reduce ? { duration, easing: css.getPropertyValue("--ease-out").trim() || "ease-out" } : null;
}

/**
 * Animates the `data-flip` items of `ref` from where they were on the last render to where they are now
 * (FLIP). A new item opens from the top edge and a removed item shuts to it, in step with the items that
 * slide to make or close its space, so a list never jumps. A new item that takes the exact place of a
 * removed one replaces it at once, so the two never show on top of each other. An item inside another item moves with it.
 * Without `deps` it checks every render. Uses the Web Animations API, the `--dur-open` and `--ease-out`
 * tokens, and does nothing under reduced motion or while a drag runs.
 */
export function useFlip(ref: React.RefObject<HTMLElement | null>, deps?: unknown[], animate = true): void {
  const last = useRef<Map<string, Box>>(new Map());
  const ghosts = useRef<Set<Animation>>(new Set());
  useLayoutEffect(() => {
    const root = ref.current;
    if (!root) return;
    const prev = last.current;
    const items = Array.from(root.querySelectorAll<HTMLElement>("[data-flip]")).filter((node) => !node.closest("[data-flip-ghost]"));
    const offsets = new Map(items.map((node) => [node.dataset.flip!, settle(node)]));
    const next = measure(root, items);
    last.current = next;
    const timing = animate && prev.size > 0 && !root.querySelector(".wt-dragging, .is-dragging") ? motion(root) : null;
    if (!timing) return;
    const removed = [...prev].filter(([key, box]) => !next.has(key) && !box.node.isConnected && (!box.parent || next.has(box.parent)));
    const added = [...next].filter(([key]) => !prev.has(key));
    const vacated = new Set(removed.map(([, box]) => local(box, prev)));
    const swapped = new Set(added.filter(([, box]) => vacated.has(local(box, next))).map(([, box]) => local(box, next)));
    for (const [, box] of removed) {
      if (swapped.has(local(box, prev))) continue;
      const run = ghost(root, box, timing);
      ghosts.current.add(run);
      run.finished.catch(() => {}).finally(() => ghosts.current.delete(run));
    }
    for (const [key, box] of next) {
      if (!prev.has(key)) {
        if ((!box.parent || prev.has(box.parent)) && !swapped.has(local(box, next))) box.node.animate([{ clipPath: SHUT, opacity: 0 }, { clipPath: OPEN, opacity: 1 }], timing);
        continue;
      }
      const d = shift(key, prev, next);
      const o = offsets.get(key)!;
      const dx = (d?.dx ?? 0) + o.x;
      const dy = (d?.dy ?? 0) + o.y;
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
      box.node.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }], { ...timing, id: MOVE });
    }
  }, deps);
  useLayoutEffect(() => () => ghosts.current.forEach((run) => run.cancel()), []);
}
