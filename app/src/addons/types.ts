import type { LucideIcon } from "lucide-react";
import type { ComponentType, CSSProperties } from "react";
import type { Action } from "../actions";
import type { AddonSignal } from "../activityModel";
import type { AppRow } from "../appsModel";
import type { MenuItem } from "../components/ui";
import type { BranchTone, Mark, Status } from "../glyphs";
import type { PaletteEntry } from "../paletteModel";
import type { RailMarker } from "../sections";
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

/** A browser toolbar item of one pane. `url` is the page on screen; the item resets its own page state when it changes. `setCovering(true)` hides the page while the item shows a floating surface over it. */
export interface BrowserToolbarProps {
  paneId: Id;
  worktreeId: Id;
  url: string;
  setCovering: (covering: boolean) => void;
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

/** A group of the palette search. The palette ranks its entries with the core matcher. */
export interface SearchGroup {
  /** The group id. It must not change. */
  id: string;
  /** The group header. */
  label: string;
  /** Reads the store and starts no work. */
  entries: (s: State) => PaletteEntry[];
}

/** A link at the right of the name line of a worktree row, such as a pull request. The hover card shows it in full. */
export interface WorktreeLink {
  /** Unique across every addon. */
  id: string;
  /** The hover card label, such as `PR`. */
  label: string;
  icon: ComponentType<{ className?: string; style?: CSSProperties }>;
  /** A CSS color for the icon: the state of the linked item. */
  color: string | undefined;
  /** The short text beside the icon, such as `#412`. */
  text: string;
  title: string;
  /** Facts after the title in the hover card, such as `open` or `2 checks failing`. A `bad` fact is red. */
  facts: readonly { text: string; bad?: boolean }[];
}

/** A line in the apps group of a worktree row and its hover card: an app that runs, or one that crashed. */
export interface AppLine {
  /** Unique across every addon. */
  id: string;
  mark: Mark;
  label: string;
  /** The short text on the row, such as `:3003` or `exited -1`. */
  detail: string;
  /** The hover card text instead of `detail`, such as the whole address. */
  full?: string;
  bad?: boolean;
  /** The hover card shows `up 22 min` from this time. */
  upSinceMs?: number;
  /** The hover card shows `2 min ago` from this time. */
  atMs?: number;
}

/** One built-in addon. Every slot is optional. The order of `builtins` is the render order of every slot. */
export interface Addon {
  id: string;
  /** For a person: the name Settings shows. */
  label: string;
  /** One line on what this addon adds, shown beside the name. */
  description: string;
  views?: readonly GlobalView[];
  commands?: readonly Action[];
  inspectorSections?: readonly InspectorSection[];
  /** NOW signals of a worktree. They read the store, start no work, and come after the core signals. A card shows three at most. */
  worktreeSignals?: (s: State, worktreeId: Id) => readonly AddonSignal[];
  /** Draws each NOW signal of this `className` instead of the plain line. `Detail` draws it in the worktree hover card instead of its text. Both read the store and start no work. */
  signalLine?: { className: string; Line: ComponentType<{ worktreeId: Id }>; Detail?: ComponentType<{ worktreeId: Id }> };
  /** Links on the name line of a worktree row and in its hover card, in `builtins` order. They read the store and start no work. */
  worktreeLinks?: (s: State, w: Worktree) => readonly WorktreeLink[];
  /** Lines in the apps group of a worktree row and its hover card, in `builtins` order. They read the store and start no work. */
  appLines?: (s: State, worktreeId: Id) => readonly AppLine[];
  /** The small image before a repo name in the sidebar and on Home. The first addon that has one wins. */
  repoAvatar?: ComponentType<{ repo: Repo; size: number }>;
  /** A field in the create-worktree dialog. The first addon that has one wins, like the daemon's one worktree namer. */
  worktreeNameField?: ComponentType<WorktreeNameFieldProps>;
  /** The worktree top bar. `buttons` render before the editor button; `marks` render after it, before the overflow menu. */
  topbar?: { buttons?: ComponentType<TopbarProps>; marks?: ComponentType<TopbarProps> };
  /** Controls in the browser pane toolbar, after the url field and before open-external. */
  browserToolbar?: ComponentType<BrowserToolbarProps>;
  /** Items at the top of the worktree overflow menu. The menu adds a separator after a list that is not empty. */
  worktreeMenu?: (w: Worktree, s: State) => MenuItem[];
  /** A mark inside the control of a pane source that another addon draws, such as the arrow in an Action button. It reads the store and starts no work. */
  sourceMark?: ComponentType<SourceMarkProps>;
  /** Items for the menu of a running pane source that another addon draws. */
  sourceMenu?: (worktreeId: Id, source: SourceKey, s: State) => SourceMenu;
  /** The "Open App" URL of a worktree for an item that has none. The first addon that returns a URL wins. */
  appUrl?: (s: State, worktreeId: Id) => string | null;
  /** Rows for the Apps view. Core owns the view but finds no running app by itself, so an addon that watches for one fills these in. */
  apps?: (s: State) => readonly AppRow[];
  /** Rows inside the core git section, for an addon that knows more about the branch than git does. It draws no section and no heading of its own. */
  gitDetail?: ComponentType<{ worktree: Worktree }>;
  /** The git rail marker for exceptional branch state, such as a failed check. It reads the store and starts no work. */
  gitMarker?: (s: State, w: Worktree) => RailMarker | null;
  /** How the branch of a worktree card stands with its upstream. It reads the store and starts no work. */
  branchMark?: (s: State, w: Worktree) => { tone: BranchTone; text: string } | null;
  /** Palette entries for one worktree: `context` is true in the root list for the worktree on screen, and false in its sub-list. */
  paletteEntries?: (s: State, w: Worktree, context: boolean) => PaletteEntry[];
  /** Groups of the palette search, after the core groups that match as well as they do. */
  searchSources?: readonly SearchGroup[];
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
