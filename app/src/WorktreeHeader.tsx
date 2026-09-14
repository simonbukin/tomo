import { Ellipsis, TriangleAlert } from "lucide-react";
import { runWorktreeAction } from "./actions";
import { Button, DropdownMenu, DropdownMenuContent, DropdownMenuTrigger, IconButton, MenuItems, Popover, PopoverContent, PopoverTitle, PopoverTrigger, Tooltip } from "./components/ui";
import { stateLabel } from "./homeQuery";
import { describeBinding } from "./keys";
import { openMenu } from "./MenuHost";
import { overflowMenu, runningActionItems } from "./menus";
import { runningActionIds, useStore } from "./store";
import type { Worktree } from "./types";

/** One compact line: name, branch, state on the left; repo Actions and the overflow menu on the right. */
export function WorktreeHeader({ worktree: w }: { worktree: Worktree }) {
  const state = useStore((s) => stateLabel(s.config?.states ?? [], w.metadata.state));
  const branch = w.detached ? `detached ${w.head.slice(0, 7)}` : (w.branch ?? "");
  return (
    <div className="wt-header">
      <span className="wt-header-name">{w.name}</span>
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
      <ActionBar worktree={w} />
    </div>
  );
}

function ActionBar({ worktree: w }: { worktree: Worktree }) {
  const set = useStore((s) => s.actions[w.id] ?? null);
  const running = useStore((s) => runningActionIds(s, w.id));
  const topbar = (set?.actions ?? []).filter((a) => a.show === "topbar");
  return (
    <div className="actionbar">
      {topbar.map((a) => {
        const live = running.includes(a.id);
        const hint = [a.command, a.shortcut ? describeBinding(a.shortcut) : null].filter(Boolean).join(" · ");
        return (
          <Tooltip key={a.id} content={live ? `${hint} · running (right-click to stop)` : hint}>
            <Button variant="ghost" size="sm" className="action-btn" onClick={() => runWorktreeAction(w.id, a.id)} onContextMenu={(e) => live && openMenu(e, runningActionItems(w.id, a.id))}>
              {live && <span className="state state-working" />}
              {a.label}
            </Button>
          </Tooltip>
        );
      })}
      {set?.error && <ActionWarning error={set.error} />}
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
