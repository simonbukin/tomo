import { History, House, Map } from "lucide-react";
import type { Signal } from "../activityModel";
import { needsMeItem } from "../activityModel";
import { openWorktree } from "../actions";
import { HoverCard, IconButton } from "../components/ui";
import { GLYPH } from "../glyphs";
import { sortWorktrees } from "../homeQuery";
import { byManualOrder } from "../order";
import { useShortcuts } from "../shortcuts";
import { signalsFor } from "../Signals";
import { agentsOf, formatBytes, needsMe, queryContext, setUi, useStore, visibleRepos, type State } from "../store";
import { KIND_LABEL, type Worktree } from "../types";

export function railWorktrees(s: State): Worktree[] {
  const repos = visibleRepos(s);
  const ordered = s.ui.sidebarSort === "manual" ? byManualOrder(repos, s.ui.repoOrder, (r) => r.id) : repos;
  const ctx = queryContext(s);
  const live = s.worktrees.filter((w) => !w.archived_at_ms);
  return ordered.flatMap((r) => sortWorktrees(live.filter((w) => w.repo_id === r.id), s.ui.sidebarSort, ctx, s.ui.manualOrder[r.id] ?? []));
}

export const identityMark = (name: string): string => {
  const letters = [...name.replace(/[^\p{L}\p{N}]/gu, "")];
  return letters.length ? `${letters[0].toUpperCase()}${(letters[1] ?? "").toLowerCase()}` : "?";
};

export function signalText(signal: Signal): string {
  switch (signal.kind) {
    case "attention":
      return `${GLYPH.needs} ${signal.text}`;
    case "crash":
      return `${GLYPH.failed} ${signal.text}`;
    case "agent":
      return signal.state === "waiting" ? `${GLYPH.needs} ${KIND_LABEL[signal.agent]} needs input` : `${signal.state === "working" ? GLYPH.working : GLYPH.idle} ${KIND_LABEL[signal.agent]}`;
    case "runtime":
      return `${signal.label} :${signal.port}`;
    case "warn":
      return `⚠ ${formatBytes(signal.bytes)}`;
    case "pr":
      return `${signal.tone === "failed" ? GLYPH.failed : GLYPH.complete} ${signal.text}`;
  }
}

/** The minimal left sidebar: views, the attention count, and one mark per worktree. */
export function LeftRail() {
  const view = useStore((s) => s.ui.view);
  const activeId = useStore((s) => (s.ui.view === "worktree" ? s.ui.activeWorktreeId : null));
  const count = useStore((s) => needsMe(s).length);
  const worktrees = useStore(railWorktrees);
  const shortcut = useShortcuts();
  const current = (v: State["ui"]["view"]) => (view === v ? "page" : undefined);
  return (
    <nav className="rail rail-left" aria-label="Sidebar">
      <IconButton label="Home" shortcut={shortcut("home")} tooltipSide="right" className="rail-btn" aria-current={current("home")} onClick={() => setUi({ view: "home" })}>
        <House className="icon" />
      </IconButton>
      <IconButton label={count ? `Activity, ${count} need you` : "Activity"} shortcut={shortcut("activity")} tooltipSide="right" className="rail-btn" aria-current={current("activity")} onClick={() => setUi({ view: "activity" })}>
        <History className="icon" />
        {count > 0 && <span className="rail-count" aria-hidden>{count}</span>}
      </IconButton>
      <IconButton label="Japan map" shortcut={shortcut("towns")} tooltipSide="right" className="rail-btn" aria-current={current("towns")} onClick={() => setUi({ view: "towns" })}>
        <Map className="icon" />
      </IconButton>
      <div className="rail-sep" />
      <div className="rail-scroll">
        {worktrees.map((w) => (
          <RailWorktree key={w.id} w={w} active={w.id === activeId} />
        ))}
      </div>
    </nav>
  );
}

function RailWorktree({ w, active }: { w: Worktree; active: boolean }) {
  const needs = useStore((s) => agentsOf(s, w.id).some((a) => a.state === "waiting") || s.attention.some((a) => a.worktree_id === w.id && a.kind !== "crash" && needsMeItem(a, Object.values(s.agents))));
  const crashed = useStore((s) => s.attention.some((a) => a.worktree_id === w.id && a.kind === "crash" && needsMeItem(a, Object.values(s.agents))));
  const label = [w.name, needs && "needs input", crashed && "crashed"].filter(Boolean).join(", ");
  const marker = needs ? "needs" : crashed ? "failed" : null;
  return (
    <HoverCard side="right" content={<RailPreview w={w} />}>
      <button type="button" className="rail-wt" aria-label={label} aria-current={active ? "page" : undefined} onClick={() => openWorktree(w.id)}>
        {identityMark(w.name)}
        {marker && <span className={`rail-marker glyph-${marker}`} aria-hidden>{GLYPH[marker]}</span>}
      </button>
    </HoverCard>
  );
}

function RailPreview({ w }: { w: Worktree }) {
  const signals = useStore((s) => signalsFor(s, w.id));
  const branch = w.detached ? `detached ${w.head.slice(0, 7)}` : (w.branch ?? "");
  return (
    <div className="preview">
      <div className="preview-head">{w.name}</div>
      {branch && <div className="mono muted">{branch}</div>}
      {signals.map((signal, i) => (
        <div key={i}>{signalText(signal)}</div>
      ))}
    </div>
  );
}
