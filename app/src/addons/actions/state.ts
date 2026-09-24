import { useSyncExternalStore } from "react";
import type { ActionSet } from "../../generated";
import type { Frame, Id } from "../../types";

let sets: Readonly<Record<Id, ActionSet>> = {};
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

function setSets(next: Readonly<Record<Id, ActionSet>>): void {
  sets = next;
  listeners.forEach((l) => l());
}

export const actionSet = (worktreeId: Id): ActionSet | null => sets[worktreeId] ?? null;

export const replaceActionSets = (list: readonly ActionSet[]): void => setSets(Object.fromEntries(list.map((s) => [s.worktree_id, s])));

export const putActionSet = (set: ActionSet): void => setSets({ ...sets, [set.worktree_id]: set });

export function useActionSet(worktreeId: Id): ActionSet | null {
  return useSyncExternalStore(subscribe, () => actionSet(worktreeId));
}

export function applyActionsFrame(frame: Frame): void {
  if (frame.event === "actions_changed") putActionSet((frame.data as { set: ActionSet }).set);
}
