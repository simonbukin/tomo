import { openUrl } from "@tauri-apps/plugin-opener";
import { useMemo, useState } from "react";
import { openWorktree } from "./actions";
import towns from "./data/japan-towns.json";
import { useStore } from "./store";
import type { Rarity, Town } from "./types";

const ALL = towns as Town[];
const RARITIES: Rarity[] = ["common", "uncommon", "rare", "epic", "legendary"];
const LAT_SCALE = Math.cos((36 * Math.PI) / 180);

function project(t: Pick<Town, "lat" | "lon">, box: { minLon: number; maxLat: number; w: number; h: number }): [number, number] {
  return [(t.lon - box.minLon) * LAT_SCALE * box.w, (box.maxLat - t.lat) * box.h];
}

export function Towns() {
  const unlocks = useStore((s) => s.unlocks);
  const worktrees = useStore((s) => s.worktrees);
  const [hover, setHover] = useState<Town | null>(null);
  const bySlug = useMemo(() => new Map(ALL.map((t) => [t.slug, t])), []);
  const unlocked = useMemo(() => [...unlocks].sort((a, b) => b.unlocked_at_ms - a.unlocked_at_ms).flatMap((u) => (bySlug.get(u.slug) ? [{ town: bySlug.get(u.slug)!, unlock: u }] : [])), [unlocks, bySlug]);
  const unlockedSet = useMemo(() => new Set(unlocks.map((u) => u.slug)), [unlocks]);
  const counts = RARITIES.map((r) => ({ r, total: ALL.filter((t) => t.rarity === r).length, have: unlocked.filter((u) => u.town.rarity === r).length }));

  const lons = ALL.map((t) => t.lon);
  const lats = ALL.map((t) => t.lat);
  const minLon = Math.min(...lons) - 0.5;
  const maxLon = Math.max(...lons) + 0.5;
  const minLat = Math.min(...lats) - 0.5;
  const maxLat = Math.max(...lats) + 0.5;
  const width = 1000;
  const scale = width / ((maxLon - minLon) * LAT_SCALE);
  const height = (maxLat - minLat) * scale;
  const box = { minLon, maxLat, w: scale, h: scale };

  return (
    <div className="towns rise">
      <div className="towns-map">
        <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="xMidYMid meet">
          {ALL.map((t) => {
            const [x, y] = project(t, box);
            return <circle key={t.slug} cx={x} cy={y} r={1.6} className="town-dot" />;
          })}
          {unlocked.map(({ town }) => {
            const [x, y] = project(town, box);
            return (
              <g key={town.slug} className={`town-unlocked rarity-${town.rarity}`} onMouseEnter={() => setHover(town)} onMouseLeave={() => setHover(null)}>
                <circle cx={x} cy={y} r={9} className="town-ring" />
                <circle cx={x} cy={y} r={4.5} className="town-core" />
              </g>
            );
          })}
        </svg>
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
