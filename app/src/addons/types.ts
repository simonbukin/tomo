import type { LucideIcon } from "lucide-react";
import type { ComponentType } from "react";
import type { Action } from "../actions";
import type { AddonSignal } from "../activityModel";
import type { MenuItem } from "../components/ui";
import type { Status } from "../glyphs";
import type { PaletteEntry } from "../paletteModel";
import type { RailMarker } from "../shell/RightRail";
import type { State } from "../store";
import type { ActivityEvent, Frame, Id, Repo, RuntimeEndpoint, Snapshot, Worktree } from "../types";

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
  /** The small image before a repo name in the sidebar and on Home. The first addon that has one wins. */
  repoAvatar?: ComponentType<{ repo: Repo; size: number }>;
  /** A field in the create-worktree dialog. The first addon that has one wins, like the daemon's one worktree namer. */
  worktreeNameField?: ComponentType<WorktreeNameFieldProps>;
  /** The worktree top bar. `buttons` render before the editor button; `marks` render after it, before the runtime and overflow buttons. */
  topbar?: { buttons?: ComponentType<TopbarProps>; marks?: ComponentType<TopbarProps> };
  /** Items at the top of the worktree overflow menu. The menu adds a separator after a list that is not empty. */
  worktreeMenu?: (w: Worktree, s: State) => MenuItem[];
  /** Items after "focus logs" in the menu of one runtime endpoint. */
  endpointMenu?: (worktreeId: Id, e: RuntimeEndpoint, s: State) => MenuItem[];
  /** Palette entries for one worktree: `context` is true in the root list for the worktree on screen, and false in its sub-list. */
  paletteEntries?: (s: State, w: Worktree, context: boolean) => PaletteEntry[];
  /** Commands with a key binding in this state. Read on each key press and by the shortcut reference. */
  shortcuts?: (s: State) => BoundCommand[];
  /** The `PaneSource.kind` that this addon starts, and how to start it again from a crash toast. */
  paneSource?: { kind: string; restart: (worktreeId: Id, sourceId: string) => void };
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
