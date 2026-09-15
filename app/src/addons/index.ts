import type { AddonSignal } from "../activityModel";
import type { State } from "../store";
import type { Id } from "../types";
import { github } from "./github";
import { towns } from "./towns";
import type { Addon, GlobalView, InspectorSection } from "./types";

/** The composition root of the GUI: every built-in addon, in render order. Core client files reach addons only through this module. */
export const builtins: readonly Addon[] = [towns, github];

export const addonViews = (): GlobalView[] => builtins.flatMap((a) => a.views ?? []);

export const worktreeNameField = () => builtins.find((a) => a.worktreeNameField)?.worktreeNameField ?? null;

export const inspectorSections = (): InspectorSection[] => builtins.flatMap((a) => a.inspectorSections ?? []);

export const addonSignals = (s: State, worktreeId: Id): AddonSignal[] => builtins.flatMap((a) => a.worktreeSignals?.(s, worktreeId) ?? []);
