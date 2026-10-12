import { cellAt, frontAt, STYLES, thresholds, type CoverMode, type CoverStyle } from "./glyphCover";

/**
 * Plays a glyph cover over `host`: a canvas child that fills it, sits above everything in it, and takes no clicks
 * and no space. The first frame is drawn before this returns, so an element that mounts with a cover never shows
 * bare. Each frame writes one cell-sized mask for the ground and copies edge glyphs from a pre-drawn atlas.
 */
export interface CoverOptions {
  readonly style: CoverStyle;
  readonly mode?: CoverMode;
  readonly ms?: number;
  /** Where the cover opens from, in client pixels. The centre when absent. */
  readonly origin?: { readonly x: number; readonly y: number };
  readonly reverse?: boolean;
  /** CSS colour of the edge glyphs; the muted text colour when absent. */
  readonly ink?: string;
}

export interface Cover {
  readonly done: Promise<void>;
  readonly cancel: () => void;
}

const FONT_PX = 12;
const FONT = `500 ${FONT_PX}px "Red Hat Mono", ui-monospace, Menlo, monospace`;
const active = new WeakMap<HTMLElement, Cover>();

const finished: Cover = { done: Promise.resolve(), cancel: () => {} };

export const motionReduced = (): boolean => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

const rgba = (css: string): [number, number, number, number] => {
  const c = document.createElement("canvas");
  c.width = c.height = 1;
  const ctx = c.getContext("2d");
  if (!ctx) return [0, 0, 0, 255];
  ctx.fillStyle = css;
  ctx.fillRect(0, 0, 1, 1);
  const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
  return [r, g, b, a];
};

/** The colour that the host shows: its own background, or the first ancestor that has one. */
const groundOf = (el: HTMLElement): string => {
  for (let at: HTMLElement | null = el; at; at = at.parentElement) {
    const bg = getComputedStyle(at).backgroundColor;
    if (bg && bg !== "transparent" && !/rgba\(.*,\s*0\)$/.test(bg)) return bg;
  }
  return getComputedStyle(document.documentElement).getPropertyValue("--bg").trim() || "#000";
};

const cellSize = (dpr: number) => {
  const probe = document.createElement("canvas").getContext("2d");
  if (probe) probe.font = FONT;
  const advance = probe?.measureText("0").width || FONT_PX * 0.6;
  return { cw: Math.max(1, Math.round(advance * dpr)), lh: Math.max(1, Math.round(advance * 2 * dpr)) };
};

const atlasOf = (glyphs: readonly string[], ink: string, cw: number, lh: number, dpr: number): HTMLCanvasElement => {
  const atlas = document.createElement("canvas");
  atlas.width = cw * glyphs.length;
  atlas.height = lh;
  const ctx = atlas.getContext("2d");
  if (!ctx) return atlas;
  ctx.font = `500 ${FONT_PX * dpr}px "Red Hat Mono", ui-monospace, Menlo, monospace`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = ink;
  glyphs.forEach((g, i) => ctx.fillText(g, i * cw + cw / 2, lh / 2));
  return atlas;
};

export function playCover(host: HTMLElement, options: CoverOptions): Cover {
  active.get(host)?.cancel();
  if (motionReduced()) return finished;
  const rect = host.getBoundingClientRect();
  if (rect.width < 4 || rect.height < 4) return finished;

  const { style, mode = "in", ms = STYLES[options.style].ms, origin, reverse = false } = options;
  const dpr = window.devicePixelRatio || 1;
  const { cw, lh } = cellSize(dpr);
  const width = Math.ceil(rect.width * dpr), height = Math.ceil(rect.height * dpr);
  const cols = Math.ceil(width / cw), rows = Math.ceil(height / lh);
  const ox = origin ? ((origin.x - rect.left) * dpr) / cw : cols / 2;
  const oy = origin ? ((origin.y - rect.top) * dpr) / lh : rows / 2;
  const at = thresholds(style, { cols, rows, ox, oy }, Math.floor(Math.random() * 1e6), reverse);
  const { edge, band } = STYLES[style];

  if (getComputedStyle(host).position === "static") host.style.position = "relative";
  const canvas = document.createElement("canvas");
  canvas.className = "glyph-cover";
  canvas.setAttribute("aria-hidden", "true");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  const mask = document.createElement("canvas");
  mask.width = cols;
  mask.height = rows;
  const mctx = mask.getContext("2d");
  if (!ctx || !mctx) return finished;
  ctx.imageSmoothingEnabled = false;

  const [r, g, b] = rgba(groundOf(host));
  const atlas = atlasOf(edge, options.ink ?? (getComputedStyle(host).getPropertyValue("--fg-2").trim() || "#888"), cw, lh, dpr);
  const image = mctx.createImageData(cols, rows);
  const pixels = new Uint32Array(image.data.buffer);
  const little = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;
  const pack = (alpha: number) => (little ? ((alpha << 24) | (b << 16) | (g << 8) | r) >>> 0 : ((r << 24) | (g << 16) | (b << 8) | alpha) >>> 0);

  const paint = (k: number) => {
    const front = frontAt(k, mode, band);
    ctx.clearRect(0, 0, width, height);
    const glyphs: number[] = [];
    for (let i = 0; i < at.length; i++) {
      const cell = cellAt(style, front, at[i]);
      pixels[i] = cell.ground ? pack(Math.round(cell.ground * 255)) : 0;
      if (cell.glyph >= 0) glyphs.push(i, cell.glyph, cell.ink);
    }
    mctx.putImageData(image, 0, 0);
    ctx.drawImage(mask, 0, 0, cols * cw, rows * lh);
    for (let j = 0; j < glyphs.length; j += 3) {
      const i = glyphs[j], x = (i % cols) * cw, y = Math.floor(i / cols) * lh;
      ctx.globalAlpha = glyphs[j + 2];
      ctx.drawImage(atlas, glyphs[j + 1] * cw, 0, cw, lh, x, y, cw, lh);
    }
    ctx.globalAlpha = 1;
  };

  let frame = 0;
  let settle: () => void = () => {};
  const done = new Promise<void>((resolve) => (settle = resolve));
  const stop = () => {
    cancelAnimationFrame(frame);
    if (mode === "in") canvas.remove();
    if (active.get(host) === cover) active.delete(host);
    settle();
  };
  const cover: Cover = { done, cancel: () => { canvas.remove(); stop(); } };
  active.set(host, cover);

  paint(0);
  host.appendChild(canvas);
  const start = performance.now();
  const tick = (now: number) => {
    const k = Math.min(1, (now - start) / ms);
    paint(k);
    if (k < 1) frame = requestAnimationFrame(tick);
    else stop();
  };
  frame = requestAnimationFrame(tick);
  return cover;
}
