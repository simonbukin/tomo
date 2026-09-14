import { openUrl } from "@tauri-apps/plugin-opener";
import { ExternalLink, Minus, Plus, RotateCcw } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { openWorktree } from "./actions";
import outline from "./data/japan-outline.json";
import towns from "./data/japan-towns.json";
import { useStore } from "./store";
import type { Rarity, Town, TownUnlock } from "./types";
import "./towns.css";

const ALL = towns as Town[];
const RINGS = outline as [number, number][][];
const RARITIES: Rarity[] = ["common", "uncommon", "rare", "epic", "legendary"];
const LAT_SCALE = Math.cos((36 * Math.PI) / 180);
const WIDTH = 1000;
const MIN_ZOOM = 1;
const MAX_ZOOM = 12;
const HIDE_DELAY_MS = 180;

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

type Hover = { town: Town; unlock: TownUnlock | null; x: number; y: number };

export function Towns() {
  const unlocks = useStore((s) => s.unlocks);
  const worktrees = useStore((s) => s.worktrees);
  const [hover, setHover] = useState<Hover | null>(null);
  const [view, setView] = useState<View>(HOME);
  const svgRef = useRef<SVGSVGElement>(null);
  const mapRef = useRef<HTMLDivElement>(null);
  const hideTimer = useRef<number | undefined>(undefined);
  const drag = useRef<{ x: number; y: number; tx: number; ty: number; moved: boolean } | null>(null);
  const bySlug = useMemo(() => new Map(ALL.map((t) => [t.slug, t])), []);
  const unlockBySlug = useMemo(() => new Map(unlocks.map((u) => [u.slug, u])), [unlocks]);
  const unlocked = useMemo(() => [...unlocks].sort((a, b) => b.unlocked_at_ms - a.unlocked_at_ms).flatMap((u) => (bySlug.get(u.slug) ? [{ town: bySlug.get(u.slug)!, unlock: u }] : [])), [unlocks, bySlug]);
  const counts = RARITIES.map((r) => ({ r, total: ALL.filter((t) => t.rarity === r).length, have: unlocked.filter((u) => u.town.rarity === r).length }));

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setHover(null);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.clearTimeout(hideTimer.current);
    };
  }, []);

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

  const show = (town: Town, e: { clientX: number; clientY: number }) => {
    window.clearTimeout(hideTimer.current);
    const box = mapRef.current?.getBoundingClientRect();
    setHover({ town, unlock: unlockBySlug.get(town.slug) ?? null, x: e.clientX - (box?.left ?? 0), y: e.clientY - (box?.top ?? 0) });
  };
  const scheduleHide = () => {
    window.clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(() => setHover(null), HIDE_DELAY_MS);
  };
  const keep = () => window.clearTimeout(hideTimer.current);

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
  const cardStyle = (h: Hover): React.CSSProperties => {
    const box = mapRef.current?.getBoundingClientRect();
    const flipX = box ? h.x > box.width - 240 : false;
    const flipY = box ? h.y > box.height - 150 : false;
    return { left: flipX ? h.x - 232 : h.x + 14, top: flipY ? h.y - 130 : h.y + 14 };
  };

  return (
    <div className="towns rise">
      <div className="towns-map" ref={mapRef}>
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
              if (unlockBySlug.has(t.slug)) return null;
              const [x, y] = project(t.lon, t.lat);
              return <g key={t.slug} onMouseEnter={(e) => show(t, e)} onMouseLeave={scheduleHide}><circle cx={x} cy={y} r={r(7)} className="town-hit" /><circle cx={x} cy={y} r={r(3)} className={`town-dot rarity-${t.rarity}`} /></g>;
            })}
            {unlocked.map(({ town }) => {
              const [x, y] = project(town.lon, town.lat);
              return (
                <g key={town.slug} className={`town-unlocked rarity-${town.rarity}`} onMouseEnter={(e) => show(town, e)} onMouseLeave={scheduleHide}>
                  <circle cx={x} cy={y} r={r(11)} className="town-ring" />
                  <circle cx={x} cy={y} r={r(6)} className="town-core" />
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
        {hover && <TownCard hover={hover} style={cardStyle(hover)} onEnter={keep} onLeave={scheduleHide} worktreeName={worktrees.find((w) => w.id === hover.unlock?.worktree_id)?.name} openWorktree={() => hover.unlock && openWorktree(hover.unlock.worktree_id)} />}
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
            <div key={town.slug} className="town-row">
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
        <div className="faint towns-note">{ALL.length - unlockBySlug.size} towns still locked</div>
      </div>
    </div>
  );
}

function TownCard({ hover, style, onEnter, onLeave, worktreeName, openWorktree }: { hover: Hover; style: React.CSSProperties; onEnter: () => void; onLeave: () => void; worktreeName?: string; openWorktree: () => void }) {
  const t = hover.town;
  return (
    <div className="town-card rise" style={style} onMouseEnter={onEnter} onMouseLeave={onLeave}>
      <div className="town-card-title">
        <span className={`rarity-dot rarity-${t.rarity}`} />
        <strong>{t.name}</strong>
        <span className="muted">{t.ja}</span>
      </div>
      <div className="faint">{t.pref} · {t.kind} · {t.rarity}{t.population != null ? ` · ${t.population.toLocaleString()} people` : ""}</div>
      {hover.unlock && (
        <div className="faint">
          unlocked {new Date(hover.unlock.unlocked_at_ms).toLocaleDateString()}
          {worktreeName && <> · <button className="link" onClick={openWorktree}>{worktreeName}</button></>}
        </div>
      )}
      <button className="link" onClick={() => openUrl(t.wiki).catch(() => {})}><ExternalLink className="icon" width={12} height={12} /> wikipedia</button>
    </div>
  );
}

export function townBySlug(slug: string): Town | undefined {
  return ALL.find((t) => t.slug === slug);
}
