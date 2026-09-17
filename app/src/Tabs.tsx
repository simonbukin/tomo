import { z } from "zod";
import { SortableContext } from "@dnd-kit/sortable";
import { Globe, Plus, X } from "lucide-react";
import { useEffect, useState } from "react";
import { rpc, rpcParsed } from "./api";
import { activateTab, closeTab } from "./actions";
import { cx, DropdownMenu, DropdownMenuContent, DropdownMenuTrigger, IconButton, MenuItems, PreviewCard, PreviewCardContent, PreviewCardTrigger } from "./components/ui";
import { keepInPlace, NewTabDrop, useTabSortable } from "./LayoutDnd";
import { openMenu } from "./MenuHost";
import { spawnMenu, tabMenu } from "./menus";
import { ProcessIcon } from "./ProcessIcon";
import { useShortcuts } from "./shortcuts";
import { dotClass } from "./glyphs";
import {failQuietly, paneIds, useStore} from "./store";
import type { Id, Pane, Tab } from "./types";

const TAIL_LINES = 8;

function leadPane(tab: Tab, panes: Record<Id, Pane>): Pane | undefined {
  const ids = paneIds(tab.layout);
  const agent = ids.map((id) => panes[id]).find((p) => p?.agent && p.agent.state !== "exited");
  return agent ?? panes[tab.active_pane_id ?? ids[0] ?? ""];
}

type Editing = { id: Id; value: string } | null;

export function TabBar({ worktreeId }: { worktreeId: Id }) {
  const tabs = useStore((s) => s.tabs[worktreeId]) ?? [];
  const [editing, setEditing] = useState<Editing>(null);
  const shortcut = useShortcuts();

  const commit = () => {
    if (editing && editing.value.trim()) rpc("tab_rename", { tab_id: editing.id, title: editing.value.trim() }).catch(failQuietly("tab_rename"));
    setEditing(null);
  };

  return (
    <div className="tabbar" role="tablist">
      <SortableContext items={tabs.map((t) => t.id)} strategy={keepInPlace}>
        {tabs.map((t) => (
          <TabItem key={t.id} tab={t} closable={tabs.length > 1} editing={editing} setEditing={setEditing} commit={commit} />
        ))}
      </SortableContext>
      <DropdownMenu>
        <DropdownMenuTrigger render={<IconButton label="New tab or split" shortcut={shortcut("new_tab")} className="tab-new" />}>
          <Plus className="icon" />
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          <MenuItems items={() => spawnMenu(worktreeId)} />
        </DropdownMenuContent>
      </DropdownMenu>
      <NewTabDrop />
    </div>
  );
}

function TabItem({ tab: t, closable, editing, setEditing, commit }: { tab: Tab; closable: boolean; editing: Editing; setEditing: (e: Editing) => void; commit: () => void }) {
  const lead = useStore((s) => leadPane(t, s.panes));
  const waiting = useStore((s) => paneIds(t.layout).some((id) => s.panes[id]?.agent?.state === "waiting"));
  const isEditing = editing?.id === t.id;
  const drag = useTabSortable(t.id, isEditing);
  const [preview, setPreview] = useState(false);
  const shortcut = useShortcuts();

  const el = (
    <div
      ref={drag.ref}
      {...drag.props}
      role="tab"
      aria-selected={t.is_active}
      style={drag.style}
      className={cx("tab", t.is_active && "tab-active", drag.className)}
      onMouseDown={(e) => {
        if (e.button === 1) closeTab(t.id);
      }}
      onClick={() => {
        if (!editing) activateTab(t.id);
      }}
      onDoubleClick={() => setEditing({ id: t.id, value: t.title })}
      onContextMenu={(e) => openMenu(e, tabMenu(t, () => setEditing({ id: t.id, value: t.title })))}
    >
      {waiting ? <span className={dotClass("needs")} /> : lead?.kind === "browser" ? <Globe className="icon proc-icon" size={11} aria-label="Browser" /> : <ProcessIcon agent={lead?.agent?.kind} cmd={lead?.process_cmd} size={11} />}
      {isEditing ? (
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
      {closable && (
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

  if (t.is_active || !lead || lead.kind === "browser") return el;
  return (
    <PreviewCard open={preview && !drag.busy} onOpenChange={setPreview}>
      <PreviewCardTrigger render={el} />
      <PreviewCardContent className="tab-tail">
        <TabTail paneId={lead.id} title={t.title} />
      </PreviewCardContent>
    </PreviewCard>
  );
}

function TabTail({ paneId, title }: { paneId: Id; title: string }) {
  const [lines, setLines] = useState<string[] | null>(null);
  useEffect(() => {
    let live = true;
    rpcParsed("pane_tail", z.array(z.string()), { pane_id: paneId, lines: TAIL_LINES })
      .then((l) => live && setLines(l))
      .catch(() => live && setLines([]));
    return () => {
      live = false;
    };
  }, [paneId]);
  return (
    <>
      <div className="popover-title">{title}</div>
      <pre className="tab-tail-lines">{lines === null ? "..." : lines.length ? lines.join("\n") : "no output yet"}</pre>
    </>
  );
}
