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

export function Wordmark({ height = 14 }: { height?: number }) {
  return (
    <span className="brand-wordmark" style={{ fontSize: `${height}px` }}>
      tomo
    </span>
  );
}
