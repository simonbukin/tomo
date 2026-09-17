export type Seed = string | number;

export type Dot = { cx: number; cy: number; r: number };

export type Point = { x: number; y: number };

export type Face = {
  paths: string[];
  dots: Dot[];
  mouth: Point[];
  stroke: number;
  box: number;
};

export const BOX = 100;
export const SMALL_SIZE = 24;

const fnv1a = (text: string) => {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
};

const mulberry32 = (state: number) => () => {
  state = (state + 0x6d2b79f5) | 0;
  let t = Math.imul(state ^ (state >>> 15), 1 | state);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

type Params = {
  half: number;
  baseY: number;
  lean: number;
  depth: number;
  skew: number;
  stroke: number;
  wobble: Point[];
  flickStart: number;
  flickEnd: number;
  flickTurn: number;
  eyeGap: number;
  eyeShift: number;
  eyeRise: number;
  eyeR: number;
  eyeRatio: number;
  eyeDrop: number;
  extra: number;
  extraSide: number;
  offX: number;
  offY: number;
};

const draw = (seed: Seed): Params => {
  const next = mulberry32(fnv1a(String(seed)));
  const span = (lo: number, hi: number) => lo + next() * (hi - lo);
  const half = span(17, 31);
  const baseY = span(52, 60);
  const lean = span(-8, 8);
  const depth = span(7, 31);
  const skew = span(0.78, 1.3);
  const stroke = span(2.4, 7.6);
  const wobble = [0, 1, 2, 3, 4].map((i) => {
    const edge = i === 0 || i === 4 ? 0.35 : 1;
    return { x: span(-3.2, 3.2) * edge, y: span(-3.2, 3.2) * edge };
  });
  const flickStart = next() < 0.45 ? span(4, 11) : 0;
  const flickEnd = next() < 0.55 ? span(4, 12) : 0;
  const flickTurn = span(0.35, 1.15);
  const eyeGap = span(25, 47);
  const eyeShift = span(-5, 5);
  const eyeRise = span(13, 31);
  const eyeR = span(2.6, 6.6);
  const eyeRatio = span(0.7, 1.38);
  const eyeDrop = span(-4.5, 4.5);
  const extra = next();
  const extraSide = span(-1, 1);
  const offX = span(-3, 3);
  const offY = span(-3, 3);
  return { half, baseY, lean, depth, skew, stroke, wobble, flickStart, flickEnd, flickTurn, eyeGap, eyeShift, eyeRise, eyeR, eyeRatio, eyeDrop, extra, extraSide, offX, offY };
};

const forSmall = (p: Params): Params => ({
  ...p,
  half: Math.max(p.half, 20),
  depth: Math.max(p.depth, 15),
  stroke: Math.min(Math.max(p.stroke, 7), 9),
  flickStart: 0,
  flickEnd: 0,
  eyeGap: Math.max(p.eyeGap, 29),
  eyeRise: Math.min(Math.max(p.eyeRise, 16), 27),
  eyeR: Math.max(p.eyeR, 5.6),
  eyeRatio: Math.min(Math.max(p.eyeRatio, 0.85), 1.2),
  extra: 1,
});

const arcPoints = (p: Params): Point[] => {
  const x0 = -p.half;
  const x1 = p.half;
  const y0 = p.baseY - p.lean;
  const y1 = p.baseY + p.lean;
  return [0, 0.25, 0.5, 0.75, 1].map((t, i) => {
    const u = Math.pow(t, p.skew);
    return {
      x: x0 + (x1 - x0) * t + p.wobble[i].x,
      y: y0 + (y1 - y0) * t + p.depth * 4 * u * (1 - u) + p.wobble[i].y,
    };
  });
};

const flickPoint = (from: Point, toward: Point, length: number, turn: number): Point => {
  const dx = from.x - toward.x;
  const dy = from.y - toward.y;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  const c = Math.cos(turn);
  const s = Math.sin(turn);
  return { x: from.x + (ux * c - uy * s) * length, y: from.y + (ux * s + uy * c) * length };
};

const spline = (pts: Point[]) => {
  const at = (i: number) => pts[Math.min(Math.max(i, 0), pts.length - 1)];
  const parts = [`M${round(pts[0].x)} ${round(pts[0].y)}`];
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = at(i - 1);
    const p1 = at(i);
    const p2 = at(i + 1);
    const p3 = at(i + 2);
    const c1 = { x: p1.x + (p2.x - p0.x) / 6, y: p1.y + (p2.y - p0.y) / 6 };
    const c2 = { x: p2.x - (p3.x - p1.x) / 6, y: p2.y - (p3.y - p1.y) / 6 };
    parts.push(`C${round(c1.x)} ${round(c1.y)} ${round(c2.x)} ${round(c2.y)} ${round(p2.x)} ${round(p2.y)}`);
  }
  return parts.join(" ");
};

const round = (n: number) => Math.round(n * 100) / 100;

const bounds = (pts: Point[], dots: Dot[]) => {
  const xs = [...pts.map((p) => p.x), ...dots.flatMap((d) => [d.cx - d.r, d.cx + d.r])];
  const ys = [...pts.map((p) => p.y), ...dots.flatMap((d) => [d.cy - d.r, d.cy + d.r])];
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
};

export function face(seed: Seed, size = 128): Face {
  const p = size < SMALL_SIZE ? forSmall(draw(seed)) : draw(seed);
  const arc = arcPoints(p);
  const mouth = [...arc];
  if (p.flickStart > 0) mouth.unshift(flickPoint(arc[0], arc[1], p.flickStart, -p.flickTurn));
  if (p.flickEnd > 0) mouth.push(flickPoint(arc[4], arc[3], p.flickEnd, p.flickTurn));

  const top = Math.min(arc[0].y, arc[4].y);
  const eyeY = top - p.eyeRise;
  const rLeft = p.eyeR;
  const rRight = Math.max(p.eyeR * p.eyeRatio, size < SMALL_SIZE ? 5.6 : 2.2);
  const dots: Dot[] = [
    { cx: p.eyeShift - p.eyeGap / 2, cy: eyeY - p.eyeDrop / 2, r: rLeft },
    { cx: p.eyeShift + p.eyeGap / 2, cy: eyeY + p.eyeDrop / 2, r: rRight },
  ];

  const extraDot: Dot | null = p.extra < 0.14 ? { cx: p.extraSide * p.half * 0.45, cy: p.baseY + p.depth * 0.45, r: p.eyeR * 0.6 } : null;
  const tickX = p.extraSide * (p.half + 9);
  const tickY = p.baseY - p.eyeRise * 0.35;
  const tick: [Point, Point] | null = p.extra >= 0.14 && p.extra < 0.24 ? [{ x: tickX, y: tickY }, { x: tickX + p.extraSide * 5, y: tickY - 7 }] : null;

  const allDots = [...dots, ...(extraDot ? [extraDot] : [])];
  const b = bounds([...mouth, ...(tick ?? [])], allDots);
  const inset = 7 + p.stroke / 2;
  const room = BOX - inset * 2;
  const scale = Math.min(room / Math.max(b.maxX - b.minX, 1), room / Math.max(b.maxY - b.minY, 1));
  const shiftX = inset + (room - (b.maxX - b.minX) * scale) / 2 - b.minX * scale + p.offX;
  const shiftY = inset + (room - (b.maxY - b.minY) * scale) / 2 - b.minY * scale + p.offY;
  const place = (pt: Point): Point => ({ x: pt.x * scale + shiftX, y: pt.y * scale + shiftY });
  const placeDot = (d: Dot): Dot => ({ cx: round(d.cx * scale + shiftX), cy: round(d.cy * scale + shiftY), r: round(d.r * scale) });

  const line = (a: Point, b: Point) => `M${round(a.x)} ${round(a.y)} L${round(b.x)} ${round(b.y)}`;
  const placed = mouth.map(place);
  const paths = [spline(placed), ...(tick ? [line(place(tick[0]), place(tick[1]))] : [])];

  return {
    paths,
    dots: allDots.map(placeDot),
    mouth: placed.map((pt) => ({ x: round(pt.x), y: round(pt.y) })),
    stroke: round(p.stroke),
    box: BOX,
  };
}

export function faceSvg(seed: Seed, size: number, ink = "currentColor") {
  const f = face(seed, size);
  const paths = f.paths.map((d) => `<path d="${d}"/>`).join("");
  const dots = f.dots.map((d) => `<circle cx="${d.cx}" cy="${d.cy}" r="${d.r}"/>`).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${BOX} ${BOX}" width="${size}" height="${size}" role="img" aria-label="tomo"><g fill="none" stroke="${ink}" stroke-width="${f.stroke}" stroke-linecap="round" stroke-linejoin="round">${paths}</g><g fill="${ink}">${dots}</g></svg>`;
}
