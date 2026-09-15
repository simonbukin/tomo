import { Ellipsis, Radio, Star } from "lucide-react";
import { builtins } from "./addons";
import { endpointLabel, endpointUrl, httpEndpoints, needsMeItem } from "./activityModel";
import { focusPane, openEndpoint, openExternalFor, resolveCheckpoint } from "./actions";
import { Button, DropdownMenu, DropdownMenuContent, DropdownMenuTrigger, HoverCard, IconButton, MenuItems, Popover, PopoverContent, PopoverTitle, PopoverTrigger, Tooltip } from "./components/ui";
import { dotClass } from "./glyphs";
import { GitPreview } from "./HoverPreviews";
import { stateLabel } from "./homeQuery";
import { openMenu } from "./MenuHost";
import { editorName, endpointMenu, overflowMenu } from "./menus";
import { useShortcuts } from "./shortcuts";
import { RowError } from "./RowError";
import { endpointsOf, useStore } from "./store";
import { KIND_LABEL, type RuntimeEndpoint, type Worktree } from "./types";

/** The top-middle control plane: name, branch, state on the left; addon buttons, the editor button, runtime, and the overflow menu on the right. */
export function WorktreeHeader({ worktree: w }: { worktree: Worktree }) {
  const state = useStore((s) => stateLabel(s.config?.states ?? [], w.metadata.state));
  const branch = w.detached ? `detached ${w.head.slice(0, 7)}` : (w.branch ?? "");
  return (
    <div className="wt-header" data-tauri-drag-region>
      <span className="wt-header-name" data-tauri-drag-region>
        {w.name}
        {w.is_main && <Star className="wt-main-star" aria-label="main worktree" />}
      </span>
      <HoverCard content={<GitPreview worktree={w} />}>
        <span className="wt-header-branch">
          {branch}
          {w.git?.dirty ? " *" : ""}
        </span>
      </HoverCard>
      {state && (
        <span className="wt-header-state" data-tauri-drag-region>
          <span className="state state-none" />
          {state}
        </span>
      )}
      <RowError worktreeId={w.id} />
      <HeaderControls worktree={w} />
    </div>
  );
}

function HeaderControls({ worktree: w }: { worktree: Worktree }) {
  const endpoints = useStore((s) => endpointsOf(s, w.id));
  return (
    <div className="actionbar" data-tauri-drag-region>
      {builtins.map((a) => {
        const Buttons = a.topbar?.buttons;
        return Buttons && <Buttons key={a.id} worktree={w} />;
      })}
      <EditorButton worktree={w} />
      {builtins.map((a) => {
        const Marks = a.topbar?.marks;
        return Marks && <Marks key={a.id} worktree={w} />;
      })}
      {endpoints.length > 0 && <RuntimePopover worktree={w} endpoints={endpoints} />}
      <DropdownMenu>
        <DropdownMenuTrigger render={<IconButton label="More actions" />}>
          <Ellipsis className="icon" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <MenuItems items={() => overflowMenu(w)} />
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

function EditorButton({ worktree: w }: { worktree: Worktree }) {
  const editor = useStore((s) => editorName(s.config?.editor_command));
  const shortcut = useShortcuts();
  const label = editor.charAt(0).toUpperCase() + editor.slice(1);
  const key = shortcut("open_editor");
  return (
    <Tooltip content={<span className="tip-row">Open in {label}{key && <kbd className="tip-kbd">{key}</kbd>}</span>}>
      <Button variant="ghost" size="sm" className="action-btn" onClick={() => openExternalFor(w.id, "editor")}>
        {label}
      </Button>
    </Tooltip>
  );
}

function RuntimePopover({ worktree: w, endpoints }: { worktree: Worktree; endpoints: RuntimeEndpoint[] }) {
  const panes = useStore((s) => s.panes);
  const owner = (e: RuntimeEndpoint) => e.label ?? (e.pane_id ? panes[e.pane_id]?.title : null) ?? e.process;
  return (
    <Popover>
      <PopoverTrigger render={<IconButton label="Runtime endpoints" />}>
        <Radio className="icon" />
      </PopoverTrigger>
      <PopoverContent align="end">
        <PopoverTitle>runtime</PopoverTitle>
        {endpoints.map((e) => (
          <div key={e.id} className="runtime-row" onContextMenu={(ev) => openMenu(ev, endpointMenu(w.id, e))}>
            <span className="runtime-label">{endpointLabel(e)}</span>
            <span className="mono">{e.host}:{e.port}</span>
            <span className="muted">{owner(e)} · {e.pid}</span>
            <Button size="sm" onClick={() => openEndpoint(endpointUrl(e), w.id)}>open</Button>
          </div>
        ))}
      </PopoverContent>
    </Popover>
  );
}

export function CheckpointBanner({ worktree: w }: { worktree: Worktree }) {
  const items = useStore((s) => s.attention.filter((a) => a.worktree_id === w.id && a.kind === "checkpoint" && needsMeItem(a, Object.values(s.agents))).sort((a, b) => b.created_at_ms - a.created_at_ms));
  const pane = useStore((s) => (items[0]?.pane_id ? (s.panes[items[0].pane_id] ?? null) : null));
  const fallback = useStore((s) => httpEndpoints(endpointsOf(s, w.id))[0] ?? null);
  const item = items[0];
  if (!item) return null;
  const agent = item.agent_kind ? KIND_LABEL[item.agent_kind] : "Agent";
  const url = item.url ?? (fallback ? endpointUrl(fallback) : null);
  return (
    <div className="checkpoint-banner">
      <span className={dotClass("needs")} />
      <span className="checkpoint-text">
        {agent}: "{item.message}"
      </span>
      {url && <button className="link" onClick={() => openEndpoint(url, w.id)}>Open App</button>}
      {pane && <button className="link" onClick={() => focusPane(pane.id)}>Go to {agent}</button>}
      <button className="link" onClick={() => resolveCheckpoint(item.id)}>Resolve</button>
      {items.length > 1 && <span className="faint">+{items.length - 1} more</span>}
    </div>
  );
}
