import type { AddonSignal } from "../activityModel";
import type { State } from "../store";
import type { Id } from "../types";
import type { ComponentType } from "react";
import { actions } from "./actions";
import { agentation } from "./agentation";
import { github } from "./github";
import { towns } from "./towns";
import type { Addon, BrowserToolbarProps, GlobalView, InspectorSection } from "./types";
import { usage } from "./usage";

/** The composition root of the GUI: every built-in addon, in render order. Core client files reach addons only through this module. */
export const builtins: readonly Addon[] = [towns, github, usage, actions, agentation];

export const addonViews = (): GlobalView[] => builtins.flatMap((a) => a.views ?? []);

export const worktreeNameField = () => builtins.find((a) => a.worktreeNameField)?.worktreeNameField ?? null;

export const repoAvatar = () => builtins.find((a) => a.repoAvatar)?.repoAvatar ?? null;

export const inspectorSections = (): InspectorSection[] => builtins.flatMap((a) => a.inspectorSections ?? []);

export const addonSignals = (s: State, worktreeId: Id): AddonSignal[] => builtins.flatMap((a) => a.worktreeSignals?.(s, worktreeId) ?? []);

export const browserToolbarItems = (): { id: string; component: ComponentType<BrowserToolbarProps> }[] =>
  builtins.flatMap((a) => (a.browserToolbar ? [{ id: a.id, component: a.browserToolbar }] : []));
