import { Ellipsis, Plus, TriangleAlert, X } from "lucide-react";
import { useRef, useState } from "react";
import { rpc } from "./api";
import { activateTab, closeTab, newTab, runWorktreeAction } from "./actions";
import { openMenu, openMenuAt } from "./ContextMenu";
import { describeBinding } from "./keys";
import { overflowMenu, runningActionItems, tabMenu } from "./menus";
import { runningActionIds, useStore } from "./store";
import type { Id, Tab } from "./types";

export function TabBar({ worktreeId }: { worktreeId: Id }) {
  const tabs = useStore((s) => s.tabs[worktreeId]) ?? [];
  const panes = useStore((s) => s.panes);
  const [editing, setEditing] = useState<{ id: Id; value: string } | null>(null);

  const commit = () => {
    if (editing && editing.value.trim()) rpc("tab_rename", { tab_id: editing.id, title: editing.value.trim() }).catch(() => {});
    setEditing(null);
  };

  const waiting = (tab: Tab) => Object.values(panes).some((p) => p.tab_id === tab.id && p.agent?.state === "waiting");

  return (
    <div className="tabbar">
      {tabs.map((t) => (
        <div
          key={t.id}
          className={`tab${t.is_active ? " tab-active" : ""}`}
          onMouseDown={(e) => {
            if (e.button === 1) closeTab(t.id);
            else if (!editing) activateTab(t.id);
          }}
          onDoubleClick={() => setEditing({ id: t.id, value: t.title })}
          onContextMenu={(e) => openMenu(e, tabMenu(t, () => setEditing({ id: t.id, value: t.title })))}
        >
          {waiting(t) && <span className="state state-waiting" />}
          {editing?.id === t.id ? (
            <input
              autoFocus
              className="tab-edit"
              value={editing.value}
              onChange={(e) => setEditing({ id: t.id, value: e.target.value })}
              onBlur={commit}
              onKeyDown={(e) => {
                if (e.key === "Enter") commit();
                if (e.key === "Escape") setEditing(null);
              }}
            />
          ) : (
            <span className="tab-title">{t.title}</span>
          )}
          <button
            className="tab-close"
            title="Close tab"
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              closeTab(t.id);
            }}
          >
            <X className="icon" />
          </button>
        </div>
      ))}
      <button className="tab-new" title="New tab" onClick={newTab}><Plus className="icon" /></button>
      <ActionBar worktreeId={worktreeId} />
    </div>
  );
}

function ActionBar({ worktreeId }: { worktreeId: Id }) {
  const set = useStore((s) => s.actions[worktreeId] ?? null);
  const running = useStore((s) => runningActionIds(s, worktreeId));
  const w = useStore((s) => s.worktrees.find((x) => x.id === worktreeId) ?? null);
  const moreBtn = useRef<HTMLButtonElement>(null);
  if (!w) return null;
  const topbar = (set?.actions ?? []).filter((a) => a.show === "topbar");
  return (
    <div className="actionbar">
      {topbar.map((a) => {
        const live = running.includes(a.id);
        return (
          <button
            key={a.id}
            className="ghost action-btn"
            title={[a.command, a.shortcut ? describeBinding(a.shortcut) : null].filter(Boolean).join(" · ")}
            onClick={() => runWorktreeAction(worktreeId, a.id)}
            onContextMenu={(e) => live && openMenu(e, runningActionItems(worktreeId, a.id))}
          >
            {live && <span className="state state-working" />}
            {a.label}
          </button>
        );
      })}
      {set?.error && <span className="action-warn" title={set.error}><TriangleAlert className="icon" /></span>}
      <button ref={moreBtn} className="ghost" title="More" onClick={() => openMenuAt(moreBtn.current!, overflowMenu(w))}><Ellipsis className="icon" /></button>
    </div>
  );
}
