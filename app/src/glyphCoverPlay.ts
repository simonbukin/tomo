import { frontAt, glyphAt, groundAt, inkAt, passedAt, STYLES, thresholds, type CoverMode, type CoverStyle } from "./glyphCover";

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
/** A full-screen cover on a dense display paints a little softer, so every frame stays one cheap raster. */
const MAX_DEVICE_PIXELS = 4.5e6;
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

const visibleBackgroundOf = (el: HTMLElement): string => {
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

/**
 * Plays a glyph cover over `host`: a canvas child that fills it, sits above everything in it, and takes no clicks
 * and no space. The first frame is drawn before this returns, so an element that mounts with a cover never shows
 * bare. Each frame writes one cell-sized mask for the ground and copies edge glyphs from a pre-drawn atlas.
 */
export function playCover(host: HTMLElement, options: CoverOptions): Cover {
  active.get(host)?.cancel();
  if (motionReduced()) return finished;
  const rect = host.getBoundingClientRect();
  if (rect.width < 4 || rect.height < 4) return finished;

  const { style, mode = "in", ms = STYLES[options.style].ms, origin, reverse = false } = options;
  const dpr = Math.min(window.devicePixelRatio || 1, Math.sqrt(MAX_DEVICE_PIXELS / (rect.width * rect.height)));
  const { cw, lh } = cellSize(dpr);
  const width = Math.ceil(rect.width * dpr), height = Math.ceil(rect.height * dpr);
  const cols = Math.ceil(width / cw), rows = Math.ceil(height / lh);
  const ox = origin ? ((origin.x - rect.left) * dpr) / cw : cols / 2;
  const oy = origin ? ((origin.y - rect.top) * dpr) / lh : rows / 2;
  const at = thresholds(style, { cols, rows, ox, oy }, Math.floor(Math.random() * 1e6), reverse);
  const { edge, band } = STYLES[style];

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

  const [r, g, b] = rgba(visibleBackgroundOf(host));
  const atlas = atlasOf(edge, options.ink ?? (getComputedStyle(host).getPropertyValue("--fg-2").trim() || "#888"), cw, lh, dpr);
  const image = mctx.createImageData(cols, rows);
  const pixels = new Uint32Array(image.data.buffer);
  const little = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;
  const pack = (alpha: number) => (little ? ((alpha << 24) | (b << 16) | (g << 8) | r) >>> 0 : ((r << 24) | (g << 16) | (b << 8) | alpha) >>> 0);

  const solid = pack(255);
  const edgeCells = new Int32Array(at.length);
  const paint = (k: number) => {
    const front = frontAt(k, mode, band);
    let edges = 0;
    for (let i = 0; i < at.length; i++) {
      const p = passedAt(style, front, at[i]);
      if (p >= 1) pixels[i] = 0;
      else if (p <= 0) pixels[i] = solid;
      else {
        pixels[i] = pack(Math.round(groundAt(style, p) * 255));
        edgeCells[edges++] = i;
      }
    }
    mctx.putImageData(image, 0, 0);
    ctx.globalCompositeOperation = "copy";
    ctx.drawImage(mask, 0, 0, cols * cw, rows * lh);
    ctx.globalCompositeOperation = "source-over";
    for (let j = 0; j < edges; j++) {
      const i = edgeCells[j], p = passedAt(style, front, at[i]);
      ctx.globalAlpha = inkAt(style, p);
      ctx.drawImage(atlas, glyphAt(style, p) * cw, 0, cw, lh, (i % cols) * cw, Math.floor(i / cols) * lh, cw, lh);
    }
    ctx.globalAlpha = 1;
  };

  let frame = 0;
  let settle: () => void = () => {};
  const done = new Promise<void>((resolve) => (settle = resolve));
  const placed = getComputedStyle(host).position === "static";
  const detach = () => {
    canvas.remove();
    if (placed) host.style.removeProperty("position");
  };
  const stop = () => {
    cancelAnimationFrame(frame);
    if (mode === "in") detach();
    if (active.get(host) === cover) active.delete(host);
    settle();
  };
  const cover: Cover = { done, cancel: () => { detach(); stop(); } };
  active.set(host, cover);

  paint(0);
  if (placed) host.style.position = "relative";
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
