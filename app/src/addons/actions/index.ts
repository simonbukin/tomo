import type { Addon } from "../types";
import { paletteEntries, restartWorktreeAction, shortcuts, SOURCE_KIND, stopWorktreeAction, worktreeItems } from "./commands";
import { applyActionsFrame, replaceActionSets } from "./state";
import { ActionButtons, ActionWarning } from "./Topbar";

export const actions: Addon = {
  id: "actions",
  label: "Actions",
  description: "Repository commands from `.tomo.toml`: run one in a pane, restart it, stop it.",
  topbar: { buttons: ActionButtons, marks: ActionWarning },
  worktreeMenu: worktreeItems,
  paletteEntries,
  shortcuts,
  paneSource: { kind: SOURCE_KIND, restart: restartWorktreeAction, stop: stopWorktreeAction },
  onSnapshot: (snap) => replaceActionSets(snap.actions ?? []),
  onFrame: applyActionsFrame,
};
