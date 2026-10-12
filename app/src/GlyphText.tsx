import { useLayoutEffect, useRef } from "react";
import { motionReduced } from "./glyphCoverPlay";
import { DURATION_MS, frameOf, type TextEffect } from "./glyphFrames";

/**
 * Text that runs a glyph effect each time it changes. React renders an empty span; the text inside is ours. Each
 * letter is a box as wide as its final glyph from the first frame, so nothing around the text moves, and the boxes
 * fold back into one plain text node at the end. The first render shows the text as it is, unless `enter` is set.
 */
export function GlyphText({ text, effect = "scramble", enter = false, className, dragRegion = false }: { text: string; effect?: TextEffect; enter?: boolean; className?: string; dragRegion?: boolean }) {
  const ref = useRef<HTMLSpanElement>(null);
  const shown = useRef<string | null>(null);
  const entering = useRef(enter);
  entering.current = enter;

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const from = shown.current;
    shown.current = text;
    if (from === text) return;
    if ((from === null && !entering.current) || motionReduced() || !text) {
      el.textContent = text;
      return;
    }
    return play(el, from ?? "", text, effect);
  }, [text, effect]);

  return <span ref={ref} className={className} data-tauri-drag-region={dragRegion || undefined} />;
}

/**
 * The letter boxes share the width of the final text as one shaped run, so kerning lost between them cannot move
 * what follows. They are hidden from assistive technology; one visually hidden copy says the final text.
 */
function play(el: HTMLSpanElement, from: string, to: string, effect: TextEffect): () => void {
  const target = [...to], before = [...from];
  el.textContent = to;
  const run = el.getBoundingClientRect().width;
  el.textContent = "";
  const drag = el.hasAttribute("data-tauri-drag-region");
  const boxes = target.map((ch) => {
    const box = document.createElement("span");
    box.className = "glyph-letter";
    box.setAttribute("aria-hidden", "true");
    if (drag) box.setAttribute("data-tauri-drag-region", "");
    box.textContent = ch;
    el.appendChild(box);
    return box;
  });
  const said = document.createElement("span");
  said.className = "glyph-said";
  said.textContent = to;
  el.prepend(said);
  const widths = boxes.map((b) => b.getBoundingClientRect().width);
  const total = widths.reduce((a, w) => a + w, 0);
  const scale = total > 0 && run > 0 ? run / total : 1;
  boxes.forEach((b, i) => (b.style.width = `${widths[i] * scale}px`));

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
