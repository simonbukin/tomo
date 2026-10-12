/**
 * Glyph covers: a short-lived canvas over an element that hides it behind its own ground colour and opens along a
 * front, with a band of glyphs at the edge. Each cell of a monospace grid gets a threshold from 0 to 1; the front
 * passes it once. The threshold map is the whole style, so it is computed once and every frame is a cheap pass.
 *
 * Learned from ascii.rest (MIT, @bas3line): per-cell thresholds, and edge ramps that grow.
 */
export type CoverStyle = "aperture" | "seed" | "halftone" | "silk";
export type CoverMode = "in" | "out";

export interface CoverGrid {
  readonly cols: number;
  readonly rows: number;
  readonly ox: number;
  readonly oy: number;
}

interface Style {
  readonly ms: number;
  readonly band: number;
  readonly edge: readonly string[];
  readonly soft: boolean;
}

export const STYLES: Readonly<Record<CoverStyle, Style>> = {
  aperture: { ms: 440, band: 0.16, edge: ["·", "◦", "○", "●"], soft: false },
  seed: { ms: 420, band: 0.14, edge: ["·", "∘", "○", "●"], soft: false },
  halftone: { ms: 340, band: 0.32, edge: ["·", "∙", "•", "●"], soft: false },
  silk: { ms: 460, band: 0.28, edge: ["·", "∘", "○"], soft: true },
};

/** A cell is twice as tall as it is wide, so distances count a row as two columns. */
const ROW = 2;
const APERTURE_TWIST = 0.045;
const SEEDS = 9;
const SEED_STAGGER = 22;
const HALFTONE_SLOPE = 0.55;
const SILK_SCALE = 16;
const SILK_GRAIN = 5;
const EQUALIZE_BINS = 256;
const EPSILON = 1e-6;

const hash = (a: number, b: number, s: number): number => {
  let h = Math.imul(a + s * 7919, 374761393) + Math.imul(b, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
};

export const smooth = (x: number): number => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));
export const easeOut = (x: number): number => 1 - (1 - Math.min(1, Math.max(0, x))) ** 3;

const noise = (x: number, y: number, s: number): number => {
  const xi = Math.floor(x), yi = Math.floor(y), xf = smooth(x - xi), yf = smooth(y - yi);
  const a = hash(xi, yi, s), b = hash(xi + 1, yi, s), c = hash(xi, yi + 1, s), d = hash(xi + 1, yi + 1, s);
  return a + (b - a) * xf + (c - a) * yf + (a - b - c + d) * xf * yf;
};

const fill = (grid: CoverGrid, f: (x: number, y: number) => number): Float32Array => {
  const out = new Float32Array(grid.cols * grid.rows);
  for (let y = 0, i = 0; y < grid.rows; y++) for (let x = 0; x < grid.cols; x++, i++) out[i] = f(x, y);
  return out;
};

const normalized = (values: Float32Array): Float32Array => {
  const lo = values.reduce((m, v) => Math.min(m, v), Infinity);
  const hi = values.reduce((m, v) => Math.max(m, v), -Infinity);
  const span = hi - lo || 1;
  return values.map((v) => (v - lo) / span);
};

/** Ranks by a histogram, so the front eats noise at an even pace without a sort. */
const equalized = (values: Float32Array): Float32Array => {
  const unit = normalized(values);
  const counts = new Uint32Array(EQUALIZE_BINS);
  unit.forEach((v) => counts[Math.min(EQUALIZE_BINS - 1, Math.floor(v * EQUALIZE_BINS))]++);
  const below = new Float64Array(EQUALIZE_BINS);
  for (let i = 1; i < EQUALIZE_BINS; i++) below[i] = below[i - 1] + counts[i - 1];
  const n = unit.length || 1;
  return unit.map((v) => {
    const bin = Math.min(EQUALIZE_BINS - 1, Math.floor(v * EQUALIZE_BINS));
    const inside = v * EQUALIZE_BINS - bin;
    return (below[bin] + inside * counts[bin]) / n;
  });
};

const aperture = (g: CoverGrid) =>
  fill(g, (x, y) => {
    const dx = x - g.ox, dy = (y - g.oy) * ROW, a = Math.hypot(dx, dy) * APERTURE_TWIST;
    const rx = dx * Math.cos(a) - dy * Math.sin(a), ry = dx * Math.sin(a) + dy * Math.cos(a);
    return Math.max(Math.abs(rx) * 0.866 + Math.abs(ry) * 0.5, Math.abs(ry));
  });

const seeded = (g: CoverGrid, salt: number) => {
  const seeds = Array.from({ length: SEEDS }, (_, i) => ({ x: hash(i, 1, salt) * g.cols, y: hash(i, 2, salt) * g.rows, lag: hash(i, 4, salt) * SEED_STAGGER }));
  return fill(g, (x, y) => seeds.reduce((m, p) => Math.min(m, Math.hypot(x - p.x, (y - p.y) * ROW) + p.lag), Infinity));
};

const halftone = (g: CoverGrid, reverse: boolean) => fill(g, (x, y) => (reverse ? g.cols - x : x) * HALFTONE_SLOPE + y * ROW);

const silk = (g: CoverGrid, salt: number) =>
  fill(g, (x, y) => noise(x / SILK_SCALE, (y * ROW) / SILK_SCALE, salt) * 0.88 + noise(x / SILK_GRAIN, (y * ROW) / SILK_GRAIN, salt + 1) * 0.12);

/** Each cell's threshold, 0 to 1: the share of the opening that passes before the cell shows. */
export function thresholds(style: CoverStyle, grid: CoverGrid, salt: number, reverse = false): Float32Array {
  if (grid.cols <= 0 || grid.rows <= 0) return new Float32Array(0);
  switch (style) {
    case "aperture":
      return normalized(aperture(grid));
    case "seed":
      return normalized(seeded(grid, salt));
    case "halftone":
      return normalized(halftone(grid, reverse));
    case "silk":
      return equalized(silk(grid, salt));
  }
}

/** Where the front is at progress `k`: it starts behind every cell and ends past the band of the last one. */
export const frontAt = (k: number, mode: CoverMode, band: number): number => (mode === "in" ? easeOut(k) : 1 - easeOut(k)) * (1 + band);

export interface Cell {
  /** How much ground covers the cell, 0 to 1. */
  readonly ground: number;
  /** The edge glyph to draw, or -1 for none. */
  readonly glyph: number;
  readonly ink: number;
}

const OPEN: Cell = { ground: 0, glyph: -1, ink: 0 };
const SHUT: Cell = { ground: 1, glyph: -1, ink: 0 };

export function cellAt(style: CoverStyle, front: number, threshold: number): Cell {
  const { band, edge, soft } = STYLES[style];
  const d = front - threshold;
  if (d >= band - EPSILON) return OPEN;
  if (d <= 0) return SHUT;
  const p = d / band, e = 1 - p;
  return {
    ground: soft ? 1 - smooth(p) * 0.85 : 1,
    glyph: Math.min(edge.length - 1, Math.floor(e * edge.length)),
    ink: soft ? Math.min(1, e * 1.6) : 1,
  };
}
