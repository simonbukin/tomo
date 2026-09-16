import { TriangleAlert } from "lucide-react";
import { useEffect } from "react";
import { rpc } from "../../api";
import { Button, IconButton, Popover, PopoverContent, PopoverTitle, PopoverTrigger, Tooltip } from "../../components/ui";
import type { ActionSet } from "../../generated";
import { describeBinding } from "../../keys";
import { openMenu } from "../../MenuHost";
import { useStore } from "../../store";
import { sourceMarks } from "../index";
import type { TopbarProps } from "../types";
import { runningActionIds, runningActionItems, runWorktreeAction, SOURCE_KIND } from "./commands";
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
    const hint = [a.command, a.shortcut ? describeBinding(a.shortcut) : null, set?.from_repo ? "from the repository" : null].filter(Boolean).join(" · ");
    return (
      <Tooltip key={a.id} content={live ? `${hint} · running (right-click for more)` : hint}>
        <Button variant="ghost" size="sm" className="action-btn" onClick={() => runWorktreeAction(w.id, a.id)} onContextMenu={(e) => live && openMenu(e, runningActionItems(w.id, a.id))}>
          {live && <span className="state state-working" />}
          {a.label}
          {sourceMarks().map(({ id, Mark }) => (
            <Mark key={id} worktreeId={w.id} source={{ kind: SOURCE_KIND, id: a.id }} />
          ))}
        </Button>
      </Tooltip>
    );
  });
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
