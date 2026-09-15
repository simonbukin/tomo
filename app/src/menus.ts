import { archiveWorktree, bulkAddTag, bulkArchive, bulkMetadata, bulkPrompt, bulkRestore, closeOtherTabs, closePane, closeTab, copyText, equalizeTab, killPaneTree, newTabIn, newTerminalIn, openExternalFor, openExternalUrl, openWorktree, promptMetadata, removeRepo, renamePane, restoreWorktree, rotateSplit, setMetadata, setRepoHidden, spawnAgent, splitPane, splitPaneById, swapPanes, toggleZoom } from "./actions";
import { browserCommand, openBrowser } from "./browser/browser";
import { builtins } from "./addons";
import { moveTab, sendPaneToTab } from "./commands/discovery";
import type { MenuItem } from "./components/ui";
import { orderedStates } from "./homeQuery";
import { chordFor, effectiveBindings } from "./shortcuts";
import { activeTab, clearSelection, getState, paneIds, setState, type State } from "./store";
import type { Id, Pane, Repo, Tab, Worktree } from "./types";

const sep: MenuItem = { separator: true };

const shortcutIn = (s: State, id: string) => chordFor(id, effectiveBindings(s.config?.keybindings ?? {}));

/** `[what, value, label?]`: `what` names the value in the toast; entries without a value drop out. */
type CopyEntry = [string, string | null | undefined, string?];

function copyMenu(entries: CopyEntry[]): MenuItem {
  const items = entries.flatMap(([what, value, label]): MenuItem[] => (value ? [{ label: label ?? what.toLowerCase(), run: () => copyText(value, what) }] : []));
  return { label: "copy", disabled: items.length === 0, submenu: items };
}

export function editorName(command: string[] | undefined): string {
  const bin = (command ?? []).filter((arg) => !arg.startsWith("-") && !arg.includes("{")).pop();
  return bin?.split("/").pop() || "editor";
}

export function toggledTag(tags: string[], tag: string): string[] {
  return tags.includes(tag) ? tags.filter((t) => t !== tag) : [...tags, tag];
}

function stateItems(s: State, current: string | null, apply: (state: string | null) => void): MenuItem[] {
  const states = orderedStates(s.config?.states ?? []);
  return [
    ...states.map((st) => ({ label: st.label, checked: current === st.id, run: () => apply(st.id) })),
    sep,
    { label: "clear state", checked: current === null, run: () => apply(null) },
  ];
}

function tagItems(s: State, w: Worktree): MenuItem[] {
  const known = [...new Set(s.worktrees.flatMap((x) => x.metadata.tags))].sort();
  return [
    ...known.map((tag) => ({ label: tag, checked: w.metadata.tags.includes(tag), run: () => setMetadata(w.id, { tags: toggledTag(w.metadata.tags, tag) }) })),
    ...(known.length ? [sep] : []),
    { label: "edit tags…", run: () => promptMetadata("tags", w.id) },
  ];
}

export function worktreeMenu(w: Worktree, s: State = getState()): MenuItem[] {
  const archived = !!w.archived_at_ms;
  const busy = w.archiving;
  const live = w.exists && !archived && !busy;
  return [
    { label: busy ? "archiving…" : "open", disabled: !w.exists || archived || busy, run: () => openWorktree(w.id) },
    { label: "new tab", disabled: !live, run: () => newTabIn(w.id) },
    { label: "new terminal", disabled: !live, run: () => newTerminalIn(w.id) },
    { label: "new claude", disabled: !live, run: () => spawnAgent("claude", w.id) },
    { label: "new codex", disabled: !live, run: () => spawnAgent("codex", w.id) },
    { label: "new pi", disabled: !live, run: () => spawnAgent("pi", w.id) },
    sep,
    ...worktreeDetailItems(w, s),
  ];
}

function worktreeDetailItems(w: Worktree, s: State): MenuItem[] {
  const archived = !!w.archived_at_ms;
  const busy = w.archiving;
  return [
    { label: "state", disabled: busy, submenu: stateItems(s, w.metadata.state, (state) => setMetadata(w.id, { state })) },
    { label: "tags", disabled: busy, submenu: tagItems(s, w) },
    { label: "set project…", disabled: busy, run: () => promptMetadata("project", w.id) },
    { label: "rename…", disabled: busy, run: () => promptMetadata("display_name", w.id) },
    sep,
    { label: `open in ${editorName(s.config?.editor_command)}`, disabled: !w.exists || busy, run: () => openExternalFor(w.id, "editor") },
    { label: "reveal in finder", disabled: !w.exists || busy, run: () => openExternalFor(w.id, "finder") },
    copyMenu([
      ["Path", w.path],
      ["Branch", w.branch],
      ["Worktree ID", w.id],
    ]),
    sep,
    archived
      ? { label: "restore", disabled: busy, run: () => restoreWorktree(w.id) }
      : { label: "archive…", danger: true, disabled: w.is_main || busy, run: () => archiveWorktree(w.id) },
  ];
}

export function overflowMenu(w: Worktree, s: State = getState()): MenuItem[] {
  const acts = builtins.flatMap((a) => {
    const items = a.worktreeMenu?.(w, s) ?? [];
    return items.length ? [...items, sep] : [];
  });
  const tab = activeTab(s, w.id);
  const multi = tab ? paneIds(tab.layout).length > 1 : false;
  return [
    ...acts,
    { label: "split right", shortcut: shortcutIn(s, "new_terminal"), run: () => splitPane("horizontal") },
    { label: "split down", shortcut: shortcutIn(s, "split_vertical"), run: () => splitPane("vertical") },
    { label: "equalize panes", shortcut: shortcutIn(s, "equalize_panes"), disabled: !multi, run: () => equalizeTab(tab!.id) },
    { label: "rotate split", shortcut: shortcutIn(s, "rotate_split"), disabled: !multi, run: () => rotateSplit(tab!.id) },
    sep,
    ...worktreeDetailItems(w, s),
  ];
}

export function repoMenu(r: Repo, s: State = getState()): MenuItem[] {
  const hidden = s.ui.hiddenRepos.includes(r.id);
  return [
    { label: "new worktree…", run: () => setState({ dialog: { kind: "create-worktree", repoId: r.id } }) },
    sep,
    { label: "reveal in finder", run: () => revealRepo(r) },
    { label: "copy path", run: () => copyText(r.path) },
    sep,
    hidden ? { label: "unhide repo", run: () => setRepoHidden(r.id, false) } : { label: "hide repo", run: () => setRepoHidden(r.id, true) },
    { label: "remove repo", danger: true, run: () => removeRepo(r.id) },
  ];
}

export function bulkMenu(ids: Id[]): MenuItem[] {
  const s = getState();
  const ws = ids.map((id) => s.worktrees.find((w) => w.id === id)).filter((w): w is Worktree => !!w);
  const anyArchived = ws.some((w) => !!w.archived_at_ms);
  const shared = ws.every((w) => w.metadata.state === ws[0]?.metadata.state) ? (ws[0]?.metadata.state ?? null) : undefined;
  return [
    { label: `${ids.length} worktrees`, disabled: true },
    sep,
    { label: "state", submenu: stateItems(s, shared === undefined ? "" : shared, (state) => bulkMetadata(ids, { state })) },
    { label: "set project…", run: () => bulkPrompt("project", ids) },
    { label: "set tags…", run: () => bulkPrompt("tags", ids) },
    { label: "add tag…", run: () => bulkAddTag(ids) },
    sep,
    { label: "archive…", danger: true, run: () => bulkArchive(ids) },
    ...(anyArchived ? [{ label: "restore", run: () => bulkRestore(ids) } as MenuItem] : []),
    sep,
    { label: "clear selection", run: clearSelection },
  ];
}

function revealRepo(r: Repo): void {
  const main = getState().worktrees.find((w) => w.repo_id === r.id && w.is_main) ?? getState().worktrees.find((w) => w.repo_id === r.id);
  if (main) openExternalFor(main.id, "finder");
}

export function tabMenu(t: Tab, rename: () => void, s: State = getState()): MenuItem[] {
  const tabs = s.tabs[t.worktree_id] ?? [];
  const idx = tabs.findIndex((x) => x.id === t.id);
  const key = (id: string) => (t.is_active ? shortcutIn(s, id) : undefined);
  return [
    { label: "rename", shortcut: key("rename_tab"), run: rename },
    sep,
    { label: "move left", shortcut: key("move_tab_left"), disabled: idx <= 0, run: () => moveTab(t.id, -1) },
    { label: "move right", shortcut: key("move_tab_right"), disabled: idx < 0 || idx >= tabs.length - 1, run: () => moveTab(t.id, 1) },
    sep,
    { label: "close", shortcut: key("close_tab"), run: () => closeTab(t.id) },
    { label: "close others", shortcut: key("close_other_tabs"), disabled: tabs.length < 2, run: () => closeOtherTabs(t.id) },
  ];
}

/** The last pane of the last tab cannot close: the worktree view would open a new one at once. */
export function isLastPane(paneId: Id, s: State = getState()): boolean {
  const pane = s.panes[paneId];
  if (!pane) return false;
  const tabs = s.tabs[pane.worktree_id] ?? [];
  return tabs.length <= 1 && tabs.every((t) => paneIds(t.layout).length <= 1);
}

/** New tabs first, then splits of the focused pane in the current tab. */
export function spawnMenu(worktreeId: Id, s: State = getState()): MenuItem[] {
  const tab = activeTab(s, worktreeId);
  const pane = tab?.active_pane_id ?? null;
  const agents = ["claude", "codex", "pi"] as const;
  return [
    { label: "terminal", shortcut: shortcutIn(s, "new_tab"), run: () => newTabIn(worktreeId) },
    { label: "browser", shortcut: shortcutIn(s, "new_browser"), run: () => openBrowser(worktreeId) },
    ...agents.map((kind): MenuItem => ({ label: kind, run: () => spawnAgent(kind, worktreeId, { newTab: true }) })),
    sep,
    { label: "split right", shortcut: shortcutIn(s, "new_terminal"), disabled: !pane, run: () => splitPaneById(pane!, "horizontal") },
    { label: "split down", shortcut: shortcutIn(s, "split_vertical"), disabled: !pane, run: () => splitPaneById(pane!, "vertical") },
    {
      label: "split with",
      disabled: !pane,
      submenu: [{ label: "browser", run: () => openBrowser(worktreeId, null, tab!.id) }, ...agents.map((kind): MenuItem => ({ label: kind, run: () => spawnAgent(kind, worktreeId) }))],
    },
  ];
}

function sendToItem(s: State, pane: Pane | undefined): MenuItem {
  const targets = pane ? (s.tabs[pane.worktree_id] ?? []).filter((t) => t.id !== pane.tab_id) : [];
  return { label: "send to", disabled: targets.length === 0, submenu: targets.map((t) => ({ label: t.title, run: () => sendPaneToTab(pane!.id, t.id) })) };
}

function paneContext(s: State, paneId: Id) {
  const pane = s.panes[paneId];
  const tab = pane ? (s.tabs[pane.worktree_id] ?? []).find((t) => t.id === pane.tab_id) : undefined;
  const focused = !!pane && !!tab?.is_active && tab.active_pane_id === paneId && s.ui.view === "worktree" && s.ui.activeWorktreeId === pane.worktree_id;
  return { pane, tab, key: (id: string) => (focused ? shortcutIn(s, id) : undefined) };
}

export function paneMenu(paneId: Id, s: State = getState()): MenuItem[] {
  const { pane, tab, key } = paneContext(s, paneId);
  const others = tab ? paneIds(tab.layout).filter((id) => id !== paneId) : [];
  const zoomed = tab ? s.zoomed[tab.id] === paneId : false;
  const multi = others.length > 0;
  return [
    { label: "split right", shortcut: key("new_terminal"), run: () => splitPaneById(paneId, "horizontal") },
    { label: "split down", shortcut: key("split_vertical"), run: () => splitPaneById(paneId, "vertical") },
    { label: zoomed ? "unzoom" : "zoom", shortcut: key("zoom_pane"), disabled: !zoomed && !multi, run: () => toggleZoom(paneId) },
    { label: "equalize", shortcut: key("equalize_panes"), disabled: !multi, run: () => equalizeTab(tab!.id) },
    { label: "rotate", shortcut: key("rotate_split"), disabled: !multi, run: () => rotateSplit(tab!.id) },
    { label: "swap with", disabled: !multi, submenu: others.map((id) => ({ label: s.panes[id]?.title ?? id, run: () => swapPanes(paneId, id) })) },
    sep,
    sendToItem(s, pane),
    sep,
    { label: "rename pane…", run: () => renamePane(paneId) },
    copyMenu([
      ["CWD", pane?.cwd],
      ["Session ID", pane?.agent?.session_ref],
    ]),
    sep,
    { label: "kill process tree", danger: true, run: () => killPaneTree(paneId) },
    { label: "close", shortcut: key("close_pane"), disabled: isLastPane(paneId, s), run: () => closePane(paneId) },
  ];
}

export function browserMenu(paneId: Id, s: State = getState()): MenuItem[] {
  const { pane, key } = paneContext(s, paneId);
  const url = pane?.url ?? "";
  return [
    { label: "back", shortcut: key("browser_back"), run: () => browserCommand(paneId, "browser_back") },
    { label: "forward", shortcut: key("browser_forward"), run: () => browserCommand(paneId, "browser_forward") },
    { label: "reload", shortcut: key("browser_reload"), run: () => browserCommand(paneId, "browser_reload") },
    sep,
    { label: "open in external browser", disabled: !url || url === "about:blank", run: () => openExternalUrl(url) },
    copyMenu([["URL", url]]),
    sep,
    sendToItem(s, pane),
    sep,
    { label: "close", shortcut: key("close_pane"), disabled: isLastPane(paneId, s), run: () => closePane(paneId) },
  ];
}

export function fileMenu(w: Worktree, relPath: string): MenuItem[] {
  const abs = relPath ? `${w.path}/${relPath}` : w.path;
  return [
    { label: "open in editor", run: () => openExternalFor(w.id, "editor", relPath) },
    { label: "reveal in finder", run: () => openExternalFor(w.id, "finder", relPath) },
    sep,
    { label: "copy path", run: () => copyText(abs) },
    { label: "copy relative path", disabled: !relPath, run: () => copyText(relPath, "Relative path") },
  ];
}
