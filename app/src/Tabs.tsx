import { z } from "zod";
import { SortableContext } from "@dnd-kit/sortable";
import { Globe, Plus, X } from "lucide-react";
import { useEffect, useState } from "react";
import { rpc, rpcParsed } from "./api";
import { activateTab, closeTab, renameTab } from "./actions";
import { cx, DropdownMenu, DropdownMenuContent, DropdownMenuTrigger, IconButton, MenuItems, PreviewCard, PreviewCardContent, PreviewCardTrigger, Tooltip } from "./components/ui";
import { keepInPlace, NewTabDrop, useTabSortable } from "./LayoutDnd";
import { openMenu } from "./MenuHost";
import { spawnMenu, tabMenu } from "./menus";
import { ProcessIcon } from "./ProcessIcon";
import { useGlide } from "./glide";
import { useShortcuts } from "./shortcuts";
import { mostUrgent } from "./homeQuery";
import { AgentMark, StateMark } from "./StateMark";
import { HOOK_SOURCE, hookStatus, hookTitle } from "./glyphs";
import { useAnyDirty } from "./editor/sessions";
import { VIEW_ICONS } from "./editor/FileViewer";
import { fileView } from "./editor/fileView";
import {failQuietly, paneIds, useStore} from "./store";
import type { AgentPresence, Id, Pane, Tab } from "./types";

function EditorIcon({ path }: { path: string }) {
  const Icon = VIEW_ICONS[fileView(path)];
  return <Icon className="icon proc-icon" size={11} aria-label="File" />;
}

const TAIL_LINES = 8;

function leadPane(tab: Tab, panes: Record<Id, Pane>): Pane | undefined {
  const ids = paneIds(tab.layout);
  const agent = ids.map((id) => panes[id]).find((p) => p?.agent && p.agent.state !== "exited");
  return agent ?? panes[tab.active_pane_id ?? ids[0] ?? ""];
}

/** The most urgent live agent of a tab, whose mark the tab shows. */
function tabAgent(tab: Tab, agents: Record<Id, AgentPresence>): AgentPresence | null {
  return mostUrgent(paneIds(tab.layout).flatMap((id) => (agents[id] && agents[id].state !== "exited" ? [agents[id]] : [])));
}

/** The pane of a tab that a pane-mode hook started, whose mark the tab shows when no agent runs. */
function hookPane(tab: Tab, panes: Record<Id, Pane>): Pane | undefined {
  return paneIds(tab.layout)
    .map((id) => panes[id])
    .find((p) => p?.source?.kind === HOOK_SOURCE);
}

type Editing = { id: Id; value: string } | null;

export function TabBar({ worktreeId }: { worktreeId: Id }) {
  const tabs = useStore((s) => s.tabs[worktreeId]) ?? [];
  const [editing, setEditing] = useState<Editing>(null);
  const shortcut = useShortcuts();
  const bar = useGlide<HTMLDivElement>(".tab-active");

  const commit = () => {
    if (editing && editing.value.trim()) rpc("tab_rename", { tab_id: editing.id, title: editing.value.trim() }).catch(failQuietly("tab_rename"));
    setEditing(null);
  };

  return (
    <div className="tabbar" role="tablist" ref={bar}>
      <span className="glide" aria-hidden />
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
  const agent = useStore((s) => tabAgent(t, s.agents));
  const hook = useStore((s) => hookPane(t, s.panes));
  const dirty = useAnyDirty(paneIds(t.layout));
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
      aria-label={t.pinned ? t.title : undefined}
      className={cx("tab", t.pinned && "tab-pinned", t.is_active && "tab-active", drag.className)}
      onMouseDown={(e) => {
        if (e.button === 1) closeTab(t.id);
      }}
      onClick={() => {
        if (!editing) activateTab(t.id);
      }}
      onDoubleClick={() => (t.pinned ? renameTab(t) : setEditing({ id: t.id, value: t.title }))}
      onContextMenu={(e) => openMenu(e, tabMenu(t, () => (t.pinned ? renameTab(t) : setEditing({ id: t.id, value: t.title }))))}
    >
      {agent ? (
        <AgentMark agent={agent} small={t.pinned} className={t.pinned ? "tab-pin-mark" : undefined} />
      ) : (
        hook && <StateMark mark={hookStatus(hook)} title={hookTitle(hook)} small={t.pinned} className={t.pinned ? "tab-pin-mark" : undefined} />
      )}
      {lead?.kind === "browser" ? (
        <Globe className="icon proc-icon" size={11} aria-label="Browser" />
      ) : lead?.kind === "editor" ? (
        <EditorIcon path={lead.editor?.path ?? ""} />
      ) : (
        <ProcessIcon agent={lead?.agent?.kind} cmd={lead?.process_cmd} size={11} />
      )}
      {t.pinned ? null : isEditing ? (
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
        <span className="tab-title">
          {dirty && <span aria-label="unsaved edits">● </span>}
          {t.title}
        </span>
      )}
      {closable && !t.pinned && (
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

  if (t.is_active || !lead || lead.kind !== "terminal") return t.pinned ? <Tooltip content={t.title}>{el}</Tooltip> : el;
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
