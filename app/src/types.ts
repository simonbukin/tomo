import type { Appearance } from "./appearance";
export type {
  ActionDef,
  ActionRunResult,
  ActionSet,
  ActivityEvent,
  ActivityKind,
  ActivityQuery,
  AgentCommand,
  AgentKind,
  AgentPresence,
  AgentReport,
  AgentSession,
  AgentSpawn,
  AgentState,
  Annotation,
  AttentionItem,
  AttentionKind,
  AttentionLevel,
  ArchiveResult,
  Authority,
  CheckpointMode,
  Config,
  ConfigIssue,
  Diagnostic,
  DiagnosticLevel,
  ErrorCode,
  EvidenceBundle,
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
  PaneKind,
  PaneOrigin,
  PrStatusResult,
  PullRequest,
  Repo,
  RpcError,
  RuntimeEndpoint,
  RuntimeProtocol,
  Snapshot,
  SpawnResult,
  SplitDirection,
  StateDef,
  Status,
  Tab,
  ThemeConfig,
  Town,
  TownHistory,
  TownPr,
  TownUnlock,
  TownWorktreeStatus,
  UsageBucket,
  UsageSnapshot,
  Worktree,
  WorktreeCreate,
  WorktreeMetadata,
  WorktreeResources,
} from "./generated";

import type { AgentKind } from "./generated";

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

export type SidebarSort = "name" | "recent" | "created" | "attention" | "state" | "manual";

export type SidebarMode = "open" | "minimal" | "closed";

export interface UiState {
  view: "home" | "worktree" | "towns" | "activity";
  activeWorktreeId: Id | null;
  /** `open` shows the full sidebar at its width, `minimal` a narrow rail, `closed` nothing. */
  leftMode: SidebarMode;
  rightMode: SidebarMode;
  /** Open widths. Minimal and closed keep them for the next open. */
  leftWidth: number;
  rightWidth: number;
  sidebarSort: SidebarSort;
  showArchivedInSidebar: boolean;
  collapsedRepos: string[];
  hiddenRepos: string[];
  showHiddenRepos: boolean;
  home: HomeOptions;
  /** Worktree ids per repo id, in the order the user dragged them. Used when `sidebarSort` is manual. */
  manualOrder: Record<string, Id[]>;
  repoOrder: Id[];
  appearance: Appearance;
  /** Palette entry keys, most recent first. */
  paletteRecent: string[];
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

export const KIND_LABEL: Record<AgentKind, string> = { claude: "Claude", codex: "Codex", pi: "Pi" };
