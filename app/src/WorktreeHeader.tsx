import { ArrowUpRight, Ellipsis, Radio, Star, TriangleAlert } from "lucide-react";
import { endpointLabel, endpointUrl, httpEndpoints, needsMeItem } from "./activityModel";
import { focusPane, openEndpoint, resolveCheckpoint, runWorktreeAction } from "./actions";
import { Button, DropdownMenu, DropdownMenuContent, DropdownMenuTrigger, IconButton, MenuItems, Popover, PopoverContent, PopoverTitle, PopoverTrigger, Tooltip } from "./components/ui";
import { stateLabel } from "./homeQuery";
import { describeBinding } from "./keys";
import { openMenu } from "./MenuHost";
import { endpointMenu, overflowMenu, runningActionItems } from "./menus";
import { RowError } from "./RowError";
import { endpointsOf, liveEndpointFor, runningActionIds, setState, useStore } from "./store";
import { rpc } from "./api";
import { useEffect } from "react";
import { KIND_LABEL, type ActionSet, type RuntimeEndpoint, type Worktree } from "./types";

/** One compact line: name, branch, state on the left; repo Actions and the overflow menu on the right. */
export function WorktreeHeader({ worktree: w }: { worktree: Worktree }) {
  const state = useStore((s) => stateLabel(s.config?.states ?? [], w.metadata.state));
  const branch = w.detached ? `detached ${w.head.slice(0, 7)}` : (w.branch ?? "");
  return (
    <>
      <div className="wt-header">
        <span className="wt-header-name">
          {w.name}
          {w.is_main && <Star className="wt-main-star" aria-label="main worktree" />}
        </span>
        <span className="wt-header-branch" title={w.path}>
          {branch}
          {w.git?.dirty ? " *" : ""}
        </span>
        {state && (
          <span className="wt-header-state">
            <span className="state state-none" />
            {state}
          </span>
        )}
        <RowError worktreeId={w.id} />
        <ActionBar worktree={w} />
      </div>
      <CheckpointBanner worktree={w} />
    </>
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
    <div className="actionbar">
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

function EndpointMark({ worktreeId, actionId }: { worktreeId: string; actionId: string }) {
  const endpoint = useStore((s) => liveEndpointFor(s, worktreeId, actionId));
  if (!endpoint) return null;
  return (
    <Tooltip content={endpointUrl(endpoint)}>
      <span className="action-live">
        <ArrowUpRight className="icon" />
      </span>
    </Tooltip>
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

function CheckpointBanner({ worktree: w }: { worktree: Worktree }) {
  const items = useStore((s) => s.attention.filter((a) => a.worktree_id === w.id && a.kind === "checkpoint" && needsMeItem(a)).sort((a, b) => b.created_at_ms - a.created_at_ms));
  const pane = useStore((s) => (items[0]?.pane_id ? (s.panes[items[0].pane_id] ?? null) : null));
  const fallback = useStore((s) => httpEndpoints(endpointsOf(s, w.id))[0] ?? null);
  const item = items[0];
  if (!item) return null;
  const agent = item.agent_kind ? KIND_LABEL[item.agent_kind] : "Agent";
  const url = item.url ?? (fallback ? endpointUrl(fallback) : null);
  return (
    <div className="checkpoint-banner">
      <span className="state state-waiting" />
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
