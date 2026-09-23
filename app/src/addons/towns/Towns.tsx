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
import {failToast, setState, useStore} from "../../store";
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
const CARD_W = 280;
const CARD_MAX_H = 7 * 28;

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

const square = (x: number, y: number, size: number, className: string) => <rect x={x - size / 2} y={y - size / 2} width={size} height={size} className={className} />;

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
    const flipX = box ? h.x > box.width - CARD_W - 20 : false;
    const flipY = box ? h.y > box.height - CARD_MAX_H - 20 : false;
    return { left: flipX ? h.x - CARD_W - 14 : h.x + 14, top: flipY ? h.y - CARD_MAX_H - 14 : h.y + 14 };
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
              return <g key={t.slug} className={`rarity-${t.rarity}`} onMouseEnter={(e) => show(t, e)} onMouseLeave={scheduleHide}>{square(x, y, r(12), "town-hit")}{square(x, y, r(2.4), "town-dot")}</g>;
            })}
            {unlocked.map(({ town }) => {
              const [x, y] = project(town.lon, town.lat);
              return (
                <g key={town.slug} className={`town-unlocked rarity-${town.rarity}${town.slug === selected ? " town-selected" : ""}`} onMouseEnter={(e) => show(town, e)} onMouseLeave={scheduleHide} onClick={() => selectOnMap(town.slug)}>
                  {square(x, y, r(18), "town-hit")}
                  {square(x, y, r(10), "town-ring")}
                  {square(x, y, r(4), "town-core")}
                  {town.slug === selected && square(x, y, r(18), "town-selection")}
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
        <div className="section-label">Collection<span className="right mono">{unlocked.length} / {ALL.length}</span></div>
        <div className="rarity-row">
          {counts.map((c) => (
            <span key={c.r} className="rarity-count" title={`${c.have} of ${c.total} ${c.r}`}>
              <span className={`rarity-dot rarity-${c.r}`} />{c.have}
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
        {unlocked.map(({ town }) => (
          <button key={town.slug} type="button" className={`town-row${town.slug === selected ? " town-row-selected" : ""}`} aria-pressed={town.slug === selected} onClick={() => setSelected(town.slug)}>
            <span className={`rarity-dot rarity-${town.rarity}`} />
            <span className="town-name">{town.name}</span>
            <span className="town-ja">{town.ja}</span>
            <span className="town-rarity">{town.rarity}</span>
          </button>
        ))}
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
      <div className="town-head">
        <span className={`rarity-dot rarity-${town.rarity}`} />
        <strong>{town.name}</strong>
        <span className="town-ja">{town.ja}</span>
        <IconButton label="Close town details" className="town-detail-close" onClick={onClose}><X className="icon" /></IconButton>
      </div>
      <div className="town-fact"><label>place</label><span>{town.pref} · {town.kind}</span></div>
      <div className="town-fact"><label>rarity</label><span>{town.rarity}</span></div>
      {error && <InlineError>history unavailable: {error}</InlineError>}
      {!h && !error && <SkeletonRows count={4} className="compact" label="loading town history" />}
      {h && (
        <>
          <div className="town-fact"><label>unlocked</label><span>{day(h.unlock.unlocked_at_ms)}</span></div>
          <div className="town-fact">
            <label>worktree</label>
            <span title={h.worktree_name ?? undefined}>
              {h.status === "active" ? <button className="link" onClick={() => openWorktree(h.unlock.worktree_id)}>{h.branch ?? h.worktree_name ?? "open"}</button> : (h.branch ?? "—")}
            </span>
          </div>
          <div className="town-fact"><label>status</label><span>{h.status}</span></div>
          <div className="town-fact"><label>{liveTree ? "head" : "final commit"}</label><span title={h.final_commit ?? undefined}>{h.final_commit?.slice(0, 7) ?? "—"}</span></div>
          {h.pr && <div className="town-fact"><label>PR</label><span><button className="link" onClick={() => openUrl(h.pr!.url).catch(failToast("Could not open the link"))}>#{h.pr.number} {h.pr.state}</button></span></div>}
          <div className="town-fact"><label>repo</label><span>{h.repo_name ?? "—"}</span></div>
          {h.archived_at_ms != null && <div className="town-fact"><label>archived</label><span>{day(h.archived_at_ms)}</span></div>}
        </>
      )}
      <WikiRow town={town} />
    </section>
  );
}

function WikiRow({ town }: { town: Town }) {
  return (
    <button type="button" className="town-wiki" onClick={() => openUrl(town.wiki).catch(failToast("Could not open the link"))}>
      <span>Wikipedia</span>
      <ExternalLink className="icon" />
    </button>
  );
}

function TownCard({ hover, style, onEnter, onLeave, worktreeName, openWorktree }: { hover: Hover; style: React.CSSProperties; onEnter: () => void; onLeave: () => void; worktreeName?: string; openWorktree: () => void }) {
  const t = hover.town;
  return (
    <div className="town-card rise" style={style} onMouseEnter={onEnter} onMouseLeave={onLeave}>
      <div className="town-head">
        <span className={`rarity-dot rarity-${t.rarity}`} />
        <strong>{t.name}</strong>
        <span className="town-ja">{t.ja}</span>
      </div>
      <div className="town-fact"><label>place</label><span>{t.pref} · {t.kind}</span></div>
      <div className="town-fact"><label>rarity</label><span>{t.rarity}</span></div>
      {t.population != null && <div className="town-fact"><label>people</label><span>{t.population.toLocaleString()}</span></div>}
      {hover.unlock && <div className="town-fact"><label>unlocked</label><span>{day(hover.unlock.unlocked_at_ms)}</span></div>}
      {hover.unlock && worktreeName && <div className="town-fact"><label>worktree</label><span><button className="link" onClick={openWorktree}>{worktreeName}</button></span></div>}
      <WikiRow town={t} />
    </div>
  );
}

export function townBySlug(slug: string): Town | undefined {
  return ALL.find((t) => t.slug === slug);
}
