import { useLayoutEffect, useRef } from "react";

const DURATION = 180;

/**
 * Animates children of `ref` from where they were on the previous render to where
 * they are now (FLIP). Children need a `data-flip` key. New children fade in.
 * Uses the Web Animations API; respects reduced motion.
 */
export function useFlip(ref: React.RefObject<HTMLElement | null>, deps: unknown[]): void {
  const last = useRef<Map<string, DOMRect>>(new Map());
  useLayoutEffect(() => {
    const root = ref.current;
    if (!root) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const next = new Map<string, DOMRect>();
    const items = Array.from(root.querySelectorAll<HTMLElement>("[data-flip]"));
    for (const el of items) {
      const key = el.dataset.flip!;
      const rect = el.getBoundingClientRect();
      next.set(key, rect);
      if (reduce) continue;
      const prev = last.current.get(key);
      if (!prev) {
        if (last.current.size) el.animate([{ opacity: 0, transform: "translateY(-4px)" }, { opacity: 1, transform: "none" }], { duration: DURATION, easing: "ease-out" });
        continue;
      }
      const dy = prev.top - rect.top;
      const dx = prev.left - rect.left;
      if (Math.abs(dy) < 1 && Math.abs(dx) < 1) continue;
      el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }], { duration: DURATION, easing: "cubic-bezier(0.2, 0, 0, 1)" });
    }
    last.current = next;
  }, deps);
}
