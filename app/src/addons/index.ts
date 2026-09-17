import type { AddonSignal } from "../activityModel";
import { mergeApps, type AppRow } from "../appsModel";
import type { State } from "../store";
import type { Id, Worktree } from "../types";
import type { ComponentType } from "react";
import { actions } from "./actions";
import { agentation } from "./agentation";
import { github } from "./github";
import { runtime } from "./runtime";
import { towns } from "./towns";
import type { RailMarker } from "../sections";
import type { Addon, BrowserToolbarProps, GlobalView, InspectorSection, SourceKey, SourceMenu } from "./types";
import { usage } from "./usage";

/** The composition root of the GUI: every built-in addon, in render order. Core client files reach addons only through this module. */
export const builtins: readonly Addon[] = [towns, github, usage, actions, runtime, agentation];

export const addonViews = (): GlobalView[] => builtins.flatMap((a) => a.views ?? []);

export const worktreeNameField = () => builtins.find((a) => a.worktreeNameField)?.worktreeNameField ?? null;

export const repoAvatar = () => builtins.find((a) => a.repoAvatar)?.repoAvatar ?? null;

export const inspectorSections = (): InspectorSection[] => builtins.flatMap((a) => a.inspectorSections ?? []);

export const addonSignals = (s: State, worktreeId: Id): AddonSignal[] => builtins.flatMap((a) => a.worktreeSignals?.(s, worktreeId) ?? []);

export const signalLine = (className: string) => builtins.find((a) => a.signalLine?.className === className)?.signalLine?.Line ?? null;

export const appUrl = (s: State, worktreeId: Id): string | null => builtins.reduce<string | null>((url, a) => url ?? a.appUrl?.(s, worktreeId) ?? null, null);

/** Extra rows for the git section. Core renders them where git ends, and names no addon. */
export const gitDetails = (): { id: string; component: ComponentType<{ worktree: Worktree }> }[] =>
  builtins.flatMap((a) => (a.gitDetail ? [{ id: a.id, component: a.gitDetail }] : []));

/** Branch trouble for the git rail entry. The first addon with something to say wins. */
export const gitMarkers = (s: State, w: Worktree): RailMarker | null => builtins.reduce<RailMarker | null>((found, a) => found ?? a.gitMarker?.(s, w) ?? null, null);

/** Every running app that an addon knows about. Core shows them; it discovers none of them. */
export const addonApps = (s: State): AppRow[] => mergeApps(builtins.map((a) => a.apps?.(s) ?? []));

/** The addon that starts panes of this source kind. */
export const sourceOwner = (kind: string) => builtins.find((a) => a.paneSource?.kind === kind)?.paneSource ?? null;

export const sourceMarks = () => builtins.flatMap((a) => (a.sourceMark ? [{ id: a.id, Mark: a.sourceMark }] : []));

export function sourceMenu(worktreeId: Id, source: SourceKey, s: State): SourceMenu {
  const parts = builtins.flatMap((a) => (a.sourceMenu ? [a.sourceMenu(worktreeId, source, s)] : []));
  return { first: parts.flatMap((p) => p.first), last: parts.flatMap((p) => p.last) };
}

export const browserToolbarItems = (): { id: string; component: ComponentType<BrowserToolbarProps> }[] =>
  builtins.flatMap((a) => (a.browserToolbar ? [{ id: a.id, component: a.browserToolbar }] : []));
