import { openUrl } from "@tauri-apps/plugin-opener";
import { Minus, Plus, RotateCcw } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { openWorktree } from "./actions";
import outline from "./data/japan-outline.json";
import towns from "./data/japan-towns.json";
import { useStore } from "./store";
import type { Rarity, Town } from "./types";
import "./towns.css";

const ALL = towns as Town[];
const RINGS = outline as [number, number][][];
const RARITIES: Rarity[] = ["common", "uncommon", "rare", "epic", "legendary"];
const LAT_SCALE = Math.cos((36 * Math.PI) / 180);
const WIDTH = 1000;
const MIN_ZOOM = 1;
const MAX_ZOOM = 12;

const ringPoints = RINGS.flat();
const minLon = Math.min(...ringPoints.map((p) => p[0])) - 0.3;
const maxLon = Math.max(...ringPoints.map((p) => p[0])) + 0.3;
const minLat = Math.min(...ringPoints.map((p) => p[1])) - 0.3;
const maxLat = Math.max(...ringPoints.map((p) => p[1])) + 0.3;
const SCALE = WIDTH / ((maxLon - minLon) * LAT_SCALE);
const HEIGHT = (maxLat - minLat) * SCALE;

function project(lon: number, lat: number): [number, number] {
  return [(lon - minLon) * LAT_SCALE * SCALE, (maxLat - lat) * SCALE];
}

const OUTLINE_PATH = RINGS.map((ring) => "M" + ring.map(([lon, lat]) => project(lon, lat).map((v) => v.toFixed(1)).join(" ")).join("L") + "Z").join("");

type View = { k: number; tx: number; ty: number };
const HOME: View = { k: 1, tx: 0, ty: 0 };

function zoomAt(v: View, factor: number, px: number, py: number): View {
  const k = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, v.k * factor));
  const ratio = k / v.k;
  return { k, tx: px - (px - v.tx) * ratio, ty: py - (py - v.ty) * ratio };
}

export function Towns() {
  const unlocks = useStore((s) => s.unlocks);
  const worktrees = useStore((s) => s.worktrees);
  const [hover, setHover] = useState<Town | null>(null);
  const [view, setView] = useState<View>(HOME);
  const svgRef = useRef<SVGSVGElement>(null);
  const drag = useRef<{ x: number; y: number; tx: number; ty: number; moved: boolean } | null>(null);
  const bySlug = useMemo(() => new Map(ALL.map((t) => [t.slug, t])), []);
  const unlocked = useMemo(() => [...unlocks].sort((a, b) => b.unlocked_at_ms - a.unlocked_at_ms).flatMap((u) => (bySlug.get(u.slug) ? [{ town: bySlug.get(u.slug)!, unlock: u }] : [])), [unlocks, bySlug]);
  const unlockedSet = useMemo(() => new Set(unlocks.map((u) => u.slug)), [unlocks]);
  const counts = RARITIES.map((r) => ({ r, total: ALL.filter((t) => t.rarity === r).length, have: unlocked.filter((u) => u.town.rarity === r).length }));

  const toSvg = (clientX: number, clientY: number): [number, number] => {
    const svg = svgRef.current;
    if (!svg) return [0, 0];
    const pt = svg.createSVGPoint();
    pt.x = clientX;
    pt.y = clientY;
    const p = pt.matrixTransform(svg.getScreenCTM()!.inverse());
    return [p.x, p.y];
  };
  const unitsPerPixel = () => 1 / (svgRef.current?.getScreenCTM()?.a ?? 1);

  const onWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    const [px, py] = toSvg(e.clientX, e.clientY);
    setView((v) => zoomAt(v, Math.exp(-e.deltaY * 0.002), px, py));
  };
  const onMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    drag.current = { x: e.clientX, y: e.clientY, tx: view.tx, ty: view.ty, moved: false };
  };
  const onMouseMove = (e: React.MouseEvent) => {
    const d = drag.current;
    if (!d) return;
    const u = unitsPerPixel();
    d.moved = true;
    setView((v) => ({ ...v, tx: d.tx + (e.clientX - d.x) * u, ty: d.ty + (e.clientY - d.y) * u }));
  };
  const endDrag = () => {
    drag.current = null;
  };
  const zoomCenter = (factor: number) => setView((v) => zoomAt(v, factor, WIDTH / 2, HEIGHT / 2));
  const r = (base: number) => base / view.k;

  return (
    <div className="towns rise">
      <div className="towns-map">
        <svg
          ref={svgRef}
          viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
          preserveAspectRatio="xMidYMid meet"
          className={drag.current ? "map-dragging" : ""}
          onWheel={onWheel}
          onMouseDown={onMouseDown}
          onMouseMove={onMouseMove}
          onMouseUp={endDrag}
          onMouseLeave={endDrag}
          onDoubleClick={() => setView(HOME)}
        >
          <g transform={`translate(${view.tx} ${view.ty}) scale(${view.k})`}>
            <path d={OUTLINE_PATH} className="map-land" />
            {ALL.map((t) => {
              const [x, y] = project(t.lon, t.lat);
              return <circle key={t.slug} cx={x} cy={y} r={r(1.6)} className="town-dot" />;
            })}
            {unlocked.map(({ town }) => {
              const [x, y] = project(town.lon, town.lat);
              return (
                <g key={town.slug} className={`town-unlocked rarity-${town.rarity}`} onMouseEnter={() => setHover(town)} onMouseLeave={() => setHover(null)}>
                  <circle cx={x} cy={y} r={r(9)} className="town-ring" />
                  <circle cx={x} cy={y} r={r(4.5)} className="town-core" />
                </g>
              );
            })}
          </g>
        </svg>
        <div className="map-controls">
          <button className="ghost" title="Zoom in" onClick={() => zoomCenter(1.5)}><Plus className="icon" /></button>
          <button className="ghost" title="Zoom out" onClick={() => zoomCenter(1 / 1.5)}><Minus className="icon" /></button>
          <button className="ghost" title="Reset view" onClick={() => setView(HOME)}><RotateCcw className="icon" /></button>
        </div>
        {hover && (
          <div className="town-tip rise">
            <span className={`rarity-dot rarity-${hover.rarity}`} /> {hover.name} <span className="muted">{hover.ja}</span>
            <div className="faint">{hover.pref} · {hover.kind} · {hover.rarity}</div>
          </div>
        )}
      </div>
      <div className="towns-list">
        <div className="section-label">collection<span className="right">{unlocked.length} / {ALL.length}</span></div>
        <div className="rarity-row">
          {counts.map((c) => (
            <span key={c.r} className="rarity-count" title={c.r}>
              <span className={`rarity-dot rarity-${c.r}`} /> {c.have}<span className="faint">/{c.total}</span>
            </span>
          ))}
        </div>
        {unlocked.length === 0 && <div className="towns-empty muted">Create a worktree to unlock your first town.</div>}
        {unlocked.map(({ town, unlock }) => {
          const w = worktrees.find((x) => x.id === unlock.worktree_id);
          return (
            <div key={town.slug} className="town-row" onMouseEnter={() => setHover(town)} onMouseLeave={() => setHover(null)}>
              <span className={`rarity-dot rarity-${town.rarity}`} title={town.rarity} />
              <div className="town-main">
                <div>
                  <button className="link town-name" onClick={() => openUrl(town.wiki).catch(() => {})}>{town.name}</button>
                  <span className="muted"> {town.ja}</span>
                </div>
                <div className="faint">
                  {town.pref} · {town.rarity}
                  {w && <> · <button className="link" onClick={() => openWorktree(w.id)}>{w.name}</button></>}
                  {" · "}{new Date(unlock.unlocked_at_ms).toLocaleDateString()}
                </div>
              </div>
            </div>
          );
        })}
        <div className="faint towns-note">{ALL.length - unlockedSet.size} towns still locked</div>
      </div>
    </div>
  );
}

export function townBySlug(slug: string): Town | undefined {
  return ALL.find((t) => t.slug === slug);
}
