import { ArrowUpRight, Ellipsis, Radio, Star, TriangleAlert } from "lucide-react";
import { endpointLabel, endpointUrl, httpEndpoints, needsMeItem } from "./activityModel";
import { focusPane, openEndpoint, openExternalFor, resolveCheckpoint, runWorktreeAction } from "./actions";
import { Button, DropdownMenu, DropdownMenuContent, DropdownMenuTrigger, HoverCard, IconButton, MenuItems, Popover, PopoverContent, PopoverTitle, PopoverTrigger, Tooltip } from "./components/ui";
import { dotClass } from "./glyphs";
import { GitPreview, RuntimePreview } from "./HoverPreviews";
import { stateLabel } from "./homeQuery";
import { describeBinding } from "./keys";
import { openMenu } from "./MenuHost";
import { editorName, endpointMenu, overflowMenu, runningActionItems } from "./menus";
import { useShortcuts } from "./shortcuts";
import { RowError } from "./RowError";
import { endpointsOf, liveEndpointFor, runningActionIds, setState, useStore } from "./store";
import { rpc } from "./api";
import { useEffect } from "react";
import { KIND_LABEL, type ActionSet, type RuntimeEndpoint, type Worktree } from "./types";

/** The top-middle control plane: name, branch, state on the left; Actions, the overflow menu, and the spawn menu on the right. */
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
      <ActionBar worktree={w} />
    </div>
  );
}

function ActionBar({ worktree: w }: { worktree: Worktree }) {
  const set = useStore((s) => s.actions[w.id] ?? null);
  useEffect(() => {
    if (set) return;
    rpc<ActionSet>("action_list", { worktree_id: w.id })
      .then((loaded) => setState((s) => ({ actions: { ...s.actions, [w.id]: loaded } })))
      .catch(() => {});
  }, [w.id, set === null]);
  const running = useStore((s) => runningActionIds(s, w.id));
  const endpoints = useStore((s) => endpointsOf(s, w.id));
  const topbar = (set?.actions ?? []).filter((a) => a.show === "topbar");
  return (
    <div className="actionbar" data-tauri-drag-region>
      {topbar.map((a) => {
        const live = running.includes(a.id);
        const hint = [a.command, a.shortcut ? describeBinding(a.shortcut) : null].filter(Boolean).join(" · ");
        return (
          <Tooltip key={a.id} content={live ? `${hint} · running (right-click for more)` : hint}>
            <Button variant="ghost" size="sm" className="action-btn" onClick={() => runWorktreeAction(w.id, a.id)} onContextMenu={(e) => live && openMenu(e, runningActionItems(w.id, a.id))}>
              {live && <span className="state state-working" />}
              {a.label}
              <EndpointMark worktreeId={w.id} actionId={a.id} />
            </Button>
          </Tooltip>
        );
      })}
      <EditorButton worktree={w} />
      {set?.error && <ActionWarning error={set.error} />}
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

function EndpointMark({ worktreeId, actionId }: { worktreeId: string; actionId: string }) {
  const endpoint = useStore((s) => liveEndpointFor(s, worktreeId, actionId));
  const actions = useStore((s) => s.actions[worktreeId]?.actions ?? []);
  if (!endpoint) return null;
  return (
    <HoverCard content={<RuntimePreview endpoint={endpoint} label={endpointLabel(endpoint, actions)} />}>
      <span className="action-live">
        <ArrowUpRight className="icon" />
      </span>
    </HoverCard>
  );
}

function RuntimePopover({ worktree: w, endpoints }: { worktree: Worktree; endpoints: RuntimeEndpoint[] }) {
  const actions = useStore((s) => s.actions[w.id]?.actions ?? []);
  const panes = useStore((s) => s.panes);
  const owner = (e: RuntimeEndpoint) => actions.find((a) => a.id === e.action_id)?.label ?? (e.pane_id ? panes[e.pane_id]?.title : null) ?? e.process;
  return (
    <Popover>
      <PopoverTrigger render={<IconButton label="Runtime endpoints" />}>
        <Radio className="icon" />
      </PopoverTrigger>
      <PopoverContent align="end">
        <PopoverTitle>runtime</PopoverTitle>
        {endpoints.map((e) => (
          <div key={e.id} className="runtime-row" onContextMenu={(ev) => openMenu(ev, endpointMenu(w.id, e))}>
            <span className="runtime-label">{endpointLabel(e, actions)}</span>
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

function ActionWarning({ error }: { error: string }) {
  return (
    <Popover>
      <PopoverTrigger render={<IconButton label="Actions config problem" className="action-warn" />}>
        <TriangleAlert className="icon" />
      </PopoverTrigger>
      <PopoverContent align="end">
        <PopoverTitle>.tomo.toml</PopoverTitle>
        <pre>{error}</pre>
      </PopoverContent>
    </Popover>
  );
}
