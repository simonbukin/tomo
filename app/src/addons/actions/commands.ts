import { actionRunResultSchema } from "../../schemas";
import { rpc, rpcParsed } from "../../api";
import type { MenuItem } from "../../components/ui";
import type { ActionDef } from "../../generated";
import { describeBinding } from "../../keys";
import type { PaletteEntry } from "../../paletteModel";
import { getState, setRowError, toast, type State } from "../../store";
import type { Id, Worktree } from "../../types";
import { sourceMenu } from "../index";
import type { BoundCommand } from "../types";
import { actionSet } from "./state";

/** `PaneSource.kind` of a pane that an Action started. */
export const SOURCE_KIND = "action";

const sep: MenuItem = { separator: true };

const done = (worktreeId: Id) => () => setRowError(worktreeId, null);

const failed = (worktreeId: Id, op: string) => (e: unknown) => {
  const message = (e as Error).message;
  setRowError(worktreeId, { op, message });
  toast({ level: "error", title: `${op} failed`, detail: message });
};

export function runWorktreeAction(worktreeId: Id, actionId: string): void {
  rpcParsed("action_run", actionRunResultSchema, { worktree_id: worktreeId, action_id: actionId }).then(done(worktreeId), failed(worktreeId, actionId));
}

export function stopWorktreeAction(worktreeId: Id, actionId: string): void {
  rpc("action_stop", { worktree_id: worktreeId, action_id: actionId }).then(done(worktreeId), failed(worktreeId, `stop ${actionId}`));
}

export function restartWorktreeAction(worktreeId: Id, actionId: string): void {
  rpcParsed("action_restart", actionRunResultSchema, { worktree_id: worktreeId, action_id: actionId }).then(done(worktreeId), failed(worktreeId, `restart ${actionId}`));
}

const actionsOf = (worktreeId: Id): ActionDef[] => actionSet(worktreeId)?.actions ?? [];

export function runningActionIds(s: State, worktreeId: Id): string[] {
  return Object.values(s.panes)
    .flatMap((p) => (p.worktree_id === worktreeId && p.source?.kind === SOURCE_KIND && p.live && p.exit_code == null ? [p.source.id] : []))
    .sort();
}

export function runningActionItems(worktreeId: Id, actionId: string, s: State = getState()): MenuItem[] {
  const { first, last } = sourceMenu(worktreeId, { kind: SOURCE_KIND, id: actionId }, s);
  return [
    ...first,
    { label: "focus logs", run: () => runWorktreeAction(worktreeId, actionId) },
    { label: "restart", run: () => restartWorktreeAction(worktreeId, actionId) },
    { label: "stop", danger: true, run: () => stopWorktreeAction(worktreeId, actionId) },
    ...(last.length ? [sep, ...last] : []),
  ];
}

/** Menu actions, and every running action, for the top of the overflow menu. */
export function worktreeItems(w: Worktree, s: State): MenuItem[] {
  const running = runningActionIds(s, w.id);
  return actionsOf(w.id)
    .filter((a) => a.show === "menu" || running.includes(a.id))
    .map((a) => {
      const shortcut = a.shortcut ? describeBinding(a.shortcut) : undefined;
      return running.includes(a.id) ? { label: a.label, shortcut, submenu: runningActionItems(w.id, a.id, s) } : { label: a.label, shortcut, run: () => runWorktreeAction(w.id, a.id) };
    });
}

export function paletteEntries(s: State, w: Worktree, context: boolean): PaletteEntry[] {
  const running = runningActionIds(s, w.id);
  return actionsOf(w.id).flatMap((a): PaletteEntry[] => {
    const key = `action:${w.id}:${a.id}`;
    const hint = [w.name, a.shortcut ? describeBinding(a.shortcut) : null].filter(Boolean).join(" · ");
    if (!running.includes(a.id)) return [{ key, label: `start ${a.label}`, hint, context, run: () => runWorktreeAction(w.id, a.id) }];
    return [
      { key: `${key}:logs`, label: `focus ${a.label} logs`, hint, context, run: () => runWorktreeAction(w.id, a.id) },
      { key: `${key}:restart`, label: `restart ${a.label}`, hint, context, run: () => restartWorktreeAction(w.id, a.id) },
      { key: `${key}:stop`, label: `stop ${a.label}`, hint, context, run: () => stopWorktreeAction(w.id, a.id) },
    ];
  });
}

/** An Action `shortcut` works while its worktree is open. */
export function shortcuts(s: State): BoundCommand[] {
  const worktreeId = s.ui.view === "worktree" ? s.ui.activeWorktreeId : null;
  if (!worktreeId) return [];
  return actionsOf(worktreeId).flatMap((a) => (a.shortcut ? [{ id: `action:${a.id}`, label: `run ${a.label}`, group: "Worktrees" as const, binding: a.shortcut, run: () => runWorktreeAction(worktreeId, a.id) }] : []));
}
