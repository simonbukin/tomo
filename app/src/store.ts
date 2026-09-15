import { useRef, useSyncExternalStore } from "react";
import { rpc } from "./api";
import { defaultAppearance, sanitizeAppearance } from "./appearance";
import { mergeActivity, needsMeItems, truncate } from "./activityModel";
import type {
  ActionSet,
  ActivityEvent,
  AgentPresence,
  AttentionItem,
  Config,
  ConfigIssue,
  Frame,
  HomeOptions,
  HookRun,
  Id,
  IntegrationStatus,
  Pane,
  PrStatusResult,
  PullRequest,
  Repo,
  RuntimeEndpoint,
  Snapshot,
  Tab,
  TownUnlock,
  UiState,
  UsageSnapshot,
  Worktree,
  WorktreeResources,
} from "./types";
import type { MenuAnchor, MenuItem } from "./components/ui";
import type { QueryContext } from "./homeQuery";

export interface State {
  connected: boolean;
  actions: Record<Id, ActionSet>;
  loaded: boolean;
  config: Config | null;
  repos: Repo[];
  worktrees: Worktree[];
  tabs: Record<Id, Tab[]>;
  panes: Record<Id, Pane>;
  agents: Record<Id, AgentPresence>;
  attention: AttentionItem[];
  resources: Record<Id, WorktreeResources>;
  endpoints: Record<Id, RuntimeEndpoint[]>;
  activity: ActivityEvent[];
  usage: UsageSnapshot[];
  ui: UiState;
  focusRequest: { worktree_id: Id; tab_id: Id; pane_id: Id; nonce: number } | null;
  notice: { level: string; message: string; nonce: number } | null;
  paletteOpen: boolean;
  shortcutsOpen: boolean;
  dialog: Dialog | null;
  connectionNonce: number;
  menu: { anchor: MenuAnchor; items: MenuItem[]; nonce: number } | null;
  unlocks: TownUnlock[];
  selection: Set<Id>;
  selectionAnchor: Id | null;
  prs: Record<Id, PrStatusResult>;
  zoomed: Record<Id, Id>;
  healthChecked: boolean;
}

export type Dialog =
  | { kind: "add-repo" }
  | { kind: "create-worktree"; repoId?: Id }
  | { kind: "confirm"; title: string; body: string; confirmLabel: string; destructive?: boolean; check?: string; onConfirm: (checked: boolean) => void }
  | { kind: "prompt"; title: string; initial: string; placeholder?: string; onSubmit: (value: string) => void }
  | { kind: "integrations" }
  | { kind: "config-check" }
  | { kind: "hook-log" }
  | { kind: "appearance" };

export const defaultHome: HomeOptions = { query: "", filters: [], view: "list", sort: "state", group: "state", showArchived: false };

const defaultUi: UiState = { view: "home", activeWorktreeId: null, leftOpen: true, rightOpen: true, leftWidth: 240, rightWidth: 280, sidebarSort: "name", showArchivedInSidebar: false, collapsedRepos: [], hiddenRepos: [], showHiddenRepos: false, home: defaultHome, manualOrder: {}, repoOrder: [], appearance: defaultAppearance, paletteRecent: [] };

let state: State = {
  connected: false,
  actions: {},
  loaded: false,
  config: null,
  repos: [],
  worktrees: [],
  tabs: {},
  panes: {},
  agents: {},
  attention: [],
  resources: {},
  endpoints: {},
  activity: [],
  usage: [],
  ui: defaultUi,
  focusRequest: null,
  notice: null,
  paletteOpen: false,
  shortcutsOpen: false,
  dialog: null,
  connectionNonce: 0,
  menu: null,
  unlocks: [],
  selection: new Set(),
  selectionAnchor: null,
  prs: {},
  zoomed: {},
  healthChecked: false,
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

function groupEndpoints(list: RuntimeEndpoint[]): Record<Id, RuntimeEndpoint[]> {
  return list.reduce<Record<Id, RuntimeEndpoint[]>>((out, e) => ({ ...out, [e.worktree_id]: [...(out[e.worktree_id] ?? []), e] }), {});
}

function groupTabs(tabs: Tab[]): Record<Id, Tab[]> {
  const out: Record<Id, Tab[]> = {};
  for (const t of tabs) (out[t.worktree_id] ??= []).push(t);
  for (const list of Object.values(out)) list.sort((a, b) => a.position - b.position);
  return out;
}

const oneOf = <T extends string>(allowed: readonly T[], value: unknown, fallback: T): T => (allowed.includes(value as T) ? (value as T) : fallback);

function stringLists(value: unknown): Record<string, Id[]> {
  if (!value || typeof value !== "object") return {};
  return Object.fromEntries(Object.entries(value).filter(([, v]) => Array.isArray(v)).map(([k, v]) => [k, (v as unknown[]).filter((x): x is string => typeof x === "string")]));
}

export function applySnapshot(snap: Snapshot): void {
  const saved = (snap.ui_state ?? {}) as Partial<UiState>;
  const savedHome = (saved.home ?? {}) as Partial<HomeOptions>;
  const ui: UiState = {
    ...defaultUi,
    ...saved,
    sidebarSort: oneOf(["name", "recent", "created", "attention", "state", "manual"], saved.sidebarSort, defaultUi.sidebarSort),
    manualOrder: stringLists(saved.manualOrder),
    repoOrder: Array.isArray(saved.repoOrder) ? saved.repoOrder.filter((x): x is string => typeof x === "string") : [],
    appearance: sanitizeAppearance(saved.appearance),
    paletteRecent: Array.isArray(saved.paletteRecent) ? saved.paletteRecent.filter((x): x is string => typeof x === "string").slice(0, 12) : [],
    collapsedRepos: Array.isArray(saved.collapsedRepos) ? saved.collapsedRepos : [],
    hiddenRepos: Array.isArray(saved.hiddenRepos) ? saved.hiddenRepos : [],
    home: {
      ...defaultHome,
      ...savedHome,
      sort: oneOf(["state", "recent", "created", "name"], savedHome.sort, defaultHome.sort),
      group: oneOf(["state", "repo", "project", "none"], savedHome.group, defaultHome.group),
      filters: Array.isArray(savedHome.filters) ? savedHome.filters.filter((f) => f.kind !== ("priority" as string)) : [],
    },
  };
  if (ui.view === "worktree" && !snap.worktrees.some((w) => w.id === ui.activeWorktreeId)) ui.view = "home";
  rpc<{ unlocks: TownUnlock[] }>("town_list").then((r) => setState({ unlocks: r.unlocks ?? [] })).catch(() => {});
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
    actions: Object.fromEntries((snap.actions ?? []).map((a) => [a.worktree_id, a])),
    endpoints: groupEndpoints(snap.endpoints ?? []),
    usage: snap.usage ?? [],
    ui,
  });
  checkHealthOnce();
}

function checkHealthOnce(): void {
  if (state.healthChecked) return;
  setState({ healthChecked: true });
  rpc<IntegrationStatus[]>("integrations_status")
    .then((list) => {
      const degraded = list.filter((i) => i.level === "partial" || i.level === "process_only");
      if (degraded.length) notify("warning", `${degraded.map((i) => `${i.kind}: ${i.reason ?? i.level}`).join(" · ")} — see integration status`);
    })
    .catch(() => {});
  rpc<ConfigIssue[]>("config_check")
    .then((issues) => {
      const errors = issues.filter((i) => i.level === "error");
      if (errors.length) notify("error", `config: ${errors[0].key} — ${errors[0].message}${errors.length > 1 ? ` (+${errors.length - 1} more)` : ""}`);
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
    case "actions_changed": {
      const { set } = d as { set: ActionSet };
      setState((s) => ({ actions: { ...s.actions, [set.worktree_id]: set } }));
      break;
    }
    case "hook_ran": {
      const { run } = d as { run: HookRun };
      if (!run.ok) notify("error", `hook failed: ${run.event} — ${run.output_tail.trim().split("\n").pop() || `exit ${run.exit_code ?? "?"}`}`);
      break;
    }
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
      if (item.kind === "checkpoint") notify("info", `review requested: ${truncate(item.message)}`);
      break;
    }
    case "attention_resolved": {
      const { id } = d as { id: Id };
      setState((s) => ({ attention: s.attention.filter((a) => a.id !== id) }));
      break;
    }
    case "endpoints_changed": {
      const { worktree_id, endpoints } = d as { worktree_id: Id; endpoints: RuntimeEndpoint[] };
      setState((s) => {
        const next = { ...s.endpoints };
        if (endpoints.length) next[worktree_id] = endpoints;
        else delete next[worktree_id];
        return { endpoints: next };
      });
      break;
    }
    case "activity_added":
      setState((s) => ({ activity: mergeActivity(s.activity, [(d as { event: ActivityEvent }).event]) }));
      break;
    case "usage_changed":
      setState({ usage: (d as { snapshots: UsageSnapshot[] }).snapshots });
      break;
    case "attention_viewed": {
      const { id } = d as { id: Id };
      setState((s) => ({ attention: s.attention.map((a) => (a.id === id ? { ...a, viewed_at_ms: Date.now() } : a)) }));
      break;
    }
    case "attention_cleared":
      setState({ attention: [] });
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
      const n = d as { level: string; message: string };
      setState((s) => ({ notice: { ...n, nonce: (s.notice?.nonce ?? 0) + 1 } }));
      break;
    }
    case "pr_changed": {
      const { worktree_id, pr } = d as { worktree_id: Id; pr: PullRequest | null };
      setState((s) => ({ prs: { ...s.prs, [worktree_id]: { available: true, reason: null, pr } } }));
      break;
    }
    case "town_unlocked": {
      const { unlock } = d as { unlock: TownUnlock };
      setState((s) => ({ unlocks: [...s.unlocks.filter((u) => u.slug !== unlock.slug), unlock] }));
      import("./data/japan-towns.json").then((m) => {
        const town = (m.default as { slug: string; name: string; rarity: string }[]).find((t) => t.slug === unlock.slug);
        if (town) notify("info", `unlocked ${town.name} (${town.rarity})`);
      });
      break;
    }
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

export function activeActionSet(s: State): ActionSet | null {
  return s.ui.view === "worktree" && s.ui.activeWorktreeId ? s.actions[s.ui.activeWorktreeId] ?? null : null;
}

export function runningActionIds(s: State, worktreeId: Id): string[] {
  return Object.values(s.panes)
    .filter((p) => p.worktree_id === worktreeId && p.action_id && p.live && p.exit_code == null)
    .map((p) => p.action_id!)
    .sort();
}

export function keyBindings(s: State): Record<string, string> {
  const shortcuts = (activeActionSet(s)?.actions ?? []).filter((a) => a.shortcut).map((a) => [`action:${a.id}`, a.shortcut!]);
  return { ...(s.config?.keybindings ?? {}), ...Object.fromEntries(shortcuts) };
}

export function needsMe(s: State): AttentionItem[] {
  return needsMeItems(s.attention, Object.values(s.agents));
}

export const unviewedAttention = needsMe;

export function endpointsOf(s: State, worktreeId: Id): RuntimeEndpoint[] {
  return s.endpoints[worktreeId] ?? [];
}

export function liveEndpointFor(s: State, worktreeId: Id, actionId: string): RuntimeEndpoint | null {
  return endpointsOf(s, worktreeId).find((e) => e.action_id === actionId && e.protocol !== "tcp") ?? null;
}

export function queryContext(s: State): QueryContext {
  return { repos: s.repos, agents: Object.values(s.agents), attention: s.attention, states: s.config?.states ?? [] };
}

export function agentsOf(s: State, worktreeId: Id): AgentPresence[] {
  return Object.values(s.agents).filter((a) => a.worktree_id === worktreeId && a.state !== "exited");
}

export function repoName(s: State, repoId: Id): string {
  return s.repos.find((r) => r.id === repoId)?.name ?? "?";
}

export function notify(level: string, message: string): void {
  setState((s) => ({ notice: { level, message, nonce: (s.notice?.nonce ?? 0) + 1 } }));
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
