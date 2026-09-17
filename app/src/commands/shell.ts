import type { Action } from "../actions";
import { cycleSidebar, shellLayout, type Side } from "../shell/sidebarMode";
import { getState, setUi } from "../store";
import type { SidebarMode, UiState } from "../types";

const MODES: readonly SidebarMode[] = ["open", "minimal", "closed"];
const SIDE_LABEL: Record<Side, string> = { left: "Left sidebar", right: "Right sidebar" };

const modePatch = (side: Side, mode: SidebarMode): Partial<UiState> => (side === "left" ? { leftMode: mode } : { rightMode: mode });

/** Cycles from the mode on screen, so a sidebar that a narrow window collapsed does not need a click that shows nothing. */
export function toggleSidebar(side: Side, windowWidth = window.innerWidth): void {
  const { ui } = getState();
  const shown = shellLayout(ui, windowWidth, side === "right" || ui.view === "worktree")[side];
  setUi(modePatch(side, cycleSidebar(shown)));
}

export const commands: Action[] = [
  { id: "toggle_left_sidebar", label: "Toggle left sidebar", group: "Navigation", run: () => toggleSidebar("left") },
  { id: "toggle_right_sidebar", label: "Toggle right sidebar", group: "Navigation", run: () => toggleSidebar("right") },
  // Three ways to hold the shell, as presets over the two sidebar modes. Nothing stores
  // "zen", so a person can still nudge one side afterwards.
  { id: "layout_full", label: "Layout: full, both sides open", group: "Navigation", run: () => setUi({ leftMode: "open", rightMode: "open" }) },
  { id: "layout_focused", label: "Layout: focused, both sides minimal", group: "Navigation", run: () => setUi({ leftMode: "minimal", rightMode: "minimal" }) },
  { id: "layout_zen", label: "Layout: zen, both sides closed", group: "Navigation", run: () => setUi({ leftMode: "closed", rightMode: "closed" }) },
  ...(["left", "right"] as const).flatMap((side) =>
    MODES.map((mode): Action => ({ id: `${side}_sidebar_${mode}`, label: `${SIDE_LABEL[side]}: ${mode}`, group: "Navigation", run: () => setUi(modePatch(side, mode)) })),
  ),
];
