import { actionSetSchema } from "../../schemas";
import { TriangleAlert } from "lucide-react";
import { useEffect } from "react";
import { rpcParsed } from "../../api";
import { Button, IconButton, Popover, PopoverContent, PopoverTitle, PopoverTrigger, Tooltip } from "../../components/ui";
import { describeBinding } from "../../keys";
import { openMenu } from "../../MenuHost";
import {failQuietly, useStore} from "../../store";
import { sourceMarks } from "../index";
import type { TopbarProps } from "../types";
import { StateMark } from "../../StateMark";
import { adoptedActionItems, crashedActions, runningActionIds, runningActionItems, runWorktreeAction, SOURCE_KIND } from "./commands";
import { putActionSet, useActionSet } from "./state";

/**
 * The `show = "topbar"` actions. A running one has a dot and a right-click menu. An Action whose package script
 * already runs in another pane, for example a dev server that an agent started, counts as running: a click shows
 * that pane, and the menu cannot stop it, because the pane is not the Action's.
 */
export function ActionButtons({ worktree: w }: TopbarProps) {
  const set = useActionSet(w.id);
  useEffect(() => {
    if (set) return;
    rpcParsed("action_list", actionSetSchema, { worktree_id: w.id })
      .then(putActionSet)
      .catch(failQuietly("action_list"));
  }, [w.id, set === null]);
  const running = useStore((s) => runningActionIds(s, w.id));
  const crashed = useStore((s) => crashedActions(s, w.id));
  const topbar = (set?.actions ?? []).filter((a) => a.show === "topbar");
  return topbar.map((a) => {
    const adopted = !running.includes(a.id) && !!set?.adopted?.[a.id];
    const live = running.includes(a.id) || adopted;
    const crash = live ? undefined : crashed[a.id];
    const state = adopted ? "running in another pane" : "running (right-click for more)";
    const hint = [a.command, crash, a.shortcut ? describeBinding(a.shortcut) : null, set?.from_repo ? "from the repository" : null].filter(Boolean).join(" · ");
    return (
      <Tooltip key={a.id} content={live ? `${hint} · ${state}` : hint}>
        <Button variant="ghost" size="sm" className="action-btn" onClick={() => runWorktreeAction(w.id, a.id)} onContextMenu={(e) => live && openMenu(e, adopted ? adoptedActionItems(w.id, a.id) : runningActionItems(w.id, a.id))}>
          {(live || crash) && <StateMark mark={live ? "working" : "failed"} hidden />}
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
