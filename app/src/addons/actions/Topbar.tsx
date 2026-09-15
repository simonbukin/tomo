import { ArrowUpRight, TriangleAlert } from "lucide-react";
import { useEffect } from "react";
import { endpointLabel } from "../../activityModel";
import { rpc } from "../../api";
import { Button, HoverCard, IconButton, Popover, PopoverContent, PopoverTitle, PopoverTrigger, Tooltip } from "../../components/ui";
import type { ActionSet } from "../../generated";
import { RuntimePreview } from "../../HoverPreviews";
import { describeBinding } from "../../keys";
import { openMenu } from "../../MenuHost";
import { useStore } from "../../store";
import type { Id } from "../../types";
import type { TopbarProps } from "../types";
import { liveEndpointFor, runningActionIds, runningActionItems, runWorktreeAction } from "./commands";
import { putActionSet, useActionSet } from "./state";

/** The `show = "topbar"` actions. A running one has a dot and a right-click menu. */
export function ActionButtons({ worktree: w }: TopbarProps) {
  const set = useActionSet(w.id);
  useEffect(() => {
    if (set) return;
    rpc<ActionSet>("action_list", { worktree_id: w.id })
      .then(putActionSet)
      .catch(() => {});
  }, [w.id, set === null]);
  const running = useStore((s) => runningActionIds(s, w.id));
  const topbar = (set?.actions ?? []).filter((a) => a.show === "topbar");
  return topbar.map((a) => {
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
  });
}

function EndpointMark({ worktreeId, actionId }: { worktreeId: Id; actionId: string }) {
  const endpoint = useStore((s) => liveEndpointFor(s, worktreeId, actionId));
  if (!endpoint) return null;
  return (
    <HoverCard content={<RuntimePreview endpoint={endpoint} label={endpointLabel(endpoint)} />}>
      <span className="action-live">
        <ArrowUpRight className="icon" />
      </span>
    </HoverCard>
  );
}

/** The problem in `.tomo.toml`, after the editor button. */
export function ActionWarning({ worktree: w }: TopbarProps) {
  const error = useActionSet(w.id)?.error;
  if (!error) return null;
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
