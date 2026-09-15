import { Plus, X } from "lucide-react";
import { useState } from "react";
import { rpc } from "./api";
import { activateTab, closeTab } from "./actions";
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger, IconButton, MenuItems } from "./components/ui";
import { openMenu } from "./MenuHost";
import { spawnMenu, tabMenu } from "./menus";
import { ProcessIcon } from "./ProcessIcon";
import { useShortcuts } from "./shortcuts";
import { paneIds, useStore } from "./store";
import type { Id, Pane, Tab } from "./types";

function leadPane(tab: Tab, panes: Record<Id, Pane>): Pane | undefined {
  const ids = paneIds(tab.layout);
  const agent = ids.map((id) => panes[id]).find((p) => p?.agent && p.agent.state !== "exited");
  return agent ?? panes[tab.active_pane_id ?? ids[0] ?? ""];
}

export function TabBar({ worktreeId }: { worktreeId: Id }) {
  const tabs = useStore((s) => s.tabs[worktreeId]) ?? [];
  const panes = useStore((s) => s.panes);
  const [editing, setEditing] = useState<{ id: Id; value: string } | null>(null);
  const shortcut = useShortcuts();

  const commit = () => {
    if (editing && editing.value.trim()) rpc("tab_rename", { tab_id: editing.id, title: editing.value.trim() }).catch(() => {});
    setEditing(null);
  };

  const waiting = (tab: Tab) => Object.values(panes).some((p) => p.tab_id === tab.id && p.agent?.state === "waiting");

  return (
    <div className="tabbar" role="tablist">
      {tabs.map((t) => {
        const lead = leadPane(t, panes);
        return (
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
            {waiting(t) ? <span className="state state-waiting" /> : <ProcessIcon agent={lead?.agent?.kind} cmd={lead?.process_cmd} size={11} />}
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
            {tabs.length > 1 && (
              <IconButton
                label="Close tab"
                shortcut={t.is_active ? shortcut("close_tab") : undefined}
                className="tab-close"
                onMouseDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  closeTab(t.id);
                }}
              >
                <X className="icon" />
              </IconButton>
            )}
          </div>
        );
      })}
      <DropdownMenu>
        <DropdownMenuTrigger render={<IconButton label="New tab: terminal, browser, or agent" shortcut={shortcut("new_tab")} className="tab-new" />}>
          <Plus className="icon" />
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          <MenuItems items={() => spawnMenu(worktreeId)} />
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
