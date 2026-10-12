import { useLayoutEffect, useRef } from "react";
import { motionReduced } from "./glyphCoverPlay";
import { DURATION_MS, frameOf, type TextEffect } from "./glyphFrames";

/**
 * Text that runs a glyph effect each time it changes. React renders an empty span; the text inside is ours. Each
 * letter is a box as wide as its final glyph from the first frame, so nothing around the text moves, and the boxes
 * fold back into one plain text node at the end. The first render shows the text as it is, unless `enter` is set.
 */
export function GlyphText({ text, effect = "scramble", enter = false, className }: { text: string; effect?: TextEffect; enter?: boolean; className?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const shown = useRef<string | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const from = shown.current;
    shown.current = text;
    if (from === text) return;
    if ((from === null && !enter) || motionReduced() || !text) {
      el.textContent = text;
      return;
    }
    return play(el, from ?? "", text, effect);
  }, [text, effect, enter]);

  return <span ref={ref} className={className} />;
}

function play(el: HTMLSpanElement, from: string, to: string, effect: TextEffect): () => void {
  const target = [...to], before = [...from];
  el.textContent = "";
  const boxes = target.map((ch) => {
    const box = document.createElement("span");
    box.className = "glyph-letter";
    box.textContent = ch;
    el.appendChild(box);
    return box;
  });
  const widths = boxes.map((b) => b.getBoundingClientRect().width);
  boxes.forEach((b, i) => (b.style.width = `${widths[i]}px`));

  const paint = (k: number, seconds: number) =>
    frameOf(effect, before, target, k, seconds).forEach((g, i) => {
      const box = boxes[i];
      if (box.textContent !== g.ch) box.textContent = g.ch;
      box.classList.toggle("glyph-stroke", g.stroke);
    });

  const ms = DURATION_MS[effect];
  const start = performance.now();
  let frame = 0;
  const finish = () => {
    cancelAnimationFrame(frame);
    el.textContent = to;
  };
  const tick = (now: number) => {
    const k = Math.min(1, (now - start) / ms);
    if (k >= 1) return finish();
    paint(k, (now - start) / 1000);
    frame = requestAnimationFrame(tick);
  };
  paint(0, 0);
  frame = requestAnimationFrame(tick);
  return finish;
}
