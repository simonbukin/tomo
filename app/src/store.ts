import { useRef, useSyncExternalStore } from "react";
import { z } from "zod";
import { rpc, rpcParsed } from "./api";
import { configIssueSchema } from "./schemas";
import { mergeActivity, needsMeItems } from "./activityModel";
import { announceAttention } from "./attention";
import { attentionToastKey } from "./notifyRoute";
import { addonViews, builtins, inspectorSections } from "./addons";
import { defaultUi, sanitizeUi } from "./uiState";
import type { Diagnostic, DiagnosticLevel,
  ActivityEvent,
  AgentPresence,
  AttentionItem,
  Config,
  Frame,
  Id,
  Pane,
  Repo,
  Snapshot,
  Status,
  SystemStats,
  Tab,
  UiState,
  Worktree,
  WorktreeResources,
} from "./types";
import type { MenuAnchor, MenuItem } from "./components/ui";
import type { QueryContext } from "./homeQuery";

export interface State {
  connected: boolean;
  loaded: boolean;
  config: Config | null;
  repos: Repo[];
  worktrees: Worktree[];
  tabs: Record<Id, Tab[]>;
  panes: Record<Id, Pane>;
  agents: Record<Id, AgentPresence>;
  attention: AttentionItem[];
  resources: Record<Id, WorktreeResources>;
  activity: ActivityEvent[];
  ui: UiState;
  focusRequest: { worktree_id: Id; tab_id: Id; pane_id: Id; nonce: number } | null;
  /** One short confirmation in the bottom strip. A new one replaces it. */
  statusMessage: { text: string; nonce: number } | null;
  toasts: Toast[];
  toastSeq: number;
  /** Client-side and daemon diagnostics, oldest first. */
  diagnostics: Diagnostic[];
  daemonHealth: DaemonHealth;
  /** The daemon status from the last `subscribe`. */
  daemonStatus: Status | null;
  /** The last `system_stats` sample. */
  system: SystemStats | null;
  paletteOpen: boolean;
  shortcutsOpen: boolean;
  dialog: Dialog | null;
  connectionNonce: number;
  menu: { anchor: MenuAnchor; items: MenuItem[]; nonce: number } | null;
  selection: Set<Id>;
  selectionAnchor: Id | null;
  zoomed: Record<Id, Id>;
  healthChecked: boolean;
  rowErrors: Record<Id, RowError>;
}

export type RowError = { op: string; message: string };

export type Dialog =
  | { kind: "add-repo" }
  | { kind: "create-worktree"; repoId?: Id }
  | { kind: "confirm"; title: string; body: string; confirmLabel: string; destructive?: boolean; check?: string; onConfirm: (checked: boolean) => void }
  | { kind: "prompt"; title: string; initial: string; placeholder?: string; onSubmit: (value: string) => void }
  | { kind: "integrations" }
  | { kind: "config-check" }
  | { kind: "hook-log" }
  | { kind: "diagnostics" };

export { defaultHome } from "./uiState";

let state: State = {
  connected: false,
  loaded: false,
  config: null,
  repos: [],
  worktrees: [],
  tabs: {},
  panes: {},
  agents: {},
  attention: [],
  resources: {},
  activity: [],
  ui: defaultUi,
  focusRequest: null,
  statusMessage: null,
  toasts: [],
  toastSeq: 0,
  diagnostics: [],
  daemonHealth: "reconnecting",
  daemonStatus: null,
  system: null,
  paletteOpen: false,
  shortcutsOpen: false,
  dialog: null,
  connectionNonce: 0,
  menu: null,
  selection: new Set(),
  selectionAnchor: null,
  zoomed: {},
  healthChecked: false,
  rowErrors: {},
};

const listeners = new Set<() => void>();

export function getState(): State {
  return state;
}

export function setState(patch: Partial<State> | ((s: State) => Partial<State>)): void {
  const next = typeof patch === "function" ? patch(state) : patch;
  state = { ...state, ...next };
  listeners.forEach((l) => l());
}

function shallowEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
  if (a && b && typeof a === "object" && typeof b === "object") {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    return ka.length === kb.length && ka.every((k) => Object.is((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
  }
  return false;
}

export function useStore<T>(selector: (s: State) => T): T {
  const cache = useRef<{ state: State; value: T } | null>(null);
  const read = () => {
    const c = cache.current;
    if (c && c.state === state) return c.value;
    const next = selector(state);
    const value = c && shallowEqual(c.value, next) ? c.value : next;
    cache.current = { state, value };
    return value;
  };
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    read,
  );
}

let uiSaveTimer: number | undefined;
export function setUi(patch: Partial<UiState>): void {
  setState((s) => ({ ui: { ...s.ui, ...patch } }));
  window.clearTimeout(uiSaveTimer);
  uiSaveTimer = window.setTimeout(() => {
    rpc("ui_state_set", { state: state.ui }).catch(() => {});
  }, 300);
}

function groupTabs(tabs: Tab[]): Record<Id, Tab[]> {
  const out: Record<Id, Tab[]> = {};
  for (const t of tabs) (out[t.worktree_id] ??= []).push(t);
  for (const list of Object.values(out)) list.sort((a, b) => a.position - b.position);
  return out;
}

export function applySnapshot(snap: Snapshot): void {
  const ui = sanitizeUi(snap.ui_state, snap.worktrees.map((w) => w.id), addonViews().map((v) => v.id), inspectorSections().map((s) => s.id));
  builtins.forEach((a) => a.onSnapshot?.(snap));
  setState({
    loaded: true,
    config: snap.config,
    repos: snap.repos,
    worktrees: snap.worktrees,
    tabs: groupTabs(snap.tabs),
    panes: Object.fromEntries(snap.panes.map((p) => [p.id, p])),
    agents: Object.fromEntries(snap.agents.map((a) => [a.pane_id, a])),
    attention: snap.attention,
    resources: Object.fromEntries(snap.resources.map((r) => [r.worktree_id, r])),
    daemonStatus: snap.status,
    ui,
  });
  checkHealthOnce();
}

function checkHealthOnce(): void {
  if (state.healthChecked) return;
  setState({ healthChecked: true });
  rpcParsed("config_check", z.array(configIssueSchema))
    .then((issues) => {
      const errors = issues.filter((i) => i.level === "error");
      if (errors.length) toast({ key: "config", level: "warning", title: "Config problem", detail: `${errors[0].key}: ${errors[0].message}${errors.length > 1 ? ` (+${errors.length - 1} more)` : ""}`, actions: [{ label: "Check", run: () => setState({ dialog: { kind: "config-check" } }) }] });
    })
    .catch(() => {});
}

export function setZoom(tabId: Id, paneId: Id | null): void {
  setState((s) => {
    const zoomed = { ...s.zoomed };
    if (paneId && zoomed[tabId] !== paneId) zoomed[tabId] = paneId;
    else delete zoomed[tabId];
    return { zoomed };
  });
}

export function applyFrame(frame: Frame): void {
  builtins.forEach((a) => a.onFrame?.(frame));
  const d = frame.data as never;
  switch (frame.event) {
    case "repos_changed":
      setState({ repos: (d as { repos: Repo[] }).repos });
      break;
    case "worktrees_changed":
      setState({ worktrees: (d as { worktrees: Worktree[] }).worktrees });
      break;
    case "worktree_archiving": {
      const { worktree_id } = d as { worktree_id: Id };
      setState((s) => ({ worktrees: s.worktrees.map((w) => (w.id === worktree_id ? { ...w, archiving: true } : w)) }));
      break;
    }
    case "zoom_request": {
      const { tab_id, pane_id } = d as { tab_id: Id; pane_id: Id | null };
      setZoom(tab_id, pane_id);
      break;
    }
    case "config_changed":
      setState({ config: (d as { config: Config }).config });
      break;
    case "hook_ran":
      break;
    case "metadata_changed": {
      const { worktree_id, metadata } = d as { worktree_id: Id; metadata: Worktree["metadata"] };
      setState((s) => ({ worktrees: s.worktrees.map((w) => (w.id === worktree_id ? { ...w, metadata } : w)) }));
      break;
    }
    case "tabs_changed": {
      const { worktree_id, tabs } = d as { worktree_id: Id; tabs: Tab[] };
      setState((s) => {
        const next = { ...s.tabs };
        if (tabs.length) next[worktree_id] = tabs;
        else delete next[worktree_id];
        const live = new Set(Object.values(next).flat().flatMap((t) => paneIds(t.layout)));
        const panes = Object.fromEntries(Object.entries(s.panes).filter(([id, p]) => p.worktree_id !== worktree_id || live.has(id)));
        const agents = Object.fromEntries(Object.entries(s.agents).filter(([id]) => panes[id]));
        const zoomed = Object.fromEntries(Object.entries(s.zoomed).filter(([, paneId]) => live.has(paneId)));
        return { tabs: next, panes, agents, zoomed };
      });
      break;
    }
    case "pane_changed": {
      const { pane } = d as { pane: Pane };
      setState((s) => ({ panes: { ...s.panes, [pane.id]: pane } }));
      break;
    }
    case "pane_exited": {
      const { pane_id, exit_code } = d as { pane_id: Id; exit_code: number | null };
      setState((s) => (s.panes[pane_id] ? { panes: { ...s.panes, [pane_id]: { ...s.panes[pane_id], live: false, exit_code } } } : {}));
      break;
    }
    case "agent_changed": {
      const { agent } = d as { agent: AgentPresence };
      setState((s) => ({
        agents: { ...s.agents, [agent.pane_id]: agent },
        panes: s.panes[agent.pane_id] ? { ...s.panes, [agent.pane_id]: { ...s.panes[agent.pane_id], agent } } : s.panes,
      }));
      break;
    }
    case "agent_removed": {
      const { pane_id } = d as { pane_id: Id };
      setState((s) => {
        const agents = { ...s.agents };
        delete agents[pane_id];
        return { agents };
      });
      break;
    }
    case "attention_added": {
      const { item } = d as { item: AttentionItem };
      setState((s) => ({ attention: [...s.attention.filter((a) => a.id !== item.id), item] }));
      void announceAttention(item);
      break;
    }
    case "attention_resolved": {
      const { id } = d as { id: Id };
      setState((s) => ({ attention: s.attention.filter((a) => a.id !== id) }));
      dismissToastKey(attentionToastKey(id));
      break;
    }
    case "activity_added":
      setState((s) => ({ activity: mergeActivity(s.activity, [(d as { event: ActivityEvent }).event]) }));
      break;
    case "attention_viewed": {
      const { id } = d as { id: Id };
      setState((s) => ({ attention: s.attention.map((a) => (a.id === id ? { ...a, viewed_at_ms: Date.now() } : a)) }));
      break;
    }
    case "attention_cleared":
      setState((s) => ({ attention: [], toasts: s.toasts.filter((t) => !t.key?.startsWith(attentionToastKey(""))) }));
      break;
    case "resources":
      setState({ resources: Object.fromEntries((d as { worktrees: WorktreeResources[] }).worktrees.map((r) => [r.worktree_id, r])) });
      break;
    case "focus_request": {
      const req = d as { worktree_id: Id; tab_id: Id; pane_id: Id };
      setState((s) => ({
        focusRequest: { ...req, nonce: (s.focusRequest?.nonce ?? 0) + 1 },
        attention: s.attention.map((a) => (a.pane_id === req.pane_id && !a.viewed_at_ms ? { ...a, viewed_at_ms: Date.now() } : a)),
      }));
      setUi({ view: "worktree", activeWorktreeId: req.worktree_id });
      break;
    }
    case "notice": {
      const n = d as { level: ToastLevel; message: string };
      toast({ level: n.level, title: n.message });
      break;
    }
    case "diagnostic": {
      const { diagnostic } = d as { diagnostic: Diagnostic };
      setState((s) => ({ diagnostics: [...s.diagnostics, diagnostic].slice(-DIAGNOSTICS_KEPT) }));
      break;
    }
    case "system_stats":
      setState({ system: (d as { stats: SystemStats }).stats });
      break;
  }
}

export function paneIds(node: import("./types").LayoutNode): Id[] {
  return node.type === "leaf" ? [node.pane_id] : [...paneIds(node.first), ...paneIds(node.second)];
}

export function activeTab(s: State, worktreeId: Id | null): Tab | null {
  if (!worktreeId) return null;
  const tabs = s.tabs[worktreeId] ?? [];
  return tabs.find((t) => t.is_active) ?? tabs[0] ?? null;
}

export function keyBindings(s: State): Record<string, string> {
  const bound = builtins.flatMap((a) => a.shortcuts?.(s) ?? []).map((c) => [c.id, c.binding]);
  return { ...(s.config?.keybindings ?? {}), ...Object.fromEntries(bound) };
}

export function needsMe(s: State): AttentionItem[] {
  return needsMeItems(s.attention, Object.values(s.agents));
}

export const unviewedAttention = needsMe;

export function queryContext(s: State): QueryContext {
  return { repos: s.repos, agents: Object.values(s.agents), attention: s.attention, states: s.config?.states ?? [] };
}

export function agentsOf(s: State, worktreeId: Id): AgentPresence[] {
  return Object.values(s.agents).filter((a) => a.worktree_id === worktreeId && a.state !== "exited");
}

export function repoName(s: State, repoId: Id): string {
  return s.repos.find((r) => r.id === repoId)?.name ?? "?";
}

/** Shows a failure on the worktree's own row. `null` clears it. */
export function setRowError(worktreeId: Id, error: RowError | null): void {
  setState((s) => {
    const { [worktreeId]: _, ...rest } = s.rowErrors;
    return { rowErrors: error ? { ...rest, [worktreeId]: error } : rest };
  });
}

export type ToastLevel = "info" | "warning" | "error";

export interface ToastAction {
  label: string;
  run: () => void;
}

export interface Toast {
  id: number;
  level: ToastLevel;
  title: string;
  detail?: string;
  actions?: ToastAction[];
  /** A toast with the same key replaces the older one instead of stacking. */
  key?: string;
  /** Stays until the user or its owner dismisses it. */
  sticky?: boolean;
  createdAt: number;
}

export const MAX_TOASTS = 3;

export type DaemonHealth = "healthy" | "reconnecting" | "disconnected";

const DIAGNOSTICS_KEPT = 200;

/** A small confirmation of something the user just did. Never for failures or warnings. */
export function showStatus(text: string): void {
  setState((s) => ({ statusMessage: { text, nonce: (s.statusMessage?.nonce ?? 0) + 1 } }));
}

/** An exceptional event worth noticing now. Dismissing it never resolves the underlying issue. */
export function toast(t: Omit<Toast, "id" | "createdAt">): void {
  setState((s) => {
    const id = s.toastSeq + 1;
    const kept = t.key ? s.toasts.filter((x) => x.key !== t.key) : s.toasts;
    return { toastSeq: id, toasts: [...kept, { ...t, id, createdAt: Date.now() }].slice(-MAX_TOASTS) };
  });
}

export function dismissToast(id: number): void {
  setState((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
}

export function dismissToastKey(key: string): void {
  if (state.toasts.some((t) => t.key === key)) setState((s) => ({ toasts: s.toasts.filter((t) => t.key !== key) }));
}

export const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** A catch handler that shows a failed explicit operation as an error toast. */
export const failToast =
  (title: string) =>
  (e: unknown): void =>
    toast({ level: "error", title, detail: errorText(e) });

/** Something Tomo itself did or noticed on the client side, such as a reconnect. A repeat of the newest entry is dropped. */
export function recordDiagnostic(level: DiagnosticLevel, source: string, message: string): void {
  const last = state.diagnostics[state.diagnostics.length - 1];
  if (last && last.level === level && last.source === source && last.message === message) return;
  setState((s) => ({ diagnostics: [...s.diagnostics, { at_ms: Date.now(), level, source, message }].slice(-DIAGNOSTICS_KEPT) }));
}

export function formatBytes(b: number): string {
  const GB = 1024 ** 3;
  const MB = 1024 ** 2;
  if (b >= GB) return `${(b / GB).toFixed(1)} GB`;
  if (b >= MB) return `${Math.round(b / MB)} MB`;
  return `${Math.round(b / 1024)} KB`;
}

export function visibleRepos(s: State): Repo[] {
  return s.repos.filter((r) => s.ui.showHiddenRepos || !s.ui.hiddenRepos.includes(r.id));
}

export function setSelection(ids: Iterable<Id>, anchor: Id | null = null): void {
  setState({ selection: new Set(ids), selectionAnchor: anchor });
}

export function clearSelection(): void {
  if (state.selection.size || state.selectionAnchor) setState({ selection: new Set(), selectionAnchor: null });
}
