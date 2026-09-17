import { PanelLeft, PanelLeftDashed, PanelLeftOpen, PanelRight, PanelRightDashed, PanelRightOpen, type LucideIcon } from "lucide-react";
import { runAction } from "../actions";
import { addonViews } from "../addons";
import { Mark, Wordmark } from "../Brand";
import { IconButton } from "../components/ui";
import { useShortcuts } from "../shortcuts";
import { useStore } from "../store";
import type { SidebarMode, Worktree } from "../types";
import { WorktreeHeader } from "../WorktreeHeader";
import type { ShellLayout, Side } from "./sidebarMode";

const VIEW_TITLE: Record<string, string> = { home: "home", activity: "activity", agents: "agents", apps: "apps", worktree: "worktree" };
const viewTitle = (view: string) => VIEW_TITLE[view] ?? addonViews().find((v) => v.id === view)?.title ?? "home";

const TOGGLE_ICON: Record<Side, Record<SidebarMode, LucideIcon>> = {
  left: { open: PanelLeft, minimal: PanelLeftDashed, closed: PanelLeftOpen },
  right: { open: PanelRight, minimal: PanelRightDashed, closed: PanelRightOpen },
};

export function SidebarToggle({ side, mode }: { side: Side; mode: SidebarMode }) {
  const shortcut = useShortcuts();
  const id = side === "left" ? "toggle_left_sidebar" : "toggle_right_sidebar";
  const Icon = TOGGLE_ICON[side][mode];
  return (
    <IconButton label={side === "left" ? "Toggle sidebar" : "Toggle inspector"} shortcut={shortcut(id)} className="side-toggle" data-mode={mode} onClick={() => runAction(id)}>
      <Icon className="icon" />
    </IconButton>
  );
}

/** Traffic-light safe area, the Tomo mark, and the left sidebar control. Its width never drops under the safe area. */
export function TopLeft({ mode }: { mode: SidebarMode }) {
  const shortcut = useShortcuts();
  return (
    <div className="top-left" data-mode={mode} data-tauri-drag-region>
      <button type="button" className="top-brand" aria-label="Home" title={shortcut("home") ? `Home · ${shortcut("home")}` : "Home"} onClick={() => runAction("home")}>
        <Mark size={15} />
        <Wordmark height={13} />
      </button>
      <SidebarToggle side="left" mode={mode} />
    </div>
  );
}

/** The fixed top strip: three regions on the shell columns. Empty space drags the window. */
export function TopStrip({ worktree, layout }: { worktree: Worktree | null; layout: ShellLayout }) {
  const view = useStore((s) => s.ui.view);
  return (
    <header className="topbar" data-tauri-drag-region>
      <TopLeft mode={layout.left} />
      <div className="top-middle" data-tauri-drag-region>
        {worktree ? <WorktreeHeader worktree={worktree} /> : <span className="top-title" data-tauri-drag-region>{viewTitle(view)}</span>}
      </div>
      <div className="top-right" data-tauri-drag-region>
        {worktree && <SidebarToggle side="right" mode={layout.right} />}
      </div>
    </header>
  );
}
