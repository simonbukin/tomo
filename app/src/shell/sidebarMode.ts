import type { SidebarMode, UiState } from "../types";
import { SIDEBAR_MAX_WIDTH, SIDEBAR_MIN_WIDTH } from "../uiState";

export type Side = "left" | "right";

export const RAIL_WIDTH = 28;
export const MIDDLE_MIN_WIDTH = 400;
export const SNAP_CLOSED_BELOW = RAIL_WIDTH / 2;
export const SNAP_MINIMAL_BELOW = (RAIL_WIDTH + SIDEBAR_MIN_WIDTH) / 2;

const NEXT: Record<SidebarMode, SidebarMode> = { open: "minimal", minimal: "closed", closed: "open" };

export const cycleSidebar = (mode: SidebarMode): SidebarMode => NEXT[mode];

export const columnWidth = (mode: SidebarMode, openWidth: number): number => (mode === "open" ? openWidth : mode === "minimal" ? RAIL_WIDTH : 0);

export interface Snap {
  mode: SidebarMode;
  width: number | null;
}

/** Where a dragged boundary lands. `width` is set only for open, so minimal and closed keep the saved open width. */
export function snapSidebar(raw: number): Snap {
  if (!Number.isFinite(raw) || raw < SNAP_CLOSED_BELOW) return { mode: "closed", width: null };
  if (raw < SNAP_MINIMAL_BELOW) return { mode: "minimal", width: null };
  return { mode: "open", width: Math.round(Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, raw))) };
}

export function snapPatch(side: Side, raw: number): Partial<UiState> {
  const { mode, width } = snapSidebar(raw);
  if (side === "left") return width === null ? { leftMode: mode } : { leftMode: mode, leftWidth: width };
  return width === null ? { rightMode: mode } : { rightMode: mode, rightWidth: width };
}

export interface ShellLayout {
  left: SidebarMode;
  right: SidebarMode;
  leftCol: number;
  rightCol: number;
}

const collapseSteps = (mode: SidebarMode): SidebarMode[] => (["open", "minimal", "closed"] as const).slice(["open", "minimal", "closed"].indexOf(mode));

/**
 * The modes the window can hold. When the middle would drop under MIDDLE_MIN_WIDTH, the right sidebar
 * collapses first, then the left. The saved preference in UiState stays as it is.
 */
export function shellLayout(ui: Pick<UiState, "leftMode" | "rightMode" | "leftWidth" | "rightWidth">, windowWidth: number, rightAvailable: boolean): ShellLayout {
  const right = rightAvailable ? ui.rightMode : "closed";
  const candidates: [SidebarMode, SidebarMode][] = [
    ...collapseSteps(right).map((r): [SidebarMode, SidebarMode] => [ui.leftMode, r]),
    ...collapseSteps(ui.leftMode).slice(1).map((l): [SidebarMode, SidebarMode] => [l, "closed"]),
  ];
  const layout = ([l, r]: [SidebarMode, SidebarMode]): ShellLayout => ({ left: l, right: r, leftCol: columnWidth(l, ui.leftWidth), rightCol: columnWidth(r, ui.rightWidth) });
  const fits = (s: ShellLayout) => windowWidth - s.leftCol - s.rightCol >= MIDDLE_MIN_WIDTH;
  const layouts = candidates.map(layout);
  return layouts.find(fits) ?? layouts[layouts.length - 1];
}
