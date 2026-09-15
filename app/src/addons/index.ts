import { towns } from "./towns";
import type { Addon, GlobalView } from "./types";
import { usage } from "./usage";

/** The composition root of the GUI: every built-in addon, in render order. Core client files reach addons only through this module. */
export const builtins: readonly Addon[] = [towns, usage];

export const addonViews = (): GlobalView[] => builtins.flatMap((a) => a.views ?? []);

export const worktreeNameField = () => builtins.find((a) => a.worktreeNameField)?.worktreeNameField ?? null;
