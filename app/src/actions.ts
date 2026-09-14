import { rpc, RpcFailure } from "./api";
import { activeTab, agentsOf, getState, notify, paneIds, setState, setUi, unviewedAttention } from "./store";
import { focusTerminal, neighbor } from "./terminals";
import type { AgentKind, Id, SplitDirection, Tab, Worktree } from "./types";

export interface Action {
  id: string;
  label: string;
  run: () => void | Promise<void>;
  whenWorktree?: boolean;
}

export async function openWorktree(worktreeId: Id): Promise<void> {
  setUi({ view: "worktree", activeWorktreeId: worktreeId });
  try {
    const r = await rpc<{ tabs: Tab[] }>("worktree_open", { worktree_id: worktreeId });
    const tab = r.tabs.find((t) => t.is_active) ?? r.tabs[0];
    if (tab?.active_pane_id) window.setTimeout(() => focusTerminal(tab.active_pane_id!), 50);
  } catch (e) {
    notify("error", (e as Error).message);
  }
}

export function currentWorktree(): Worktree | null {
  const s = getState();
  return s.worktrees.find((w) => w.id === s.ui.activeWorktreeId) ?? null;
}

export function focusedPaneId(): Id | null {
  const s = getState();
  if (s.ui.view !== "worktree") return null;
  return activeTab(s, s.ui.activeWorktreeId)?.active_pane_id ?? null;
}

export async function focusPane(paneId: Id): Promise<void> {
  focusTerminal(paneId);
  await rpc("pane_focus", { pane_id: paneId }).catch(() => {});
}

export async function splitPane(direction: SplitDirection): Promise<void> {
  const w = currentWorktree();
  if (!w) return;
  const pane = focusedPaneId();
  try {
    const r = pane
      ? await rpc<{ pane: { id: Id } }>("pane_split", { pane_id: pane, direction, command: null })
      : await rpc<{ pane: { id: Id } }>("pane_create", { worktree_id: w.id, tab_id: null, cwd: null, command: null, title: null });
    window.setTimeout(() => focusPane(r.pane.id), 50);
  } catch (e) {
    notify("error", (e as Error).message);
  }
}

export async function newTab(): Promise<void> {
  const w = currentWorktree();
  if (!w) return;
  try {
    const tab = await rpc<Tab>("tab_create", { worktree_id: w.id, title: null });
    if (tab.active_pane_id) window.setTimeout(() => focusPane(tab.active_pane_id!), 50);
  } catch (e) {
    notify("error", (e as Error).message);
  }
}

export async function closePane(paneId?: Id): Promise<void> {
  const id = paneId ?? focusedPaneId();
  if (!id) return;
  try {
    await rpc("pane_close", { pane_id: id, force: false });
  } catch (e) {
    if (e instanceof RpcFailure && e.code === "conflict") {
      setState({
        dialog: {
          kind: "confirm",
          title: "Close pane?",
          body: "Processes are still running in this pane. Closing it sends a hangup to the shell and its jobs.",
          confirmLabel: "Close pane",
          onConfirm: () => rpc("pane_close", { pane_id: id, force: true }).catch((err) => notify("error", (err as Error).message)),
        },
      });
    } else notify("error", (e as Error).message);
  }
}

export async function closeTab(tabId: Id): Promise<void> {
  try {
    await rpc("tab_close", { tab_id: tabId, force: false });
  } catch (e) {
    if (e instanceof RpcFailure && e.code === "conflict") {
      setState({
        dialog: {
          kind: "confirm",
          title: "Close tab?",
          body: "Processes are still running in this tab. Closing it sends a hangup to every shell in it.",
          confirmLabel: "Close tab",
          onConfirm: () => rpc("tab_close", { tab_id: tabId, force: true }).catch((err) => notify("error", (err as Error).message)),
        },
      });
    } else notify("error", (e as Error).message);
  }
}

export function activateTab(tabId: Id): void {
  const s = getState();
  const tab = Object.values(s.tabs).flat().find((t) => t.id === tabId);
  rpc("tab_activate", { tab_id: tabId }).catch(() => {});
  if (tab?.active_pane_id) window.setTimeout(() => focusTerminal(tab.active_pane_id!), 30);
}

export function cycleTab(delta: number): void {
  const s = getState();
  const tabs = s.tabs[s.ui.activeWorktreeId ?? ""] ?? [];
  if (tabs.length < 2) return;
  const idx = Math.max(0, tabs.findIndex((t) => t.is_active));
  activateTab(tabs[(idx + delta + tabs.length) % tabs.length].id);
}

export function cycleWorktree(delta: number): void {
  const s = getState();
  if (!s.worktrees.length) return;
  const idx = s.worktrees.findIndex((w) => w.id === s.ui.activeWorktreeId);
  const next = s.worktrees[(idx + delta + s.worktrees.length) % s.worktrees.length];
  openWorktree(next.id);
}

export function focusDirection(dir: "left" | "right" | "up" | "down"): void {
  const s = getState();
  const tab = activeTab(s, s.ui.activeWorktreeId);
  const from = tab?.active_pane_id;
  if (!tab || !from) return;
  const target = neighbor(from, paneIds(tab.layout), dir);
  if (target) focusPane(target);
}

export async function nextAttention(): Promise<void> {
  const s = getState();
  const item = unviewedAttention(s)[0];
  if (!item) {
    notify("info", "Nothing needs attention");
    return;
  }
  if (item.pane_id && s.panes[item.pane_id]) {
    await openWorktree(item.worktree_id);
    await focusPane(item.pane_id);
  } else {
    await openWorktree(item.worktree_id);
  }
  await rpc("attention_view", { id: item.id }).catch(() => {});
}

export async function spawnAgent(kind: AgentKind): Promise<void> {
  const w = currentWorktree();
  if (!w) {
    notify("info", "Open a worktree first");
    return;
  }
  const from = focusedPaneId();
  try {
    const r = await rpc<{ pane: { id: Id } }>("agent_spawn", { kind, worktree_id: w.id, cwd: null, tab_id: null, split_from: from, resume: null, extra_args: [] });
    window.setTimeout(() => focusPane(r.pane.id), 80);
  } catch (e) {
    notify("error", (e as Error).message);
  }
}

export async function setMetadata(worktreeId: Id, patch: Record<string, unknown>): Promise<void> {
  try {
    await rpc("metadata_set", { worktree_id: worktreeId, patch });
  } catch (e) {
    notify("error", (e as Error).message);
  }
}

export function promptMetadata(field: "display_name" | "project" | "tags"): void {
  const w = currentWorktree();
  if (!w) return;
  const labels = { display_name: "Display name", project: "Project", tags: "Tags (comma-separated)" };
  const initial = field === "tags" ? w.metadata.tags.join(", ") : (w.metadata[field] ?? "");
  setState({
    dialog: {
      kind: "prompt",
      title: labels[field],
      initial,
      onSubmit: (value) => {
        const trimmed = value.trim();
        const patch = field === "tags" ? { tags: trimmed ? trimmed.split(",").map((t) => t.trim()).filter(Boolean) : [] } : { [field]: trimmed || null };
        setMetadata(w.id, patch);
      },
    },
  });
}

export function renameCurrentTab(): void {
  const s = getState();
  const tab = activeTab(s, s.ui.activeWorktreeId);
  if (!tab) return;
  setState({
    dialog: {
      kind: "prompt",
      title: "Rename tab",
      initial: tab.title,
      onSubmit: (value) => {
        if (value.trim()) rpc("tab_rename", { tab_id: tab.id, title: value.trim() }).catch((e) => notify("error", (e as Error).message));
      },
    },
  });
}

export function openExternal(target: "finder" | "editor", relPath = ""): void {
  const w = currentWorktree();
  if (!w) return;
  rpc("open_external", { worktree_id: w.id, rel_path: relPath, target }).catch((e) => notify("error", (e as Error).message));
}

export const actions: Action[] = [
  { id: "home", label: "Go to Home", run: () => setUi({ view: "home" }) },
  { id: "palette", label: "Command palette", run: () => setState((s) => ({ paletteOpen: !s.paletteOpen })) },
  { id: "next_attention", label: "Jump to next attention item", run: nextAttention },
  { id: "prev_worktree", label: "Previous worktree", run: () => cycleWorktree(-1) },
  { id: "next_worktree", label: "Next worktree", run: () => cycleWorktree(1) },
  { id: "new_terminal", label: "New terminal (split right)", run: () => splitPane("horizontal"), whenWorktree: true },
  { id: "split_vertical", label: "New terminal (split down)", run: () => splitPane("vertical"), whenWorktree: true },
  { id: "new_tab", label: "New tab", run: newTab, whenWorktree: true },
  { id: "close_pane", label: "Close pane", run: () => closePane(), whenWorktree: true },
  { id: "rename_tab", label: "Rename tab", run: renameCurrentTab, whenWorktree: true },
  { id: "next_tab", label: "Next tab", run: () => cycleTab(1), whenWorktree: true },
  { id: "prev_tab", label: "Previous tab", run: () => cycleTab(-1), whenWorktree: true },
  { id: "focus_left", label: "Focus pane left", run: () => focusDirection("left"), whenWorktree: true },
  { id: "focus_right", label: "Focus pane right", run: () => focusDirection("right"), whenWorktree: true },
  { id: "focus_up", label: "Focus pane up", run: () => focusDirection("up"), whenWorktree: true },
  { id: "focus_down", label: "Focus pane down", run: () => focusDirection("down"), whenWorktree: true },
  { id: "toggle_left_sidebar", label: "Toggle left sidebar", run: () => setUi({ leftOpen: !getState().ui.leftOpen }) },
  { id: "toggle_right_sidebar", label: "Toggle right sidebar", run: () => setUi({ rightOpen: !getState().ui.rightOpen }) },
  { id: "spawn_claude", label: "Start Claude here", run: () => spawnAgent("claude"), whenWorktree: true },
  { id: "spawn_codex", label: "Start Codex here", run: () => spawnAgent("codex"), whenWorktree: true },
  { id: "spawn_pi", label: "Start Pi here", run: () => spawnAgent("pi"), whenWorktree: true },
  { id: "add_repo", label: "Add repository…", run: () => setState({ dialog: { kind: "add-repo" } }) },
  { id: "create_worktree", label: "Create worktree…", run: () => setState({ dialog: { kind: "create-worktree", repoId: currentWorktree()?.repo_id } }) },
  { id: "refresh", label: "Refresh repositories and worktrees", run: () => rpc("worktree_refresh").then(() => undefined) },
  { id: "set_priority_1", label: "Set worktree priority: P1", run: () => setMetadata(currentWorktree()!.id, { priority: 1 }), whenWorktree: true },
  { id: "set_priority_2", label: "Set worktree priority: P2", run: () => setMetadata(currentWorktree()!.id, { priority: 2 }), whenWorktree: true },
  { id: "set_priority_3", label: "Set worktree priority: P3", run: () => setMetadata(currentWorktree()!.id, { priority: 3 }), whenWorktree: true },
  { id: "set_priority_4", label: "Set worktree priority: P4", run: () => setMetadata(currentWorktree()!.id, { priority: 4 }), whenWorktree: true },
  { id: "clear_priority", label: "Clear worktree priority", run: () => setMetadata(currentWorktree()!.id, { priority: null }), whenWorktree: true },
  { id: "set_display_name", label: "Set worktree display name…", run: () => promptMetadata("display_name"), whenWorktree: true },
  { id: "set_project", label: "Set worktree project…", run: () => promptMetadata("project"), whenWorktree: true },
  { id: "set_tags", label: "Set worktree tags…", run: () => promptMetadata("tags"), whenWorktree: true },
  { id: "open_editor", label: "Open worktree in editor", run: () => openExternal("editor"), whenWorktree: true },
  { id: "reveal_finder", label: "Reveal worktree in Finder", run: () => openExternal("finder"), whenWorktree: true },
  { id: "copy_path", label: "Copy worktree path", run: () => navigator.clipboard.writeText(currentWorktree()?.path ?? "").then(() => notify("info", "Path copied")), whenWorktree: true },
  { id: "clear_attention", label: "Clear all attention items", run: () => rpc("attention_clear").then(() => undefined) },
];

export function runAction(id: string): void {
  const a = actions.find((x) => x.id === id);
  if (!a) return;
  if (a.whenWorktree && !currentWorktree()) {
    notify("info", "Open a worktree first");
    return;
  }
  Promise.resolve(a.run()).catch((e) => notify("error", (e as Error).message));
}

export function worktreeAgentSummary(worktreeId: Id): string {
  return agentsOf(getState(), worktreeId)
    .map((a) => `${a.kind} ${a.state}`)
    .join(", ");
}
