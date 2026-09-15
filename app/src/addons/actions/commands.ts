import { endpointUrl, httpEndpoints } from "../../activityModel";
import { rpc } from "../../api";
import type { MenuItem } from "../../components/ui";
import type { ActionDef, ActionRunResult } from "../../generated";
import { describeBinding } from "../../keys";
import type { PaletteEntry } from "../../paletteModel";
import { endpointsOf, getState, setRowError, toast, type State } from "../../store";
import type { Id, RuntimeEndpoint, Worktree } from "../../types";
import type { BoundCommand } from "../types";
import { actionSet } from "./state";

/** `PaneSource.kind` of a pane that an Action started. */
export const SOURCE_KIND = "action";

const sep: MenuItem = { separator: true };

// The store loads this module through addons/index.ts, and actions.ts loads the store: a lazy import keeps that cycle out of module start.
const withActions = (run: (a: typeof import("../../actions")) => unknown) => () => void import("../../actions").then(run);

const done = (worktreeId: Id) => () => setRowError(worktreeId, null);

const failed = (worktreeId: Id, op: string) => (e: unknown) => {
  const message = (e as Error).message;
  setRowError(worktreeId, { op, message });
  toast({ level: "error", title: `${op} failed`, detail: message });
};

export function runWorktreeAction(worktreeId: Id, actionId: string): void {
  rpc<ActionRunResult>("action_run", { worktree_id: worktreeId, action_id: actionId }).then(done(worktreeId), failed(worktreeId, actionId));
}

export function stopWorktreeAction(worktreeId: Id, actionId: string): void {
  rpc("action_stop", { worktree_id: worktreeId, action_id: actionId }).then(done(worktreeId), failed(worktreeId, `stop ${actionId}`));
}

export function restartWorktreeAction(worktreeId: Id, actionId: string): void {
  rpc<ActionRunResult>("action_restart", { worktree_id: worktreeId, action_id: actionId }).then(done(worktreeId), failed(worktreeId, `restart ${actionId}`));
}

const actionsOf = (worktreeId: Id): ActionDef[] => actionSet(worktreeId)?.actions ?? [];

export function runningActionIds(s: State, worktreeId: Id): string[] {
  return Object.values(s.panes)
    .flatMap((p) => (p.worktree_id === worktreeId && p.source?.kind === SOURCE_KIND && p.live && p.exit_code == null ? [p.source.id] : []))
    .sort();
}

export function liveEndpointFor(s: State, worktreeId: Id, actionId: string): RuntimeEndpoint | null {
  return endpointsOf(s, worktreeId).find((e) => e.action_id === actionId && e.protocol !== "tcp") ?? null;
}

function copyEndpoints(list: RuntimeEndpoint[]): MenuItem {
  const many = list.length > 1;
  const entries = list.flatMap((e) => [
    ["URL", endpointUrl(e), many ? `url :${e.port}` : "url"],
    ["Port", String(e.port), many ? `port :${e.port}` : "port"],
  ]);
  return { label: "copy", disabled: entries.length === 0, submenu: entries.map(([what, value, label]) => ({ label, run: withActions((a) => a.copyText(value, what)) })) };
}

export function runningActionItems(worktreeId: Id, actionId: string, s: State = getState()): MenuItem[] {
  const open = httpEndpoints(endpointsOf(s, worktreeId).filter((e) => e.action_id === actionId));
  return [
    ...open.map((e) => ({ label: open.length > 1 ? `open :${e.port}` : "open", run: withActions((a) => a.openEndpoint(endpointUrl(e), worktreeId)) })),
    { label: "focus logs", run: () => runWorktreeAction(worktreeId, actionId) },
    { label: "restart", run: () => restartWorktreeAction(worktreeId, actionId) },
    { label: "stop", danger: true, run: () => stopWorktreeAction(worktreeId, actionId) },
    ...(open.length ? [sep, copyEndpoints(open)] : []),
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

export function endpointItems(worktreeId: Id, e: RuntimeEndpoint): MenuItem[] {
  const actionId = e.action_id;
  if (!actionId) return [];
  return [
    { label: "restart", run: () => restartWorktreeAction(worktreeId, actionId) },
    { label: "stop", danger: true, run: () => stopWorktreeAction(worktreeId, actionId) },
  ];
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
