import { moduleCommands } from "./commands";
import { stepZoom, type Appearance } from "./appearance";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { rpc, RpcFailure } from "./api";
import { orderedStates } from "./homeQuery";
import { activeTab, agentsOf, clearSelection, getState, needsMe, notify, paneIds, setRowError, setState, setUi } from "./store";
import { focusTerminal, neighbor } from "./terminals";
import type { ActionRunResult, AgentKind, CheckpointMode, Id, SidebarSort, SplitDirection, Tab, UsageSnapshot, Worktree } from "./types";

const byId = (id: Id) => getState().worktrees.find((w) => w.id === id) ?? null;

export type CommandGroup = "Navigation" | "Worktrees" | "Tabs" | "Panes" | "Agents" | "Browser" | "General";

export interface Action {
  id: string;
  label: string;
  run: () => void | Promise<void>;
  whenWorktree?: boolean;
  when?: () => boolean;
  /** Section in the keyboard shortcut reference and the palette. */
  group?: CommandGroup;
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
          destructive: true,
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
          destructive: true,
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
  const item = needsMe(s)[0];
  if (!item) return;
  if (item.pane_id && s.panes[item.pane_id]) {
    await openWorktree(item.worktree_id);
    await focusPane(item.pane_id);
  } else {
    await openWorktree(item.worktree_id);
  }
  await rpc("attention_view", { id: item.id }).catch(() => {});
}

export interface SpawnOptions {
  /** Resume this agent session id instead of a fresh one. */
  resume?: string;
  /** Open the agent in its own tab instead of a split of the focused pane. */
  newTab?: boolean;
}

export async function spawnAgent(kind: AgentKind, worktreeId?: Id, opts: SpawnOptions = {}): Promise<void> {
  const w = worktreeId ? byId(worktreeId) : currentWorktree();
  if (!w) {
    notify("info", "Open a worktree first");
    return;
  }
  const from = !opts.newTab && w.id === currentWorktree()?.id ? focusedPaneId() : null;
  try {
    const r = await rpc<{ pane: { id: Id } }>("agent_spawn", { kind, worktree_id: w.id, cwd: null, tab_id: null, split_from: from, resume: opts.resume ?? null, new_tab: !!opts.newTab, extra_args: [] });
    if (w.id !== getState().ui.activeWorktreeId) await openWorktree(w.id);
    window.setTimeout(() => focusPane(r.pane.id), 80);
  } catch (e) {
    notify("error", (e as Error).message);
  }
}

export async function newTerminalIn(worktreeId: Id): Promise<void> {
  try {
    const r = await rpc<{ pane: { id: Id } }>("pane_create", { worktree_id: worktreeId, tab_id: null, cwd: null, command: null, title: null });
    await openWorktree(worktreeId);
    window.setTimeout(() => focusPane(r.pane.id), 80);
  } catch (e) {
    notify("error", (e as Error).message);
  }
}

export async function newTabIn(worktreeId: Id): Promise<void> {
  try {
    const tab = await rpc<Tab>("tab_create", { worktree_id: worktreeId, title: null });
    await openWorktree(worktreeId);
    if (tab.active_pane_id) window.setTimeout(() => focusPane(tab.active_pane_id!), 80);
  } catch (e) {
    notify("error", (e as Error).message);
  }
}

export async function openBrowser(worktreeId: Id, url: string | null = null): Promise<Id | null> {
  try {
    const r = await rpc<{ pane: { id: Id } }>("browser_open", { worktree_id: worktreeId, url, tab_id: null });
    if (worktreeId !== getState().ui.activeWorktreeId) await openWorktree(worktreeId);
    window.setTimeout(() => focusPane(r.pane.id), 80);
    return r.pane.id;
  } catch (e) {
    notify("error", (e as Error).message);
    return null;
  }
}

/** Shows a page in the worktree's live browser pane, or opens one. */
export async function openInBrowser(worktreeId: Id, url: string): Promise<void> {
  const live = Object.values(getState().panes).find((p) => p.worktree_id === worktreeId && p.kind === "browser" && p.live);
  if (!live) {
    await openBrowser(worktreeId, url);
    return;
  }
  try {
    await rpc("browser_navigate", { pane_id: live.id, url });
    if (worktreeId !== getState().ui.activeWorktreeId) await openWorktree(worktreeId);
    focusPane(live.id);
  } catch (e) {
    notify("error", (e as Error).message);
  }
}

export function browserCommand(paneId: Id, command: "browser_back" | "browser_forward" | "browser_reload"): void {
  invoke(command, { paneId }).catch((e) => notify("error", String(e)));
}

export function openExternalUrl(url: string): void {
  openUrl(url).catch((e) => notify("error", String(e)));
}

export function closeOtherTabs(tabId: Id): void {
  const s = getState();
  const tab = Object.values(s.tabs).flat().find((t) => t.id === tabId);
  if (!tab) return;
  for (const t of s.tabs[tab.worktree_id] ?? []) if (t.id !== tabId) closeTab(t.id);
}

const ARCHIVE_BODY = "tomo commits a checkpoint of uncommitted changes to the branch, closes panes, removes build directories, and removes the worktree. The branch stays.";
const DISCARD_LABEL = "discard uncommitted changes";
const checkpointMode = (discard: boolean): CheckpointMode => (discard ? "discard" : "checkpoint");

const failOn = (worktreeId: Id, op: string) => (e: unknown) => {
  const message = (e as Error).message;
  setRowError(worktreeId, { op, message });
  notify("error", `${op} failed: ${message}`);
};
const clearRowError = (worktreeId: Id) => () => setRowError(worktreeId, null);

export function archiveWorktree(worktreeId: Id): void {
  const w = byId(worktreeId);
  if (!w) return;
  setState({
    dialog: {
      kind: "confirm",
      title: `Archive ${w.name}?`,
      body: ARCHIVE_BODY,
      confirmLabel: "Archive",
      check: DISCARD_LABEL,
      onConfirm: (discard) => {
        if (getState().ui.activeWorktreeId === worktreeId) setUi({ view: "home" });
        rpc("worktree_archive", { worktree_id: worktreeId, checkpoint: checkpointMode(discard) }).then(clearRowError(worktreeId), failOn(worktreeId, "archive"));
      },
    },
  });
}

export function runWorktreeAction(worktreeId: Id, actionId: string): void {
  rpc<ActionRunResult>("action_run", { worktree_id: worktreeId, action_id: actionId }).then(clearRowError(worktreeId), failOn(worktreeId, actionId));
}

export function stopWorktreeAction(worktreeId: Id, actionId: string): void {
  rpc("action_stop", { worktree_id: worktreeId, action_id: actionId }).then(clearRowError(worktreeId), failOn(worktreeId, `stop ${actionId}`));
}

export function restartWorktreeAction(worktreeId: Id, actionId: string): void {
  rpc<ActionRunResult>("action_restart", { worktree_id: worktreeId, action_id: actionId }).then(clearRowError(worktreeId), failOn(worktreeId, `restart ${actionId}`));
}

/** Opens a runtime endpoint in the worktree's browser surface, or externally when no worktree is known. */
export function openEndpoint(url: string, worktreeId?: Id): void {
  if (worktreeId) void openInBrowser(worktreeId, url);
  else openUrl(url).catch((e) => notify("error", (e as Error).message));
}

export function resolveCheckpoint(id: Id): void {
  rpc("checkpoint_resolve", { id })
    .then(() => setState((s) => ({ attention: s.attention.filter((a) => a.id !== id) })))
    .catch(() => {});
}

export function refreshUsage(): void {
  rpc<UsageSnapshot[]>("usage_get", { refresh: true })
    .then((list) => Array.isArray(list) && setState({ usage: list }))
    .catch(() => {});
}

export function restoreWorktree(worktreeId: Id): void {
  rpc<Worktree>("worktree_restore", { worktree_id: worktreeId })
    .then((w) => {
      setRowError(worktreeId, null);
      openWorktree(w.id);
    }, failOn(worktreeId, "restore"));
}

export async function bulkMetadata(ids: Id[], patch: Record<string, unknown>): Promise<void> {
  await Promise.allSettled(ids.map((id) => setMetadata(id, patch)));
}

export function setWorktreeState(worktreeId: Id, state: string | null): Promise<void> {
  return setMetadata(worktreeId, { state });
}

function tabOfPane(paneId: Id): Tab | null {
  const s = getState();
  const pane = s.panes[paneId];
  return pane ? Object.values(s.tabs).flat().find((t) => t.id === pane.tab_id) ?? null : null;
}

export function toggleZoom(paneId?: Id): void {
  const id = paneId ?? focusedPaneId();
  const tab = id ? tabOfPane(id) : null;
  if (!id || !tab) return;
  rpc("pane_zoom", { pane_id: id, tab_id: tab.id }).catch((e) => notify("error", (e as Error).message));
}

export function equalizeTab(tabId: Id): void {
  rpc("layout_equalize", { tab_id: tabId }).catch((e) => notify("error", (e as Error).message));
}

export function rotateSplit(tabId: Id): void {
  rpc("layout_rotate", { tab_id: tabId, split_id: null }).catch((e) => notify("error", (e as Error).message));
}

export function swapPanes(a: Id, b: Id): void {
  rpc("pane_swap", { pane_a: a, pane_b: b }).catch((e) => notify("error", (e as Error).message));
}

export function bulkAddTag(ids: Id[]): void {
  setState({
    dialog: {
      kind: "prompt",
      title: `Add tag to ${ids.length} worktrees`,
      initial: "",
      placeholder: "tag",
      onSubmit: async (value) => {
        const tag = value.trim().replace(/^#/, "");
        if (!tag) return;
        for (const id of ids) {
          const w = byId(id);
          if (w && !w.metadata.tags.includes(tag)) await setMetadata(id, { tags: [...w.metadata.tags, tag] });
        }
      },
    },
  });
}

export function bulkPrompt(field: "project" | "tags", ids: Id[]): void {
  const title = field === "project" ? `Project for ${ids.length} worktrees` : `Tags for ${ids.length} worktrees (replaces)`;
  setState({
    dialog: {
      kind: "prompt",
      title,
      initial: "",
      onSubmit: (value) => {
        const trimmed = value.trim();
        const patch = field === "tags" ? { tags: trimmed ? trimmed.split(",").map((t) => t.trim()).filter(Boolean) : [] } : { project: trimmed || null };
        bulkMetadata(ids, patch);
      },
    },
  });
}

export function bulkArchive(ids: Id[]): void {
  const targets = ids.map(byId).filter((w): w is Worktree => !!w && !w.is_main && !w.archived_at_ms && w.exists);
  const skipped = ids.length - targets.length;
  if (!targets.length) {
    notify("info", "Nothing to archive in the selection");
    return;
  }
  setState({
    dialog: {
      kind: "confirm",
      title: `Archive ${targets.length} worktrees?`,
      body: `${targets.map((w) => w.name).join(", ")}. ${ARCHIVE_BODY}${skipped ? ` ${skipped} skipped (main or already archived).` : ""}`,
      confirmLabel: "Archive all",
      check: DISCARD_LABEL,
      onConfirm: async (discard) => {
        if (targets.some((w) => w.id === getState().ui.activeWorktreeId)) setUi({ view: "home" });
        const results = await Promise.allSettled(targets.map((w) => rpc("worktree_archive", { worktree_id: w.id, checkpoint: checkpointMode(discard) })));
        results.forEach((r, i) => setRowError(targets[i].id, r.status === "rejected" ? { op: "archive", message: (r.reason as Error).message } : null));
        const ok = results.filter((r) => r.status === "fulfilled").length;
        clearSelection();
        notify("info", `Archived ${ok} of ${targets.length}${skipped ? `, skipped ${skipped}` : ""}`);
      },
    },
  });
}

export async function bulkRestore(ids: Id[]): Promise<void> {
  const targets = ids.map(byId).filter((w): w is Worktree => !!w && !!w.archived_at_ms);
  const results = await Promise.allSettled(targets.map((w) => rpc("worktree_restore", { worktree_id: w.id })));
  results.forEach((r, i) => {
    setRowError(targets[i].id, r.status === "rejected" ? { op: "restore", message: (r.reason as Error).message } : null);
    if (r.status === "rejected") notify("error", `${targets[i].name}: ${(r.reason as Error).message}`);
  });
  clearSelection();
}

export function toggleRepoCollapsed(repoId: Id): void {
  const list = getState().ui.collapsedRepos;
  setUi({ collapsedRepos: list.includes(repoId) ? list.filter((r) => r !== repoId) : [...list, repoId] });
}

export function setAllReposCollapsed(collapsed: boolean): void {
  setUi({ collapsedRepos: collapsed ? getState().repos.map((r) => r.id) : [] });
}

export function setRepoHidden(repoId: Id, hidden: boolean): void {
  const list = getState().ui.hiddenRepos.filter((r) => r !== repoId);
  setUi({ hiddenRepos: hidden ? [...list, repoId] : list });
}

export function removeRepo(repoId: Id): void {
  const repo = getState().repos.find((r) => r.id === repoId);
  if (!repo) return;
  setState({
    dialog: {
      kind: "confirm",
      title: `Remove ${repo.name} from Tomo?`,
      body: "Tomo forgets the repository. Nothing on disk changes; worktrees with open terminals stay listed until you close them.",
      confirmLabel: "Remove",
          destructive: true,
      onConfirm: () => rpc("repo_remove", { repo_id: repoId }).catch((e) => notify("error", (e as Error).message)),
    },
  });
}

export function copyText(text: string, what = "Path"): void {
  navigator.clipboard.writeText(text).catch(() => notify("error", `Could not copy the ${what.toLowerCase()}: clipboard unavailable`));
}

export function openExternalFor(worktreeId: Id, target: "finder" | "editor", relPath = ""): void {
  rpc("open_external", { worktree_id: worktreeId, rel_path: relPath, target }).catch((e) => notify("error", (e as Error).message));
}

export function renamePane(paneId: Id): void {
  const pane = getState().panes[paneId];
  if (!pane) return;
  setState({
    dialog: {
      kind: "prompt",
      title: "Rename pane",
      initial: pane.user_title ?? "",
      placeholder: pane.title,
      onSubmit: (value) => rpc("pane_rename", { pane_id: paneId, title: value.trim() || null }).catch((e) => notify("error", (e as Error).message)),
    },
  });
}

export function killPaneTree(paneId: Id): void {
  rpc("pane_kill_tree", { pane_id: paneId }).catch((e) => notify("error", (e as Error).message));
}

export function splitPaneById(paneId: Id, direction: SplitDirection): void {
  rpc<{ pane: { id: Id } }>("pane_split", { pane_id: paneId, direction, command: null })
    .then((r) => window.setTimeout(() => focusPane(r.pane.id), 50))
    .catch((e) => notify("error", (e as Error).message));
}

export async function setMetadata(worktreeId: Id, patch: Record<string, unknown>): Promise<void> {
  try {
    await rpc("metadata_set", { worktree_id: worktreeId, patch });
  } catch (e) {
    notify("error", (e as Error).message);
  }
}

export function promptMetadata(field: "display_name" | "project" | "tags", worktreeId?: Id): void {
  const w = worktreeId ? byId(worktreeId) : currentWorktree();
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
  { id: "towns", label: "Open Japan map", run: () => setUi({ view: "towns" }) },
  { id: "activity", label: "Activity", run: () => setUi({ view: "activity" }) },
  { id: "palette", label: "Command palette", run: () => setState((s) => ({ paletteOpen: !s.paletteOpen })) },
  { id: "zoom_in", label: "Zoom in", run: () => applyZoom("in") },
  { id: "zoom_out", label: "Zoom out", run: () => applyZoom("out") },
  { id: "zoom_reset", label: "Reset zoom", run: () => applyZoom("reset") },
  { id: "next_attention", label: "Jump to next attention item", run: nextAttention },
  { id: "prev_worktree", label: "Previous worktree", run: () => cycleWorktree(-1) },
  { id: "next_worktree", label: "Next worktree", run: () => cycleWorktree(1) },
  { id: "new_terminal", label: "New terminal (split right)", run: () => splitPane("horizontal"), whenWorktree: true },
  { id: "split_vertical", label: "New terminal (split down)", run: () => splitPane("vertical"), whenWorktree: true },
  { id: "new_tab", label: "New tab", run: newTab, whenWorktree: true },
  { id: "close_pane", label: "Close pane", run: () => closePane(), whenWorktree: true },
  { id: "zoom_pane", label: "Zoom pane (toggle)", run: () => toggleZoom(), whenWorktree: true },
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
  { id: "integrations", label: "Integration status…", run: () => setState({ dialog: { kind: "integrations" } }) },
  { id: "config_check", label: "Check config…", run: () => setState({ dialog: { kind: "config-check" } }) },
  { id: "hook_log", label: "Hook log…", run: () => setState({ dialog: { kind: "hook-log" } }) },
  { id: "set_display_name", label: "Set worktree display name…", run: () => promptMetadata("display_name"), whenWorktree: true },
  { id: "set_project", label: "Set worktree project…", run: () => promptMetadata("project"), whenWorktree: true },
  { id: "set_tags", label: "Set worktree tags…", run: () => promptMetadata("tags"), whenWorktree: true },
  { id: "open_editor", label: "Open worktree in editor", run: () => openExternal("editor"), whenWorktree: true },
  { id: "reveal_finder", label: "Reveal worktree in Finder", run: () => openExternal("finder"), whenWorktree: true },
  { id: "copy_path", label: "Copy worktree path", run: () => copyText(currentWorktree()?.path ?? ""), whenWorktree: true },
  { id: "clear_attention", label: "Clear all attention items", run: () => rpc("attention_clear").then(() => undefined) },
  { id: "archive_worktree", label: "Archive worktree…", run: () => archiveWorktree(currentWorktree()!.id), whenWorktree: true },
  { id: "restore_worktree", label: "Restore worktree", run: () => restoreWorktree(currentWorktree()!.id), whenWorktree: true, when: () => !!currentWorktree()?.archived_at_ms },
  { id: "close_tab", label: "Close tab", run: () => { const t = activeTab(getState(), getState().ui.activeWorktreeId); if (t) closeTab(t.id); }, whenWorktree: true },
  { id: "kill_pane_tree", label: "Kill process tree in pane", run: () => { const p = focusedPaneId(); if (p) killPaneTree(p); }, whenWorktree: true },
  { id: "refresh_git", label: "Refresh git status", run: () => rpc("git_summary", { worktree_id: currentWorktree()!.id }).then(() => undefined), whenWorktree: true },
  { id: "new_worktree_here", label: "New worktree in this repo…", run: () => setState({ dialog: { kind: "create-worktree", repoId: currentWorktree()!.repo_id } }), whenWorktree: true },
  { id: "hide_repo", label: "Hide this repo from the sidebar", run: () => setRepoHidden(currentWorktree()!.repo_id, true), whenWorktree: true, when: () => !getState().ui.hiddenRepos.includes(currentWorktree()?.repo_id ?? "") },
  { id: "unhide_repo", label: "Unhide this repo", run: () => setRepoHidden(currentWorktree()!.repo_id, false), whenWorktree: true, when: () => getState().ui.hiddenRepos.includes(currentWorktree()?.repo_id ?? "") },
  { id: "toggle_board", label: "Home: toggle board / list", run: () => setUi({ home: { ...getState().ui.home, view: getState().ui.home.view === "board" ? "list" : "board" }, view: "home" }) },
  { id: "show_archived", label: "Show archived worktrees", run: () => setUi({ showArchivedInSidebar: true, home: { ...getState().ui.home, showArchived: true } }) },
  { id: "hide_archived", label: "Hide archived worktrees", run: () => setUi({ showArchivedInSidebar: false, home: { ...getState().ui.home, showArchived: false } }) },
  { id: "collapse_repos", label: "Collapse all repos", run: () => setAllReposCollapsed(true) },
  { id: "expand_repos", label: "Expand all repos", run: () => setAllReposCollapsed(false) },
  { id: "clear_selection", label: "Clear selection", run: clearSelection, when: () => getState().selection.size > 0 },
  ...(["name", "recent", "created", "attention", "state", "manual"] as SidebarSort[]).map((sort) => ({ id: `sort_${sort}`, label: `Sort sidebar by ${sort}`, run: () => setUi({ sidebarSort: sort }) })),
];

export function setAppearance(patch: Partial<Appearance>): void {
  setUi({ appearance: { ...getState().ui.appearance, ...patch } });
}

export function applyZoom(dir: "in" | "out" | "reset"): void {
  setAppearance({ zoom: stepZoom(getState().ui.appearance.zoom, dir) });
}

export function stateActions(): Action[] {
  const current = currentWorktree();
  const states = orderedStates(getState().config?.states ?? []);
  return [
    ...states.map((s) => ({ id: `state_${s.id}`, label: `state ${s.label}`, group: "Worktrees" as const, run: () => setWorktreeState(currentWorktree()!.id, s.id), whenWorktree: true, when: () => current?.metadata.state !== s.id })),
    { id: "state_clear", label: "state clear", group: "Worktrees", run: () => setWorktreeState(currentWorktree()!.id, null), whenWorktree: true, when: () => !!current?.metadata.state },
  ];
}

const COMMAND_GROUPS: Record<string, CommandGroup> = {
  home: "Navigation",
  towns: "Navigation",
  activity: "Navigation",
  prev_worktree: "Navigation",
  next_worktree: "Navigation",
  toggle_left_sidebar: "Navigation",
  toggle_right_sidebar: "Navigation",
  toggle_board: "Navigation",
  palette: "General",
  appearance: "General",
  zoom_in: "General",
  zoom_out: "General",
  zoom_reset: "General",
  theme_system: "General",
  theme_light: "General",
  theme_dark: "General",
  config_check: "General",
  hook_log: "General",
  new_tab: "Tabs",
  rename_tab: "Tabs",
  next_tab: "Tabs",
  prev_tab: "Tabs",
  close_tab: "Tabs",
  new_terminal: "Panes",
  split_vertical: "Panes",
  close_pane: "Panes",
  zoom_pane: "Panes",
  focus_left: "Panes",
  focus_right: "Panes",
  focus_up: "Panes",
  focus_down: "Panes",
  kill_pane_tree: "Panes",
  next_attention: "Agents",
  spawn_claude: "Agents",
  spawn_codex: "Agents",
  spawn_pi: "Agents",
  integrations: "Agents",
  clear_attention: "Agents",
  add_repo: "Worktrees",
  create_worktree: "Worktrees",
  refresh: "Worktrees",
  set_display_name: "Worktrees",
  set_project: "Worktrees",
  set_tags: "Worktrees",
  open_editor: "Worktrees",
  reveal_finder: "Worktrees",
  copy_path: "Worktrees",
  archive_worktree: "Worktrees",
  restore_worktree: "Worktrees",
  refresh_git: "Worktrees",
  new_worktree_here: "Worktrees",
  hide_repo: "Worktrees",
  unhide_repo: "Worktrees",
  show_archived: "Worktrees",
  hide_archived: "Worktrees",
  collapse_repos: "Worktrees",
  expand_repos: "Worktrees",
  clear_selection: "Worktrees",
  sort_name: "Worktrees",
  sort_recent: "Worktrees",
  sort_created: "Worktrees",
  sort_attention: "Worktrees",
  sort_state: "Worktrees",
  sort_manual: "Worktrees",
};

export function allActions(): Action[] {
  return [...actions, ...stateActions(), ...moduleCommands()].map((a) => (a.group ? a : { ...a, group: COMMAND_GROUPS[a.id] }));
}

export function runAction(id: string): void {
  if (id.startsWith("action:")) {
    const w = currentWorktree();
    if (w) runWorktreeAction(w.id, id.slice("action:".length));
    return;
  }
  const a = allActions().find((x) => x.id === id);
  if (!a) return;
  if (a.whenWorktree && !currentWorktree()) {
    notify("info", "Open a worktree first");
    return;
  }
  if (a.when && !a.when()) return;
  Promise.resolve(a.run()).catch((e) => notify("error", (e as Error).message));
}

export function worktreeAgentSummary(worktreeId: Id): string {
  return agentsOf(getState(), worktreeId)
    .map((a) => `${a.kind} ${a.state}`)
    .join(", ");
}
