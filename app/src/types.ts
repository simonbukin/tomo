export type {
  ActionDef,
  ActionRunResult,
  ActionSet,
  AgentCommand,
  AgentKind,
  AgentPresence,
  AgentReport,
  AgentSession,
  AgentSpawn,
  AgentState,
  AttentionItem,
  AttentionLevel,
  ArchiveResult,
  Authority,
  CheckpointMode,
  Config,
  ConfigIssue,
  ErrorCode,
  FsEntry,
  GitHubRepo,
  GitSummary,
  Hello,
  HookAgent,
  HookDef,
  HookEvent,
  HookMode,
  HookPane,
  HookRun,
  HookWorktree,
  IntegrationLevel,
  IntegrationStatus,
  Integrations,
  IssueLevel,
  LayoutNode,
  MetadataPatch,
  NoticeLevel,
  Pane,
  PaneCreate,
  PaneOrigin,
  PrStatusResult,
  PullRequest,
  Repo,
  RpcError,
  Snapshot,
  SpawnResult,
  SplitDirection,
  StateDef,
  Status,
  Tab,
  Town,
  TownUnlock,
  Worktree,
  WorktreeCreate,
  WorktreeMetadata,
  WorktreeResources,
} from "./generated";

import type { AgentKind, AgentState } from "./generated";

export type Id = string;

export type Ownership = "owned" | "observed" | "unknown";

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

export type Rarity = "common" | "uncommon" | "rare" | "epic" | "legendary";

export type SidebarSort = "name" | "recent" | "created" | "attention" | "state";

export interface UiState {
  view: "home" | "worktree" | "towns";
  activeWorktreeId: Id | null;
  leftOpen: boolean;
  rightOpen: boolean;
  leftWidth: number;
  rightWidth: number;
  sidebarSort: SidebarSort;
  showArchivedInSidebar: boolean;
  collapsedRepos: string[];
  hiddenRepos: string[];
  showHiddenRepos: boolean;
  home: HomeOptions;
}

export type FilterKind = "state" | "repo" | "project" | "tag" | "agent" | "archived" | "attention";

export interface Filter {
  kind: FilterKind;
  value: string;
}

export interface HomeOptions {
  query: string;
  filters: Filter[];
  view: "list" | "board";
  sort: "state" | "recent" | "created" | "name";
  group: "state" | "repo" | "project" | "none";
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
