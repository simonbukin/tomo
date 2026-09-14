export type Id = string;

export type AgentKind = "claude" | "codex" | "pi";
export type AgentState = "working" | "waiting" | "idle" | "exited" | "unknown";
export type Authority = "lifecycle" | "report" | "screen" | "heuristic" | "unknown";
export type SplitDirection = "horizontal" | "vertical";
export type PaneOrigin = "live" | "restored" | "resumed";
export type Ownership = "owned" | "observed" | "unknown";
export type AttentionLevel = "attention" | "info";

export interface Repo {
  id: Id;
  path: string;
  name: string;
  exists: boolean;
}

export interface GitSummary {
  branch: string | null;
  head: string;
  detached: boolean;
  dirty: boolean;
  files_changed: number;
  untracked: number;
  insertions: number;
  deletions: number;
  ahead: number | null;
  behind: number | null;
  upstream: string | null;
}

export interface WorktreeMetadata {
  display_name: string | null;
  project: string | null;
  priority: number | null;
  tags: string[];
}

export interface Worktree {
  id: Id;
  repo_id: Id;
  path: string;
  name: string;
  branch: string | null;
  head: string;
  detached: boolean;
  is_main: boolean;
  exists: boolean;
  git: GitSummary | null;
  metadata: WorktreeMetadata;
  last_active_ms: number | null;
  first_seen_ms?: number | null;
  archived_at_ms?: number | null;
  town_slug?: string | null;
  tab_count: number;
  pane_count: number;
}

export type LayoutNode =
  | { type: "leaf"; pane_id: Id }
  | { type: "split"; id: Id; direction: SplitDirection; ratio: number; first: LayoutNode; second: LayoutNode };

export interface Tab {
  id: Id;
  worktree_id: Id;
  title: string;
  position: number;
  layout: LayoutNode;
  active_pane_id: Id | null;
  is_active: boolean;
}

export interface AgentPresence {
  pane_id: Id;
  worktree_id: Id;
  kind: AgentKind;
  state: AgentState;
  session_ref: string | null;
  authority: Authority;
  updated_at_ms: number;
  pid: number | null;
}

export interface Pane {
  id: Id;
  tab_id: Id;
  worktree_id: Id;
  title: string;
  user_title: string | null;
  cwd: string;
  cols: number;
  rows: number;
  pid: number | null;
  live: boolean;
  origin: PaneOrigin;
  exit_code: number | null;
  agent: AgentPresence | null;
  created_at_ms: number;
}

export interface ProcessInfo {
  pid: number;
  ppid: number | null;
  name: string;
  cmd: string;
  cwd: string | null;
  cpu_percent: number;
  rss_bytes: number;
  start_time_s: number;
  worktree_id: Id | null;
  pane_id: Id | null;
  ownership: Ownership;
  depth: number;
}

export interface WorktreeResources {
  worktree_id: Id;
  cpu_percent: number;
  rss_bytes: number;
  process_count: number;
}

export interface AttentionItem {
  id: Id;
  worktree_id: Id;
  pane_id: Id | null;
  level: AttentionLevel;
  message: string;
  created_at_ms: number;
  viewed_at_ms: number | null;
}

export interface FsEntry {
  name: string;
  rel_path: string;
  is_dir: boolean;
  size: number;
}

export interface Config {
  shell: string;
  editor_command: string[];
  worktree_parent_dir: string | null;
  resource_warning_bytes: number;
  scrollback_lines: number;
  font_family: string;
  font_size: number;
  theme: string;
  keybindings: Record<string, string>;
  agents: Record<string, { command: string; args: string[] }>;
  archive_cleanup?: string[];
  hooks?: Record<string, string>;
}

export type Rarity = "common" | "uncommon" | "rare" | "epic" | "legendary";

export interface Town {
  slug: string;
  name: string;
  ja: string;
  pref: string;
  kind: string;
  population: number | null;
  lat: number;
  lon: number;
  wiki: string;
  rarity: Rarity;
}

export interface TownUnlock {
  slug: string;
  worktree_id: Id;
  repo_id: Id;
  unlocked_at_ms: number;
}

export interface Status {
  protocol: number;
  version: string;
  daemon_pid: number;
  session_id: Id;
  repos: number;
  worktrees: number;
  panes: number;
  live_panes: number;
  agents: number;
  clients: number;
  integrations: { claude_hooks: boolean; codex_hooks: boolean; pi_extension: boolean };
}

export interface Snapshot {
  status: Status;
  config: Config;
  repos: Repo[];
  worktrees: Worktree[];
  tabs: Tab[];
  panes: Pane[];
  agents: AgentPresence[];
  attention: AttentionItem[];
  resources: WorktreeResources[];
  ui_state: UiState | null;
}

export type SidebarSort = "name" | "recent" | "created" | "attention" | "priority";

export interface UiState {
  view: "home" | "worktree" | "towns";
  activeWorktreeId: Id | null;
  leftOpen: boolean;
  rightOpen: boolean;
  leftWidth: number;
  rightWidth: number;
  sidebarSort: SidebarSort;
  showArchivedInSidebar: boolean;
  home: HomeOptions;
}

export type FilterKind = "repo" | "project" | "tag" | "priority" | "agent" | "archived" | "attention";

export interface Filter {
  kind: FilterKind;
  value: string;
}

export interface HomeOptions {
  query: string;
  filters: Filter[];
  view: "list" | "board";
  sort: "priority" | "recent" | "created" | "name";
  group: "repo" | "project" | "priority" | "none";
  showArchived: boolean;
}

export type Frame = { seq: number; event: string; data?: unknown };

export const STATE_GLYPH: Record<AgentState, string> = {
  working: "●",
  waiting: "◉",
  idle: "○",
  exited: "×",
  unknown: "?",
};

export const KIND_LABEL: Record<AgentKind, string> = { claude: "Claude", codex: "Codex", pi: "Pi" };
