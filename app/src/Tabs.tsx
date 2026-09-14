import { Plus, X } from "lucide-react";
import { useState } from "react";
import { rpc } from "./api";
import { activateTab, closeTab, newTab } from "./actions";
import { IconButton } from "./components/ui";
import { openMenu } from "./MenuHost";
import { tabMenu } from "./menus";
import { useStore } from "./store";
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
    <div className="tabbar" role="tablist">
      {tabs.map((t) => (
        <div
          key={t.id}
          role="tab"
          aria-selected={t.is_active}
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
          <IconButton
            label="Close tab"
            className="tab-close"
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              closeTab(t.id);
            }}
          >
            <X className="icon" />
          </IconButton>
        </div>
      ))}
      <IconButton label="New tab" className="tab-new" onClick={newTab}>
        <Plus className="icon" />
      </IconButton>
    </div>
  );
}
