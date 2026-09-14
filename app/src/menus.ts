import { archiveWorktree, bulkAddTag, bulkArchive, bulkMetadata, bulkPrompt, bulkRestore, closeOtherTabs, closePane, closeTab, copyText, equalizeTab, killPaneTree, newTabIn, newTerminalIn, openExternalFor, openWorktree, promptMetadata, removeRepo, renamePane, restoreWorktree, rotateSplit, setMetadata, setRepoHidden, spawnAgent, splitPaneById, swapPanes, toggleZoom } from "./actions";
import type { MenuItem } from "./ContextMenu";
import { orderedStates } from "./homeQuery";
import { clearSelection, getState, paneIds, setState } from "./store";
import type { Id, Repo, Tab, Worktree } from "./types";

function stateItems(current: string | null, apply: (state: string | null) => void): MenuItem[] {
  const states = orderedStates(getState().config?.states ?? []);
  return [
    ...states.map((s) => ({ label: s.label, checked: current === s.id, run: () => apply(s.id) })),
    { separator: true },
    { label: "clear state", checked: current === null, run: () => apply(null) },
  ];
}

export function worktreeMenu(w: Worktree): MenuItem[] {
  const archived = !!w.archived_at_ms;
  const busy = w.archiving;
  const live = w.exists && !archived && !busy;
  return [
    { label: busy ? "archiving…" : "open", disabled: !w.exists || archived || busy, run: () => openWorktree(w.id) },
    { label: "new tab", disabled: !live, run: () => newTabIn(w.id) },
    { label: "new terminal", disabled: !live, run: () => newTerminalIn(w.id) },
    { label: "start claude", disabled: !live, run: () => spawnAgent("claude", w.id) },
    { label: "start codex", disabled: !live, run: () => spawnAgent("codex", w.id) },
    { label: "start pi", disabled: !live, run: () => spawnAgent("pi", w.id) },
    { separator: true },
    { label: "state", disabled: busy, submenu: stateItems(w.metadata.state, (state) => setMetadata(w.id, { state })) },
    { label: "set project…", disabled: busy, run: () => promptMetadata("project", w.id) },
    { label: "rename…", disabled: busy, run: () => promptMetadata("display_name", w.id) },
    { label: "set tags…", disabled: busy, run: () => promptMetadata("tags", w.id) },
    { separator: true },
    { label: "open in editor", disabled: !w.exists || busy, run: () => openExternalFor(w.id, "editor") },
    { label: "reveal in finder", disabled: !w.exists || busy, run: () => openExternalFor(w.id, "finder") },
    { label: "copy path", run: () => copyText(w.path) },
    { separator: true },
    archived
      ? { label: "restore", disabled: busy, run: () => restoreWorktree(w.id) }
      : { label: "archive…", danger: true, disabled: w.is_main || busy, run: () => archiveWorktree(w.id) },
  ];
}

export function repoMenu(r: Repo): MenuItem[] {
  const hidden = getState().ui.hiddenRepos.includes(r.id);
  return [
    { label: "new worktree…", run: () => setState({ dialog: { kind: "create-worktree", repoId: r.id } }) },
    { separator: true },
    { label: "reveal in finder", run: () => revealRepo(r) },
    { label: "copy path", run: () => copyText(r.path) },
    { separator: true },
    hidden ? { label: "unhide repo", run: () => setRepoHidden(r.id, false) } : { label: "hide repo", run: () => setRepoHidden(r.id, true) },
    { label: "remove repo", danger: true, run: () => removeRepo(r.id) },
  ];
}

export function bulkMenu(ids: Id[]): MenuItem[] {
  const ws = ids.map((id) => getState().worktrees.find((w) => w.id === id)).filter((w): w is Worktree => !!w);
  const anyArchived = ws.some((w) => !!w.archived_at_ms);
  const shared = ws.every((w) => w.metadata.state === ws[0]?.metadata.state) ? (ws[0]?.metadata.state ?? null) : undefined;
  return [
    { label: `${ids.length} worktrees`, disabled: true },
    { separator: true },
    { label: "state", submenu: stateItems(shared === undefined ? "" : shared, (state) => bulkMetadata(ids, { state })) },
    { label: "set project…", run: () => bulkPrompt("project", ids) },
    { label: "set tags…", run: () => bulkPrompt("tags", ids) },
    { label: "add tag…", run: () => bulkAddTag(ids) },
    { separator: true },
    { label: "archive…", danger: true, run: () => bulkArchive(ids) },
    ...(anyArchived ? [{ label: "restore", run: () => bulkRestore(ids) } as MenuItem] : []),
    { separator: true },
    { label: "clear selection", run: clearSelection },
  ];
}

function revealRepo(r: Repo): void {
  const main = getState().worktrees.find((w) => w.repo_id === r.id && w.is_main) ?? getState().worktrees.find((w) => w.repo_id === r.id);
  if (main) openExternalFor(main.id, "finder");
}

export function tabMenu(t: Tab, rename: () => void): MenuItem[] {
  const multi = paneIds(t.layout).length > 1;
  return [
    { label: "rename", run: rename },
    { separator: true },
    { label: "equalize panes", disabled: !multi, run: () => equalizeTab(t.id) },
    { label: "rotate split", disabled: !multi, run: () => rotateSplit(t.id) },
    { separator: true },
    { label: "close", run: () => closeTab(t.id) },
    { label: "close other tabs", run: () => closeOtherTabs(t.id) },
  ];
}

export function paneMenu(paneId: Id): MenuItem[] {
  const s = getState();
  const pane = s.panes[paneId];
  const tab = pane ? Object.values(s.tabs).flat().find((t) => t.id === pane.tab_id) : undefined;
  const others = tab ? paneIds(tab.layout).filter((id) => id !== paneId) : [];
  const zoomed = tab ? s.zoomed[tab.id] === paneId : false;
  return [
    { label: "split right", run: () => splitPaneById(paneId, "horizontal") },
    { label: "split down", run: () => splitPaneById(paneId, "vertical") },
    { label: zoomed ? "unzoom" : "zoom", disabled: !zoomed && others.length === 0, run: () => toggleZoom(paneId) },
    { label: "swap with", disabled: others.length === 0, submenu: others.map((id) => ({ label: s.panes[id]?.title ?? id, run: () => swapPanes(paneId, id) })) },
    { label: "rename pane…", run: () => renamePane(paneId) },
    { separator: true },
    { label: "kill process tree", danger: true, run: () => killPaneTree(paneId) },
    { label: "close", run: () => closePane(paneId) },
  ];
}

export function fileMenu(w: Worktree, relPath: string): MenuItem[] {
  const abs = relPath ? `${w.path}/${relPath}` : w.path;
  return [
    { label: "open in editor", run: () => openExternalFor(w.id, "editor", relPath) },
    { label: "reveal in finder", run: () => openExternalFor(w.id, "finder", relPath) },
    { separator: true },
    { label: "copy path", run: () => copyText(abs) },
    { label: "copy relative path", disabled: !relPath, run: () => copyText(relPath, "Relative path") },
  ];
}
