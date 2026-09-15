import { browserCommand, closeOtherTabs, currentWorktree, equalizeTab, focusedPaneId, openBrowser, rotateSplit, type Action } from "../actions";
import { activeTab, getState, setState } from "../store";
import type { Id } from "../types";
import { movePane, moveTab as moveTabTo } from "./panes";

export function moveTab(tabId: Id, delta: number): void {
  const tabs = Object.values(getState().tabs).find((list) => list.some((t) => t.id === tabId)) ?? [];
  const from = tabs.findIndex((t) => t.id === tabId);
  const to = from + delta;
  if (from < 0 || to < 0 || to >= tabs.length) return;
  moveTabTo(tabId, to);
}

export function sendPaneToTab(paneId: Id, tabId: Id): void {
  movePane(paneId, { tabId }, "right");
}

const withTab = (run: (tabId: Id) => void) => () => {
  const s = getState();
  const tab = activeTab(s, s.ui.activeWorktreeId);
  if (tab) run(tab.id);
};

const focusedBrowser = (): Id | null => {
  const id = focusedPaneId();
  return id && getState().panes[id]?.kind === "browser" ? id : null;
};

const browser = (command: "browser_back" | "browser_forward" | "browser_reload") => () => {
  const id = focusedBrowser();
  if (id) browserCommand(id, command);
};

export const commands: Action[] = [
  { id: "keyboard_shortcuts", label: "Keyboard shortcuts", group: "General", run: () => setState({ shortcutsOpen: true, paletteOpen: false }) },
  { id: "equalize_panes", label: "Equalize panes", group: "Panes", whenWorktree: true, run: withTab((id) => equalizeTab(id)) },
  { id: "rotate_split", label: "Rotate split", group: "Panes", whenWorktree: true, run: withTab((id) => rotateSplit(id)) },
  { id: "move_tab_left", label: "Move tab left", group: "Tabs", whenWorktree: true, run: withTab((id) => moveTab(id, -1)) },
  { id: "move_tab_right", label: "Move tab right", group: "Tabs", whenWorktree: true, run: withTab((id) => moveTab(id, 1)) },
  { id: "close_other_tabs", label: "Close other tabs", group: "Tabs", whenWorktree: true, run: withTab((id) => closeOtherTabs(id)) },
  { id: "new_browser", label: "New browser", group: "Browser", whenWorktree: true, run: () => void (currentWorktree() && openBrowser(currentWorktree()!.id)) },
  { id: "browser_back", label: "Browser back", group: "Browser", whenWorktree: true, when: () => !!focusedBrowser(), run: browser("browser_back") },
  { id: "browser_forward", label: "Browser forward", group: "Browser", whenWorktree: true, when: () => !!focusedBrowser(), run: browser("browser_forward") },
  { id: "browser_reload", label: "Browser reload", group: "Browser", whenWorktree: true, when: () => !!focusedBrowser(), run: browser("browser_reload") },
];
