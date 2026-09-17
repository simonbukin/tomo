import type { Appearance } from "./appearance";
export type {
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
  AttentionItem,
  AttentionKind,
  AttentionLevel,
  ArchiveResult,
  Authority,
  Branch,
  CheckpointMode,
  Config,
  ConfigIssue,
  Diagnostic,
  DiagnosticLevel,
  ErrorCode,
  FsEntry,
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
  Repo,
  RpcError,
  Snapshot,
  SpawnResult,
  SplitDirection,
  StateDef,
  Status,
  SystemStats,
  Tab,
  ThemeConfig,
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

export type SidebarSort = "name" | "recent" | "created" | "attention" | "state" | "manual";

/** How the sidebar arranges the same worktrees. A lens never changes worktree state. */
export type SidebarLens = "repo" | "project" | "tag" | "focus";

export type SidebarMode = "open" | "minimal" | "closed";

export type CoreSection = "worktree" | "git" | "processes" | "sessions" | "files";

/** A core inspector section, or the id of an addon inspector section. */
export type RightSection = CoreSection | (string & {});

export interface UiState {
  /** A core view, or the id of an addon view. */
  view: "home" | "worktree" | "activity" | (string & {});
  activeWorktreeId: Id | null;
  /** `open` shows the full sidebar at its width, `minimal` a narrow rail, `closed` nothing. */
  leftMode: SidebarMode;
  rightMode: SidebarMode;
  /** Open widths. Minimal and closed keep them for the next open. */
  leftWidth: number;
  rightWidth: number;
  /** The inspector section that the right rail asked to show. */
  rightSection: RightSection | null;
  sidebarSort: SidebarSort;
  lens: SidebarLens;
  showArchivedInSidebar: boolean;
  /** Collapsed group keys: a repo id in the repository lens, a lens-prefixed key in the others. */
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

/** Which slice of the workspace Home shows. A scope filters; it names no new object. */
export type HomeScope =
  | { kind: "all" }
  | { kind: "repo"; repoId: Id }
  | { kind: "project"; project: string }
  | { kind: "tag"; tag: string };

export interface HomeOptions {
  query: string;
  scope: HomeScope;
  filters: Filter[];
  view: "list" | "board";
  sort: "state" | "recent" | "created" | "name";
  group: "state" | "repo" | "project" | "none";
  showArchived: boolean;
}

export type Frame = { seq: number; event: string; data?: unknown };

export const KIND_LABEL: Record<AgentKind, string> = { claude: "Claude", codex: "Codex", pi: "Pi" };
