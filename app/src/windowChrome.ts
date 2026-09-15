import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect } from "react";
import { activeTab, getState, type State } from "./store";
import { focusTerminal } from "./terminals";
import type { Id } from "./types";

/** The pane that must get focus back when the window regains focus, or null when focus is already somewhere useful. */
export function paneToRestore(s: State, focused: Element | null): Id | null {
  if (focused && focused !== document.body) return null;
  if (s.ui.view !== "worktree" || s.dialog || s.paletteOpen) return null;
  return activeTab(s, s.ui.activeWorktreeId)?.active_pane_id ?? null;
}

/** Tracks native fullscreen (no traffic-light inset) and puts focus back on the active pane when the window regains focus. */
export function useWindowChrome(): void {
  useEffect(() => {
    const onFocus = () => {
      const pane = paneToRestore(getState(), document.activeElement);
      if (pane) focusTerminal(pane);
    };
    window.addEventListener("focus", onFocus);
    let unlisten: (() => void) | null = null;
    let disposed = false;
    try {
      const win = getCurrentWindow();
      const sync = () => win.isFullscreen().then((full) => document.documentElement.toggleAttribute("data-fullscreen", full)).catch(() => {});
      sync();
      win.onResized(sync).then((off) => (disposed ? off() : (unlisten = off))).catch(() => {});
    } catch {}
    return () => {
      disposed = true;
      window.removeEventListener("focus", onFocus);
      unlisten?.();
    };
  }, []);
}
