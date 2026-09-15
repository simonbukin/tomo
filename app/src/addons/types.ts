import type { LucideIcon } from "lucide-react";
import type { ComponentType } from "react";
import type { Action } from "../actions";
import type { Status } from "../glyphs";
import type { State } from "../store";
import type { ActivityEvent, Frame, Snapshot } from "../types";

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

/** One built-in addon. Every slot is optional. The order of `builtins` is the render order of every slot. */
export interface Addon {
  id: string;
  views?: readonly GlobalView[];
  commands?: readonly Action[];
  /** A field in the create-worktree dialog. The first addon that has one wins, like the daemon's one worktree namer. */
  worktreeNameField?: ComponentType<WorktreeNameFieldProps>;
  /** Mounted once for the whole session. It must start no work until it has something to show. */
  mount?: ComponentType;
  /** An item in the middle of the bottom strip, before the status slot. It renders from its own state and starts no work. */
  bottomItem?: ComponentType;
  /** A section after the core sections of the diagnostics report. It renders nothing when it has nothing to report. */
  diagnosticsSection?: ComponentType;
  /** Called with each `subscribe` snapshot. */
  onSnapshot?: (snapshot: Snapshot) => void;
  /** Receives every daemon event frame except pane output. */
  onFrame?: (frame: Frame) => void;}
