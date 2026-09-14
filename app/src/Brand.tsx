const MARK = [
  { x: 0.75, y: 0, w: 1, h: 3.5 },
  { x: 0, y: 1, w: 2.5, h: 1 },
  { x: 1.25, y: 3, w: 2, h: 1 },
];

export function Mark({ size = 16, tile = false }: { size?: number; tile?: boolean }) {
  const u = tile ? size * 0.115 : size / 4;
  const ox = tile ? (size - 3.5 * u) / 2 : 0;
  const oy = tile ? (size - 4 * u) / 2 : 0;
  const r = u * 0.09;
  const ink = tile ? "#ffffff" : "currentColor";
  return (
    <svg className="brand-mark" width={tile ? size : size * 0.875} height={size} viewBox={`0 0 ${tile ? size : size * 0.875} ${size}`} aria-label="tomo">
      {tile && <rect width={size} height={size} rx={size * 0.225} fill="#0f0f12" />}
      {MARK.map((p, i) => (
        <rect key={i} x={ox + p.x * u} y={oy + p.y * u} width={p.w * u} height={p.h * u} rx={r} fill={ink} />
      ))}
      <rect x={ox + 2.5 * u} y={oy} width={u} height={u} rx={r} fill="#7d4dff" />
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
