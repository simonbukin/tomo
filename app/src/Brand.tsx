import { BOX, face, faceFrom, TOMO, type Seed } from "./brandFace";

export function Mark({ size = 16, seed }: { size?: number; seed?: Seed }) {
  const f = seed === undefined ? faceFrom(TOMO) : face(seed, size);
  return (
    <svg className="brand-mark" width={size} height={size} viewBox={`0 0 ${BOX} ${BOX}`} role="img" aria-label="tomo">
      <g fill="none" stroke="currentColor" strokeWidth={f.stroke} strokeLinecap="round" strokeLinejoin="round">
        {f.paths.map((d) => (
          <path key={d} d={d} />
        ))}
      </g>
      <g fill="currentColor">
        {f.dots.map((d) => (
          <circle key={`${d.cx},${d.cy},${d.r}`} cx={d.cx} cy={d.cy} r={d.r} />
        ))}
      </g>
    </svg>
  );
}

const LETTERS: { x: number; y: number; w: number; h: number; c?: string }[] = [
  { x: 0, y: 1, w: 1, h: 1, c: "#7d4dff" },
  { x: 1, y: 0, w: 1, h: 4 },
  { x: 1, y: 1, w: 2, h: 1 },
  { x: 1.5, y: 3, w: 1.5, h: 1 },
  { x: 3.5, y: 1, w: 3, h: 3 },
  { x: 4.25, y: 1.75, w: 1.5, h: 1.5, c: "hole" },
  { x: 7, y: 1, w: 3.5, h: 3 },
  { x: 8, y: 1.75, w: 0.5, h: 2.25, c: "hole" },
  { x: 9.5, y: 1.75, w: 0.5, h: 2.25, c: "hole" },
  { x: 11, y: 1, w: 3, h: 3 },
  { x: 11.75, y: 1.75, w: 1.5, h: 1.5, c: "hole" },
];

export function Wordmark({ height = 14 }: { height?: number }) {
  const u = height / 4;
  const width = 14 * u;
  return (
    <svg className="brand-wordmark" width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-label="tomo">
      <mask id="tomo-holes">
        <rect width={width} height={height} fill="#fff" />
        {LETTERS.filter((l) => l.c === "hole").map((l, i) => (
          <rect key={i} x={l.x * u} y={l.y * u} width={l.w * u} height={l.h * u} fill="#000" />
        ))}
      </mask>
      <g mask="url(#tomo-holes)">
        {LETTERS.filter((l) => l.c !== "hole").map((l, i) => (
          <rect key={i} x={l.x * u} y={l.y * u} width={l.w * u} height={l.h * u} rx={u * 0.09} fill={l.c ?? "currentColor"} />
        ))}
      </g>
    </svg>
  );
}
