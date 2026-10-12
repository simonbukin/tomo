/**
 * Glyph masks: an element appears or goes along a front that a CSS mask draws, so whatever lies under it shows
 * through at once, never a blank ground. A band of glyphs rides the front on its own canvas. The front is plain
 * geometry (a circle for the iris, a line for the sweep), so the gradient and the glyph band always agree.
 */
export type MaskStyle = "iris" | "sweep";
/** `reveal` grows the element in from the origin; `conceal` opens a hole in it from the origin, so what lies under it
 * shows; `close` shrinks it into the origin. */
export type MaskMode = "reveal" | "conceal" | "close";

export interface Box {
  readonly width: number;
  readonly height: number;
  /** Where the iris opens from, in px from the top left of the box. */
  readonly ox: number;
  readonly oy: number;
}

/** The sweep runs down and across, steep, as the halftone cover did. */
const SWEEP = { x: 0.55, y: 1 };
const FEATHER = 0.012;

/** Fast from the first frame, so the change answers the click at once, and soft at the end. */
export const easeOut = (x: number): number => 1 - (1 - Math.min(1, Math.max(0, x))) ** 3;

const sweepDir = (reverse: boolean) => {
  const len = Math.hypot(SWEEP.x, SWEEP.y);
  return { x: (reverse ? -SWEEP.x : SWEEP.x) / len, y: SWEEP.y / len };
};

const corners = (b: Box) => [
  [0, 0],
  [b.width, 0],
  [0, b.height],
  [b.width, b.height],
];

/** Where a point sits on the way of the front, 0 at the first point it passes and 1 at the last. */
export function maskT(style: MaskStyle, b: Box, x: number, y: number, reverse = false): number {
  if (style === "iris") {
    const far = Math.max(...corners(b).map(([cx, cy]) => Math.hypot(cx - b.ox, cy - b.oy))) || 1;
    return Math.hypot(x - b.ox, y - b.oy) / far;
  }
  const d = sweepDir(reverse);
  const along = corners(b).map(([cx, cy]) => cx * d.x + cy * d.y);
  const lo = Math.min(...along), hi = Math.max(...along);
  return (x * d.x + y * d.y - lo) / (hi - lo || 1);
}

/** Where the edge of the mask is at front `f`: a closing element's edge runs back from the far side. */
export const edgeAt = (mode: MaskMode, f: number): number => (mode === "close" ? 1 - f : f);

/** The CSS mask for front `f`, 0 to 1. Inside the edge (toward the origin) the element shows unless it conceals. */
export function maskImage(style: MaskStyle, mode: MaskMode, b: Box, f: number, reverse = false): string {
  const passed = mode === "conceal" ? "transparent" : "#000";
  const ahead = mode === "conceal" ? "#000" : "transparent";
  f = edgeAt(mode, f);
  const at = (v: number) => `${(Math.min(1.5, Math.max(0, v)) * 100).toFixed(2)}%`;
  if (style === "iris") {
    const far = Math.max(...corners(b).map(([cx, cy]) => Math.hypot(cx - b.ox, cy - b.oy))) || 1;
    const px = (v: number) => `${(Math.max(0, v) * far).toFixed(1)}px`;
    return `radial-gradient(circle ${far.toFixed(1)}px at ${b.ox.toFixed(1)}px ${b.oy.toFixed(1)}px, ${passed} ${px(f)}, ${ahead} ${px(f + FEATHER)})`;
  }
  const d = sweepDir(reverse);
  const deg = (Math.atan2(d.x, -d.y) * 180) / Math.PI;
  return `linear-gradient(${deg.toFixed(2)}deg, ${passed} ${at(f)}, ${ahead} ${at(f + FEATHER)})`;
}
