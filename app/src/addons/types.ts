import type { LucideIcon } from "lucide-react";
import type { ComponentType } from "react";
import type { Action } from "../actions";
import type { AddonSignal } from "../activityModel";
import type { MenuItem } from "../components/ui";
import type { Status } from "../glyphs";
import type { PaletteEntry } from "../paletteModel";
import type { RailMarker } from "../shell/RightRail";
import type { State } from "../store";
import type { PaneSource } from "../generated";
import type { ActivityEvent, Frame, Id, Repo, Snapshot, Worktree } from "../types";

/** A button on an Activity row. `label` reads the store and returns null to hide the button. `run` happens on click. */
export interface ActivityRowAction {
  label: (e: ActivityEvent, s: State) => string | null;
  run: (e: ActivityEvent) => void;
}

/** How the Activity view shows one kind. The row adds the agent, the worktree, the payload `url`, and Resolve by itself. */
export interface ActivityKindView {
  status?: Status;
  /** The actor when the event has no agent. */
  who?: (e: ActivityEvent, s: State) => string;
  /** The "Open App" link when the payload has no `url`. */
  url?: (e: ActivityEvent, s: State) => string | null;
  /** Buttons between "Open App" and "Resolve", in this order. */
  actions?: readonly ActivityRowAction[];
}

/** A center view next to Home and Activity. Its id is also the id of the command that opens it. */
export interface GlobalView {
  id: string;
  /** The top strip title. */
  title: string;
  /** The rail and sidebar button label. */
  label: string;
  icon: LucideIcon;
  /** Load it lazily, so that the view costs nothing until the user opens it. */
  component: ComponentType;
  fallback: ComponentType;
}

export interface WorktreeNameFieldProps {
  /** True while the user typed a location, so no name is needed. */
  hidden: boolean;
  /** Reports the `name_hint` that `worktree_create` sends while the location is empty. */
  onHint: (hint: string | null) => void;
}

export interface TopbarProps {
  worktree: Worktree;
}

/** A pane source without its label: the key of the controls and menu items of one source. */
export type SourceKey = Pick<PaneSource, "kind" | "id">;

export interface SourceMarkProps {
  worktreeId: Id;
  source: SourceKey;
}

/** Items for the menu of a running pane source: `first` before the owner's items, `last` after a separator at the end. */
export interface SourceMenu {
  first: MenuItem[];
  last: MenuItem[];
}

/** A command that has its own key binding, such as the shortcut of a repo Action. */
export interface BoundCommand extends Action {
  binding: string;
}

/** A right inspector section. Addon sections come after `git` and before `processes`, in `builtins` order. */
export interface InspectorSection {
  /** The `data-section` of the rendered section and the `ui.rightSection` value. It must not change. */
  id: string;
  /** The right rail button label. */
  label: string;
  icon: LucideIcon;
  /** Rendered only while the inspector is open on a worktree. */
  component: ComponentType<{ worktree: Worktree }>;
  /** The right rail marker for exceptional state. It reads the store and starts no work. */
  marker?: (s: State, w: Worktree) => RailMarker | null;
}

/** One built-in addon. Every slot is optional. The order of `builtins` is the render order of every slot. */
export interface Addon {
  id: string;
  views?: readonly GlobalView[];
  commands?: readonly Action[];
  inspectorSections?: readonly InspectorSection[];
  /** NOW signals of a worktree. They read the store, start no work, and come after the core signals. A card shows three at most. */
  worktreeSignals?: (s: State, worktreeId: Id) => readonly AddonSignal[];
  /** Draws each NOW signal of this `className` instead of the plain line. It reads the store and starts no work. */
  signalLine?: { className: string; Line: ComponentType<{ worktreeId: Id }> };
  /** The small image before a repo name in the sidebar and on Home. The first addon that has one wins. */
  repoAvatar?: ComponentType<{ repo: Repo; size: number }>;
  /** A field in the create-worktree dialog. The first addon that has one wins, like the daemon's one worktree namer. */
  worktreeNameField?: ComponentType<WorktreeNameFieldProps>;
  /** The worktree top bar. `buttons` render before the editor button; `marks` render after it, before the overflow menu. */
  topbar?: { buttons?: ComponentType<TopbarProps>; marks?: ComponentType<TopbarProps> };
  /** Items at the top of the worktree overflow menu. The menu adds a separator after a list that is not empty. */
  worktreeMenu?: (w: Worktree, s: State) => MenuItem[];
  /** A mark inside the control of a pane source that another addon draws, such as the arrow in an Action button. It reads the store and starts no work. */
  sourceMark?: ComponentType<SourceMarkProps>;
  /** Items for the menu of a running pane source that another addon draws. */
  sourceMenu?: (worktreeId: Id, source: SourceKey, s: State) => SourceMenu;
  /** The "Open App" URL of a worktree for an item that has none. The first addon that returns a URL wins. */
  appUrl?: (s: State, worktreeId: Id) => string | null;
  /** Palette entries for one worktree: `context` is true in the root list for the worktree on screen, and false in its sub-list. */
  paletteEntries?: (s: State, w: Worktree, context: boolean) => PaletteEntry[];
  /** Commands with a key binding in this state. Read on each key press and by the shortcut reference. */
  shortcuts?: (s: State) => BoundCommand[];
  /** The `PaneSource.kind` that this addon starts, and how to restart or stop one of its panes from a crash toast or another addon's menu. */
  paneSource?: { kind: string; restart: (worktreeId: Id, sourceId: string) => void; stop: (worktreeId: Id, sourceId: string) => void };
  /** Mounted once for the whole session. It must start no work until it has something to show. */
  mount?: ComponentType;
  /** An item in the middle of the bottom strip, before the status slot. It renders from its own state and starts no work. */
  bottomItem?: ComponentType;
  /** A section after the core sections of the diagnostics report. It renders nothing when it has nothing to report. */
  diagnosticsSection?: ComponentType;
  /** Called with each `subscribe` snapshot, before the core state changes. */
  onSnapshot?: (snapshot: Snapshot) => void;
  /** Receives every daemon event frame except pane output. */
  onFrame?: (frame: Frame) => void;
}
