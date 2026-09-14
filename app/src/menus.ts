import { archiveWorktree, closeOtherTabs, closePane, closeTab, copyText, killPaneTree, newTabIn, newTerminalIn, openExternalFor, openWorktree, promptMetadata, removeRepo, renamePane, restoreWorktree, setMetadata, spawnAgent, splitPaneById } from "./actions";
import type { MenuItem } from "./ContextMenu";
import { getState, setState } from "./store";
import type { Id, Repo, Tab, Worktree } from "./types";

export function worktreeMenu(w: Worktree): MenuItem[] {
  const archived = !!w.archived_at_ms;
  const live = w.exists && !archived;
  const priority = (p: number | null): MenuItem => ({ label: p ? `p${p}` : "unset", checked: (w.metadata.priority ?? null) === p, run: () => setMetadata(w.id, { priority: p }) });
  return [
    { label: "open", disabled: !live, run: () => openWorktree(w.id) },
    { label: "new tab", disabled: !live, run: () => newTabIn(w.id) },
    { label: "new terminal", disabled: !live, run: () => newTerminalIn(w.id) },
    { label: "start claude", disabled: !live, run: () => spawnAgent("claude", w.id) },
    { label: "start codex", disabled: !live, run: () => spawnAgent("codex", w.id) },
    { label: "start pi", disabled: !live, run: () => spawnAgent("pi", w.id) },
    { separator: true },
    { label: "priority", submenu: [priority(1), priority(2), priority(3), priority(4), { separator: true }, priority(null)] },
    { label: "set project…", run: () => promptMetadata("project", w.id) },
    { label: "rename…", run: () => promptMetadata("display_name", w.id) },
    { label: "set tags…", run: () => promptMetadata("tags", w.id) },
    { separator: true },
    { label: "open in editor", disabled: !w.exists, run: () => openExternalFor(w.id, "editor") },
    { label: "reveal in finder", disabled: !w.exists, run: () => openExternalFor(w.id, "finder") },
    { label: "copy path", run: () => copyText(w.path) },
    { separator: true },
    archived
      ? { label: "restore", run: () => restoreWorktree(w.id) }
      : { label: "archive…", danger: true, disabled: w.is_main, run: () => archiveWorktree(w.id) },
  ];
}

export function repoMenu(r: Repo): MenuItem[] {
  return [
    { label: "new worktree…", run: () => setState({ dialog: { kind: "create-worktree", repoId: r.id } }) },
    { separator: true },
    { label: "reveal in finder", run: () => revealRepo(r) },
    { label: "copy path", run: () => copyText(r.path) },
    { separator: true },
    { label: "remove repo", danger: true, run: () => removeRepo(r.id) },
  ];
}

function revealRepo(r: Repo): void {
  const main = getState().worktrees.find((w) => w.repo_id === r.id && w.is_main) ?? getState().worktrees.find((w) => w.repo_id === r.id);
  if (main) openExternalFor(main.id, "finder");
}

export function tabMenu(t: Tab, rename: () => void): MenuItem[] {
  return [
    { label: "rename", run: rename },
    { separator: true },
    { label: "close", run: () => closeTab(t.id) },
    { label: "close other tabs", run: () => closeOtherTabs(t.id) },
  ];
}

export function paneMenu(paneId: Id): MenuItem[] {
  return [
    { label: "split right", run: () => splitPaneById(paneId, "horizontal") },
    { label: "split down", run: () => splitPaneById(paneId, "vertical") },
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
