import { townHistorySchema } from "../../schemas";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ExternalLink, Minus, Plus, RotateCcw, X } from "lucide-react";
import { Button, IconButton, SkeletonRows } from "../../components/ui";
import { useEffect, useMemo, useRef, useState } from "react";
import { openWorktree } from "../../actions";
import { rpcParsed } from "../../api";
import outline from "./data/japan-outline.json";
import towns from "./data/japan-towns.json";
import { townsProgress, type Rarity } from "./model";
import { EmptyState, InlineError } from "../../states";
import { setState, useStore } from "../../store";
import { getTownState, useTownState } from "./state";
import type { Town, TownHistory, TownUnlock } from "../../generated";

const ALL = towns as Town[];
const RINGS = outline as [number, number][][];
const RARITIES: Rarity[] = ["common", "uncommon", "rare", "epic", "legendary"];
const LAT_SCALE = Math.cos((36 * Math.PI) / 180);
const WIDTH = 1000;
const MIN_ZOOM = 1;
const MAX_ZOOM = 12;
const HIDE_DELAY_MS = 180;
const DRAG_THRESHOLD_PX = 3;

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

const day = (ms: number) => new Date(ms).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });

type Hover = { town: Town; unlock: TownUnlock | null; x: number; y: number };

export function Towns() {
  const unlocks = useTownState((s) => s.unlocks);
  const worktrees = useStore((s) => s.worktrees);
  const [hover, setHover] = useState<Hover | null>(null);
  const [view, setView] = useState<View>(HOME);
  const [selected, setSelected] = useState<string | null>(() => getTownState().reveal?.unlock.slug ?? null);
  const svgRef = useRef<SVGSVGElement>(null);
  const mapRef = useRef<HTMLDivElement>(null);
  const hideTimer = useRef<number | undefined>(undefined);
  const drag = useRef<{ x: number; y: number; tx: number; ty: number; moved: boolean } | null>(null);
  const lastDragMoved = useRef(false);
  const bySlug = useMemo(() => new Map(ALL.map((t) => [t.slug, t])), []);
  const unlockBySlug = useMemo(() => new Map(unlocks.map((u) => [u.slug, u])), [unlocks]);
  const unlocked = useMemo(() => [...unlocks].sort((a, b) => b.unlocked_at_ms - a.unlocked_at_ms).flatMap((u) => (bySlug.get(u.slug) ? [{ town: bySlug.get(u.slug)!, unlock: u }] : [])), [unlocks, bySlug]);
  const counts = RARITIES.map((r) => ({ r, total: ALL.filter((t) => t.rarity === r).length, have: unlocked.filter((u) => u.town.rarity === r).length }));
  const selectedTown = selected && unlockBySlug.has(selected) ? (bySlug.get(selected) ?? null) : null;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setHover(null);
      setSelected(null);
    };
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
    d.moved ||= Math.abs(e.clientX - d.x) + Math.abs(e.clientY - d.y) > DRAG_THRESHOLD_PX;
    setView((v) => ({ ...v, tx: d.tx + (e.clientX - d.x) * u, ty: d.ty + (e.clientY - d.y) * u }));
  };
  const endDrag = () => {
    lastDragMoved.current = drag.current?.moved ?? false;
    drag.current = null;
  };
  const selectOnMap = (slug: string) => !lastDragMoved.current && setSelected(slug);
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
                <g key={town.slug} className={`town-unlocked rarity-${town.rarity}${town.slug === selected ? " town-selected" : ""}`} onMouseEnter={(e) => show(town, e)} onMouseLeave={scheduleHide} onClick={() => selectOnMap(town.slug)}>
                  <circle cx={x} cy={y} r={r(11)} className="town-ring" />
                  <circle cx={x} cy={y} r={r(6)} className="town-core" />
                </g>
              );
            })}
          </g>
        </svg>
        <div className="map-controls">
          <IconButton label="Zoom in" tooltipSide="left" onClick={() => zoomCenter(1.5)}><Plus className="icon" /></IconButton>
          <IconButton label="Zoom out" tooltipSide="left" onClick={() => zoomCenter(1 / 1.5)}><Minus className="icon" /></IconButton>
          <IconButton label="Reset view" tooltipSide="left" onClick={() => setView(HOME)}><RotateCcw className="icon" /></IconButton>
        </div>
        {hover && <TownCard hover={hover} style={cardStyle(hover)} onEnter={keep} onLeave={scheduleHide} worktreeName={worktrees.find((w) => w.id === hover.unlock?.worktree_id)?.name} openWorktree={() => hover.unlock && openWorktree(hover.unlock.worktree_id)} />}
      </div>
      <div className="towns-list">
        {selectedTown && <TownDetail key={selectedTown.slug} town={selectedTown} onClose={() => setSelected(null)} />}
        <div className="section-label">collection<span className="right">{unlocked.length} / {ALL.length}</span></div>
        <div className="rarity-row">
          {counts.map((c) => (
            <span key={c.r} className="rarity-count" title={c.r}>
              <span className={`rarity-dot rarity-${c.r}`} /> {c.have}<span className="faint">/{c.total}</span>
            </span>
          ))}
        </div>
        {unlocked.length === 0 && (
          <EmptyState
            className="compact"
            title={townsProgress(0, ALL.length)}
            detail="Create a worktree to discover somewhere."
            action={<Button size="sm" onClick={() => setState({ dialog: { kind: "create-worktree" } })}>New worktree</Button>}
          />
        )}
        {unlocked.map(({ town, unlock }) => {
          const w = worktrees.find((x) => x.id === unlock.worktree_id);
          return (
            <div key={town.slug} className={`town-row${town.slug === selected ? " town-row-selected" : ""}`} onClick={() => setSelected(town.slug)}>
              <span className={`rarity-dot rarity-${town.rarity}`} title={town.rarity} />
              <div className="town-main">
                <div>
                  <button className="link town-name" aria-pressed={town.slug === selected} onClick={(e) => { e.stopPropagation(); setSelected(town.slug); }}>{town.name}</button>
                  <span className="muted"> {town.ja}</span>
                </div>
                <div className="faint">
                  {town.pref} · {town.rarity}
                  {w && <> · <button className="link" onClick={(e) => { e.stopPropagation(); openWorktree(w.id); }}>{w.name}</button></>}
                  {" · "}{day(unlock.unlocked_at_ms)}
                </div>
              </div>
            </div>
          );
        })}
        {unlocked.length > 0 && <div className="faint towns-note">{ALL.length - unlockBySlug.size} towns still locked</div>}
      </div>
    </div>
  );
}

/** The factual history of one unlocked town. It keeps the last good result on screen while it refreshes. */
function TownDetail({ town, onClose }: { town: Town; onClose: () => void }) {
  const worktreeId = useTownState((s) => s.unlocks.find((u) => u.slug === town.slug)?.worktree_id ?? null);
  const worktreeKey = useStore((s) => {
    const w = s.worktrees.find((x) => x.id === worktreeId);
    return w ? `${w.archived_at_ms ?? ""}:${w.exists}:${w.head}:${w.branch ?? ""}` : "gone";
  });
  const [history, setHistory] = useState<TownHistory | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    rpcParsed("town_history", townHistorySchema, { slug: town.slug })
      .then((h) => {
        if (!live) return;
        setHistory(h);
        setError(null);
      })
      .catch((e) => live && setError((e as Error).message));
    return () => {
      live = false;
    };
  }, [town.slug, worktreeId, worktreeKey]);

  const h = history;
  const liveTree = h && (h.status === "active" || h.status === "missing");
  return (
    <section className="town-detail rise" aria-label={`${town.name} history`}>
      <div className="town-detail-head">
        <span className={`rarity-dot rarity-${town.rarity}`} />
        <strong>{town.name}</strong>
        <span className="muted">{town.ja}</span>
        <IconButton label="Close town details" className="town-detail-close" onClick={onClose}><X className="icon" /></IconButton>
      </div>
      <div className="faint">{town.pref} · {town.kind} · {town.rarity}</div>
      {error && <InlineError>history unavailable: {error}</InlineError>}
      {!h && !error && <SkeletonRows count={5} className="compact" label="loading town history" />}
      {h && (
        <div className="town-facts">
          <div className="kv"><label>unlocked</label><span>{day(h.unlock.unlocked_at_ms)}</span></div>
          <div className="kv">
            <label>worktree</label>
            <span className="mono" title={h.worktree_name ?? undefined}>
              {h.status === "active" ? <button className="link mono" onClick={() => openWorktree(h.unlock.worktree_id)}>{h.branch ?? h.worktree_name ?? "open"}</button> : (h.branch ?? "—")}
            </span>
          </div>
          <div className="kv"><label>status</label><span>{h.status}</span></div>
          <div className="kv"><label>{liveTree ? "head" : "final commit"}</label><span className="mono" title={h.final_commit ?? undefined}>{h.final_commit?.slice(0, 7) ?? "—"}</span></div>
          {h.pr && <div className="kv"><label>pull request</label><span><button className="link" onClick={() => openUrl(h.pr!.url).catch(() => {})}>#{h.pr.number} {h.pr.state}</button></span></div>}
          <div className="kv"><label>repo</label><span>{h.repo_name ?? "—"}</span></div>
          {h.archived_at_ms != null && <div className="kv"><label>archived</label><span>{day(h.archived_at_ms)}</span></div>}
        </div>
      )}
      <button className="link" onClick={() => openUrl(town.wiki).catch(() => {})}><ExternalLink className="icon" width={12} height={12} /> wikipedia</button>
    </section>
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
          unlocked {day(hover.unlock.unlocked_at_ms)}
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
