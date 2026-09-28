import { AppWindow, Bot, History, House } from "lucide-react";
import { Fragment } from "react";
import { addonViews, appsAvailable } from "../addons";
import { openWorktree } from "../actions";
import { IconButton, Tooltip } from "../components/ui";
import { STATUS_LABEL, statusDot } from "../glyphs";
import { sortWorktrees, worktreeStatus } from "../homeQuery";
import { byManualOrder } from "../order";
import { useShortcuts } from "../shortcuts";
import { WorktreePreview } from "../WorktreePreview";
import { needsMe, queryContext, setUi, type State, useStore, visibleRepos } from "../store";
import type { Worktree } from "../types";

export function railWorktrees(s: State): Worktree[] {
  const repos = visibleRepos(s);
  const ordered = s.ui.sidebarSort === "manual" ? byManualOrder(repos, s.ui.repoOrder, (r) => r.id) : repos;
  const ctx = queryContext(s);
  const live = s.worktrees.filter((w) => !w.archived_at_ms);
  return ordered.flatMap((r) => sortWorktrees(live.filter((w) => w.repo_id === r.id), s.ui.sidebarSort, ctx, s.ui.manualOrder[r.id] ?? []));
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
      <div className="column-head rail-head" data-tauri-drag-region />
      <IconButton label="Home" shortcut={shortcut("home")} tooltipSide="right" tooltipDelay={0} className="rail-btn" aria-current={current("home")} onClick={() => setUi({ view: "home" })}>
        <House className="icon" />
      </IconButton>
      <IconButton label={count ? `Activity, ${count} need you` : "Activity"} shortcut={shortcut("activity")} tooltipSide="right" tooltipDelay={0} className="rail-btn" aria-current={current("activity")} onClick={() => setUi({ view: "activity" })}>
        <History className="icon" />
      </IconButton>
      <IconButton label="Agents" shortcut={shortcut("agents")} tooltipSide="right" tooltipDelay={0} className="rail-btn" aria-current={current("agents")} onClick={() => setUi({ view: "agents" })}>
        <Bot className="icon" />
      </IconButton>
      {appsAvailable() && (
        <IconButton label="Apps" shortcut={shortcut("apps")} tooltipSide="right" tooltipDelay={0} className="rail-btn" aria-current={current("apps")} onClick={() => setUi({ view: "apps" })}>
          <AppWindow className="icon" />
        </IconButton>
      )}
      {addonViews().map((v) => (
        <IconButton key={v.id} label={v.label} shortcut={shortcut(v.id)} tooltipSide="right" tooltipDelay={0} className="rail-btn" aria-current={current(v.id)} onClick={() => setUi({ view: v.id })}>
          <v.icon className="icon" />
        </IconButton>
      ))}
      <div className="rail-sep" />
      <div className="rail-scroll">
        {worktrees.map((w, i) => (
          <Fragment key={w.id}>
            {i > 0 && worktrees[i - 1].repo_id !== w.repo_id && <div className="rail-sep" />}
            <RailWorktree w={w} active={w.id === activeId} />
          </Fragment>
        ))}
      </div>
    </nav>
  );
}

function RailWorktree({ w, active }: { w: Worktree; active: boolean }) {
  const status = useStore((s) => worktreeStatus(w, queryContext(s)));
  const label = [w.name, status && STATUS_LABEL[status]].filter(Boolean).join(", ");
  return (
    <Tooltip side="right" delay={0} content={<WorktreePreview w={w} />}>
      <button type="button" className="rail-wt" aria-label={label} aria-current={active ? "page" : undefined} onClick={() => openWorktree(w.id)}>
        <span {...statusDot(status)} aria-hidden />
      </button>
    </Tooltip>
  );
}
