import { easeOut, edgeAt, maskImage, maskT, type Box, type MaskMode, type MaskStyle } from "./glyphMask";
import { motionReduced, type Cover } from "./glyphCoverPlay";

export interface MaskOptions {
  readonly style: MaskStyle;
  readonly mode: MaskMode;
  readonly ms?: number;
  /** Where an iris opens from, in client pixels. The centre when absent. */
  readonly origin?: { readonly x: number; readonly y: number };
  readonly reverse?: boolean;
  readonly ink?: string;
}

const MS: Readonly<Record<MaskStyle, number>> = { iris: 420, sweep: 360 };
const EDGE = ["·", "∘", "○", "●"];
/** The band of glyphs behind the front, as a share of the whole way. */
const BAND = 0.07;
const FONT_PX = 12;
const MAX_DEVICE_PIXELS = 4.5e6;
const finished: Cover = { done: Promise.resolve(), cancel: () => {} };
const active = new WeakMap<HTMLElement, Cover>();

/** Ends a mask on `el` at once and clears it, as if it had never run. */
export const stopMask = (el: HTMLElement) => active.get(el)?.cancel();

const setMask = (el: HTMLElement, value: string) => {
  el.style.setProperty("mask-image", value);
  el.style.setProperty("-webkit-mask-image", value);
};

/**
 * Plays a glyph mask on `el`. The mask is a style on the element, drawn by the compositor; the band of glyphs is a
 * fixed canvas above it, outside the element, so the mask cannot hide the glyphs. A concealed element keeps its
 * mask until the caller hides it and calls `cancel`, so it never shows again for a frame.
 */
export function playMask(el: HTMLElement, options: MaskOptions): Cover {
  active.get(el)?.cancel();
  if (motionReduced()) return finished;
  const rect = el.getBoundingClientRect();
  if (rect.width < 4 || rect.height < 4) return finished;
  const { style, mode, ms = MS[options.style], reverse = false } = options;
  const box: Box = { width: rect.width, height: rect.height, ox: options.origin ? options.origin.x - rect.left : rect.width / 2, oy: options.origin ? options.origin.y - rect.top : rect.height / 2 };

  const dpr = Math.min(window.devicePixelRatio || 1, Math.sqrt(MAX_DEVICE_PIXELS / (rect.width * rect.height)));
  const probe = document.createElement("canvas").getContext("2d");
  if (probe) probe.font = `500 ${FONT_PX}px "Red Hat Mono", ui-monospace, Menlo, monospace`;
  const advance = probe?.measureText("0").width || FONT_PX * 0.6;
  const cw = advance, lh = advance * 2;
  const cols = Math.ceil(rect.width / cw), rows = Math.ceil(rect.height / lh);
  const at = new Float32Array(cols * rows);
  for (let y = 0, i = 0; y < rows; y++) for (let x = 0; x < cols; x++, i++) at[i] = maskT(style, box, (x + 0.5) * cw, (y + 0.5) * lh, reverse);

  const canvas = document.createElement("canvas");
  canvas.className = "glyph-mask-band";
  canvas.setAttribute("aria-hidden", "true");
  canvas.width = Math.ceil(rect.width * dpr);
  canvas.height = Math.ceil(rect.height * dpr);
  Object.assign(canvas.style, { left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px` });
  const ctx = canvas.getContext("2d");
  if (!ctx) return finished;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.font = `500 ${FONT_PX}px "Red Hat Mono", ui-monospace, Menlo, monospace`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = options.ink ?? (getComputedStyle(el).getPropertyValue("--fg-2").trim() || "#888");

  const paint = (k: number) => {
    const front = easeOut(k) * (1 + BAND);
    setMask(el, maskImage(style, mode, box, front, reverse));
    ctx.clearRect(0, 0, rect.width, rect.height);
    const edge = edgeAt(mode, front);
    for (let i = 0; i < at.length; i++) {
      const behind = mode === "close" ? at[i] - edge : edge - at[i];
      if (behind < 0 || behind > BAND) continue;
      const e = 1 - behind / BAND;
      ctx.globalAlpha = 0.35 + 0.65 * e;
      ctx.fillText(EDGE[Math.min(EDGE.length - 1, Math.floor(e * EDGE.length))], ((i % cols) + 0.5) * cw, (Math.floor(i / cols) + 0.5) * lh);
    }
    ctx.globalAlpha = 1;
  };

  let frame = 0;
  let settle: () => void = () => {};
  const done = new Promise<void>((resolve) => (settle = resolve));
  const end = (clearMask: boolean) => {
    cancelAnimationFrame(frame);
    canvas.remove();
    if (clearMask) setMask(el, "");
    if (active.get(el) === cover) active.delete(el);
    settle();
  };
  const cover: Cover = { done, cancel: () => end(true) };
  active.set(el, cover);

  paint(0);
  document.body.appendChild(canvas);
  const start = performance.now();
  const tick = (now: number) => {
    const k = Math.min(1, (now - start) / ms);
    paint(k);
    if (k < 1) frame = requestAnimationFrame(tick);
    else end(mode === "reveal");
  };
  frame = requestAnimationFrame(tick);
  return cover;
}
