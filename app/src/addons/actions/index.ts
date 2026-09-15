import type { Addon } from "../types";
import { endpointItems, paletteEntries, restartWorktreeAction, shortcuts, SOURCE_KIND, worktreeItems } from "./commands";
import { applyActionsFrame, replaceActionSets } from "./state";
import { ActionButtons, ActionWarning } from "./Topbar";

export const actions: Addon = {
  id: "actions",
  topbar: { buttons: ActionButtons, marks: ActionWarning },
  worktreeMenu: worktreeItems,
  endpointMenu: endpointItems,
  paletteEntries,
  shortcuts,
  paneSource: { kind: SOURCE_KIND, restart: restartWorktreeAction },
  onSnapshot: (snap) => replaceActionSets(snap.actions ?? []),
  onFrame: applyActionsFrame,
};
