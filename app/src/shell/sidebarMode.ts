import type { SidebarMode } from "../types";

const NEXT: Record<SidebarMode, SidebarMode> = { open: "minimal", minimal: "closed", closed: "open" };

export const cycleSidebar = (mode: SidebarMode): SidebarMode => NEXT[mode];
