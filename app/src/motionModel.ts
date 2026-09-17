export interface Point {
  x: number;
  y: number;
}

export interface Viewport {
  width: number;
  height: number;
}

/** Where a transition starts. `pointer` falls back to the centre when nothing was pointed at. */
export type Origin = "pointer" | "center" | Point;

/** A pointer older than this is not what the person is looking at now. */
export const POINTER_TTL_MS = 4000;

export const centreOf = (v: Viewport): Point => ({ x: v.width / 2, y: v.height / 2 });

export function freshPointer(seen: (Point & { at: number }) | null, now: number): Point | null {
  if (!seen || now - seen.at > POINTER_TTL_MS) return null;
  return { x: seen.x, y: seen.y };
}

export function originPoint(origin: Origin, pointer: Point | null, viewport: Viewport): Point {
  if (origin === "center") return centreOf(viewport);
  if (origin === "pointer") return pointer ?? centreOf(viewport);
  return origin;
}

/** How far the reveal travels: the distance from the origin to the farthest corner. */
export function revealRadius(from: Point, v: Viewport): number {
  return Math.hypot(Math.max(from.x, v.width - from.x), Math.max(from.y, v.height - from.y));
}
