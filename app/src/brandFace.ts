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

export type Params = {
  half: number;
  depth: number;
  bend: number;
  lean: number;
  stroke: number;
  eyeGap: number;
  eyeR: number;
  eyeRise: number;
};

export const TOMO: Params = {
  half: 29,
  depth: 11,
  bend: 0.25,
  lean: -3,
  stroke: 12,
  eyeGap: 42.5,
  eyeR: 7.4,
  eyeRise: 19,
};

const draw = (seed: Seed): Params => {
  const next = mulberry32(fnv1a(String(seed)));
  const span = (lo: number, hi: number) => lo + next() * (hi - lo);
  return {
    half: span(20, 32),
    depth: span(11, 27),
    bend: span(-0.2, 0.2),
    lean: span(-4, 4),
    stroke: span(7.5, 13),
    eyeGap: span(30, 46),
    eyeR: span(4.8, 7.2),
    eyeRise: span(16, 30),
  };
};

const forSmall = (p: Params): Params => ({
  ...p,
  half: Math.max(p.half, 23),
  depth: Math.max(p.depth, 15),
  bend: p.bend * 0.5,
  lean: p.lean * 0.5,
  stroke: Math.min(Math.max(p.stroke, 9.5), 12),
  eyeGap: Math.max(p.eyeGap, 33),
  eyeR: Math.max(p.eyeR, 6),
  eyeRise: Math.min(Math.max(p.eyeRise, 18), 27),
});

const round = (n: number) => Math.round(n * 100) / 100;

const quad = (a: Point, c: Point, b: Point, t: number): Point => {
  const u = 1 - t;
  return {
    x: u * u * a.x + 2 * u * t * c.x + t * t * b.x,
    y: u * u * a.y + 2 * u * t * c.y + t * t * b.y,
  };
};

const SAMPLES = 21;

export function face(seed: Seed, size = 128): Face {
  return faceFrom(size < SMALL_SIZE ? forSmall(draw(seed)) : draw(seed));
}

export function faceFrom(p: Params): Face {
  const start: Point = { x: -p.half, y: -p.lean };
  const end: Point = { x: p.half, y: p.lean };
  const control: Point = { x: p.bend * p.half, y: p.depth * 2 };

  const curve = Array.from({ length: SAMPLES }, (_, i) => quad(start, control, end, i / (SAMPLES - 1)));

  const eyeY = Math.min(start.y, end.y) - p.eyeRise;
  const dots: Dot[] = [
    { cx: -p.eyeGap / 2, cy: eyeY, r: p.eyeR },
    { cx: p.eyeGap / 2, cy: eyeY, r: p.eyeR },
  ];

  const xs = [...curve.map((c) => c.x), ...dots.flatMap((d) => [d.cx - d.r, d.cx + d.r])];
  const ys = [...curve.map((c) => c.y), ...dots.flatMap((d) => [d.cy - d.r, d.cy + d.r])];
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);

  const inset = 8 + p.stroke / 2;
  const room = BOX - inset * 2;
  const scale = Math.min(room / Math.max(maxX - minX, 1), room / Math.max(maxY - minY, 1));
  const shiftX = inset + (room - (maxX - minX) * scale) / 2 - minX * scale;
  const shiftY = inset + (room - (maxY - minY) * scale) / 2 - minY * scale;
  const place = (pt: Point): Point => ({ x: round(pt.x * scale + shiftX), y: round(pt.y * scale + shiftY) });

  const a = place(start);
  const c = place(control);
  const b = place(end);

  return {
    paths: [`M${a.x} ${a.y} Q${c.x} ${c.y} ${b.x} ${b.y}`],
    dots: dots.map((d) => ({ cx: round(d.cx * scale + shiftX), cy: round(d.cy * scale + shiftY), r: round(d.r * scale) })),
    mouth: curve.map(place),
    stroke: round(p.stroke),
    box: BOX,
  };
}

export function tomoSvg(size: number, ink = "currentColor") {
  return svgFor(faceFrom(TOMO), size, ink);
}

export function faceSvg(seed: Seed, size: number, ink = "currentColor") {
  return svgFor(face(seed, size), size, ink);
}

function svgFor(f: Face, size: number, ink: string) {
  const paths = f.paths.map((d) => `<path d="${d}"/>`).join("");
  const dots = f.dots.map((d) => `<circle cx="${d.cx}" cy="${d.cy}" r="${d.r}"/>`).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${BOX} ${BOX}" width="${size}" height="${size}" role="img" aria-label="tomo"><g fill="none" stroke="${ink}" stroke-width="${f.stroke}" stroke-linecap="round" stroke-linejoin="round">${paths}</g><g fill="${ink}">${dots}</g></svg>`;
}
