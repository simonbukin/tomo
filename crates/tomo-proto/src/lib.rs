//! Wire types shared by `tomod`, the `tomo` CLI, and the Tauri client.
//!
//! Transport: newline-delimited JSON over a Unix domain socket.
//! A client sends [`Request`] frames and receives [`Frame`] frames.
//!
//! Every type marked `#[ts(export)]` is exported to `app/src/generated/`.
//! Run `TOMO_WRITE_TYPES=1 cargo test -p tomo-proto` after a change here;
//! the default test run fails when the generated files are stale.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use std::path::PathBuf;
use ts_rs::TS;

pub mod activity;
pub use activity::*;

pub mod addons {
    pub mod actions;
    pub mod agentation;
    pub mod github;
    pub mod runtime;
    pub mod towns;
    pub mod usage;
}
pub use addons::actions::*;
pub use addons::agentation::*;
pub use addons::github::*;
pub use addons::runtime::*;
pub use addons::towns::*;
pub use addons::usage::*;

pub const PROTOCOL_VERSION: u32 = 3;

pub type Id = String;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Request {
    pub id: u64,
    #[serde(flatten)]
    pub call: Call,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum Frame {
    Response { id: u64, result: Value },
    Error { id: u64, error: RpcError },
    Event { seq: u64, #[serde(flatten)] event: Event },
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct RpcError {
    pub code: ErrorCode,
    pub message: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    BadRequest,
    NotFound,
    Conflict,
    Git,
    Io,
    Unsupported,
    Internal,
    Aborted,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "method", content = "params", rename_all = "snake_case")]
pub enum Call {
    Hello { protocol: u32, client: String },
    Status,
    Subscribe,
    ConfigGet,
    ConfigCheck,
    /// Edits one dotted key in config.toml in place and keeps comments. A null `value` removes the key.
    ConfigSet { key: String, value: Value },
    /// Opens config.toml with `editor_command`, else the default text editor.
    ConfigOpen,
    DaemonStop,
    IntegrationsInstall,
    IntegrationsStatus,
    HookLog { limit: Option<usize> },

    RepoList,
    RepoAdd { path: PathBuf },
    RepoRemove { repo_id: Id },
    RepoClone { url: String, dest: PathBuf },

    WorktreeList,
    WorktreeRefresh,
    WorktreeCreate(WorktreeCreate),
    WorktreeArchive { worktree_id: Id, #[serde(default)] checkpoint: CheckpointMode },
    WorktreeRestore { worktree_id: Id },
    WorktreeOpen { worktree_id: Id },
    WorktreeResolve { path: PathBuf },
    MetadataGet { worktree_id: Id },
    MetadataSet { worktree_id: Id, patch: MetadataPatch },

    TabCreate { worktree_id: Id, title: Option<String> },
    TabClose { tab_id: Id, force: bool },
    TabRename { tab_id: Id, title: String },
    /// Moves a tab to `position` among its worktree's tabs (0-based); the others shift.
    TabMove { tab_id: Id, position: u32 },
    /// Moves a pane next to `target_pane_id` (`place` picks the side, `center` swaps), or into tab `tab_id`.
    PaneMove { pane_id: Id, #[serde(default)] target_pane_id: Option<Id>, #[serde(default)] tab_id: Option<Id>, place: DropPlace },
    TabActivate { tab_id: Id },
    /// Reopens the most recently closed tab of the worktree from a bounded stack.
    TabReopen { worktree_id: Id },
    LayoutResize { tab_id: Id, split_id: Id, ratio: f64 },
    LayoutEqualize { tab_id: Id },
    LayoutRotate { tab_id: Id, split_id: Option<Id> },
    PaneSwap { pane_a: Id, pane_b: Id },
    PaneZoom { pane_id: Option<Id>, tab_id: Option<Id> },

    PaneList { worktree_id: Option<Id> },
    PaneCreate(PaneCreate),
    PaneSplit { pane_id: Id, direction: SplitDirection, command: Option<Vec<String>> },
    PaneClose { pane_id: Id, force: bool },
    PaneFocus { pane_id: Id },
    PaneRename { pane_id: Id, title: Option<String> },
    PaneSend { pane_id: Id, data_base64: String },
    PaneResize { pane_id: Id, cols: u16, rows: u16 },
    PaneAttach { pane_id: Id },
    PaneDetach { pane_id: Id },
    PaneKillTree { pane_id: Id },
    /// The last `lines` (default 8, at most 200) non-empty lines of pane output as plain text.
    PaneTail { pane_id: Id, #[serde(default)] lines: Option<u32> },

    AgentList { worktree_id: Option<Id> },
    AgentSpawn(AgentSpawn),
    AgentHook { kind: AgentKind, pane_id: Id, payload: Value, at_ms: u64 },
    AgentReport(AgentReport),

    Ps { worktree_id: Option<Id> },
    ProcessKillTree { pid: u32 },

    Notify { pane_id: Option<Id>, worktree_id: Option<Id>, level: AttentionLevel, message: String },
    AttentionList,
    AttentionNext,
    AttentionView { id: Id },
    AttentionClear,

    GitSummary { worktree_id: Id },
    PrStatus { worktree_id: Id },
    FsList { worktree_id: Id, rel_path: String },
    OpenExternal { worktree_id: Id, rel_path: String, target: ExternalTarget },
    /// Opens an absolute `path` at `line` and `col` in the configured editor.
    OpenLocation { path: PathBuf, #[serde(default)] line: Option<u32>, #[serde(default)] col: Option<u32> },

    UiStateGet,
    UiStateSet { state: Value },

    TownList,
    TownPick,
    /// Facts about one unlocked town: its worktree, branch, status, final commit, PR, and archive date.
    TownHistory { slug: String },
    SessionList { worktree_id: Id, #[serde(default)] limit: Option<usize> },
    RuntimeList { #[serde(default)] worktree_id: Option<Id> },
    ActivityList(ActivityQuery),
    CheckpointCreate(CheckpointSpec),
    CheckpointResolve { id: Id },
    UsageGet { #[serde(default)] refresh: bool },
    /// Recent diagnostics, newest first: what Tomo itself did or noticed.
    DiagnosticsList { #[serde(default)] limit: Option<u32> },
    /// Machine pressure now: CPU, memory, optional GPU, the daemon's own memory, and the heaviest worktree.
    SystemStats,
    BrowserOpen { worktree_id: Id, #[serde(default)] url: Option<String>, #[serde(default)] tab_id: Option<Id> },
    BrowserNavigate { pane_id: Id, url: String },
    AnnotationsSend { pane_id: Id, bundle: EvidenceBundle },

    ActionList { worktree_id: Id },
    ActionRun { worktree_id: Id, action_id: String },
    ActionStop { worktree_id: Id, action_id: String },
    ActionRestart { worktree_id: Id, action_id: String },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum CheckpointMode {
    #[default]
    Checkpoint,
    RequireClean,
    Discard,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct ArchiveResult {
    pub worktree_id: Id,
    pub branch: Option<String>,
    pub checkpoint_commit: Option<String>,
    pub cleanup_removed: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct WorktreeCreate {
    pub repo_id: Id,
    pub branch: String,
    pub new_branch: bool,
    pub start_ref: Option<String>,
    pub path: Option<PathBuf>,
    /// A hint for the worktree namer when `path` is empty. Clients before the addon split send it as `town_slug`.
    #[serde(default, alias = "town_slug")]
    pub name_hint: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, TS)]
pub struct PaneCreate {
    pub worktree_id: Option<Id>,
    pub tab_id: Option<Id>,
    pub cwd: Option<PathBuf>,
    pub command: Option<Vec<String>>,
    pub title: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct AgentSpawn {
    pub kind: AgentKind,
    pub worktree_id: Option<Id>,
    pub cwd: Option<PathBuf>,
    pub tab_id: Option<Id>,
    pub split_from: Option<Id>,
    pub resume: Option<String>,
    /// Open the agent in a fresh tab named after it instead of the active tab.
    #[serde(default)]
    pub new_tab: bool,
    pub extra_args: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct AgentReport {
    pub pane_id: Id,
    pub kind: AgentKind,
    pub state: Option<AgentState>,
    pub session_ref: Option<String>,
    pub authority: Authority,
    pub at_ms: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum SplitDirection {
    Horizontal,
    Vertical,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum ExternalTarget {
    Finder,
    Editor,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(tag = "event", content = "data", rename_all = "snake_case")]
pub enum Event {
    EndpointsChanged { worktree_id: Id, endpoints: Vec<RuntimeEndpoint> },
    ActivityAdded { event: ActivityEvent },
    AttentionResolved { id: Id },
    UsageChanged { snapshots: Vec<UsageSnapshot> },
    ReposChanged { repos: Vec<Repo> },
    WorktreesChanged { worktrees: Vec<Worktree> },
    MetadataChanged { worktree_id: Id, metadata: WorktreeMetadata },
    WorktreeArchiving { worktree_id: Id },
    TabsChanged { worktree_id: Id, tabs: Vec<Tab> },
    PaneOutput { pane_id: Id, data_base64: String },
    PaneChanged { pane: Pane },
    PaneExited { pane_id: Id, exit_code: Option<i32> },
    AgentChanged { agent: AgentPresence },
    AgentRemoved { pane_id: Id },
    AttentionAdded { item: AttentionItem },
    AttentionViewed { id: Id },
    AttentionCleared,
    Resources { worktrees: Vec<WorktreeResources> },
    FocusRequest { worktree_id: Id, tab_id: Id, pane_id: Id },
    ZoomRequest { tab_id: Id, pane_id: Option<Id> },
    Notice { level: NoticeLevel, message: String },
    TownUnlocked { unlock: TownUnlock },
    PrChanged { worktree_id: Id, pr: Option<PullRequest> },
    HookRan { run: HookRun },
    ActionsChanged { set: ActionSet },
    ConfigChanged { config: Config },
    Diagnostic { diagnostic: Diagnostic },
    /// Pushed every few seconds while a client is subscribed.
    SystemStats { stats: SystemStats },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum NoticeLevel {
    Info,
    Warning,
    Error,
}

/// One thing Tomo itself did or noticed. Work that the user cares about goes to Activity instead.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct Diagnostic {
    pub at_ms: u64,
    pub level: DiagnosticLevel,
    /// Subsystem: `daemon`, `config`, `usage`, `hooks`, `runtime`, `browser`, or `integrations`.
    pub source: String,
    pub message: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum DiagnosticLevel {
    Info,
    Warning,
    Error,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, TS)]
pub struct SystemStats {
    pub at_ms: u64,
    /// All cores together, 0 to 100.
    pub cpu_percent: f32,
    pub memory_used_bytes: u64,
    pub memory_total_bytes: u64,
    /// None when the machine does not report GPU utilization.
    pub gpu_percent: Option<f32>,
    /// None on unified memory or when the driver does not report it.
    pub vram_used_bytes: Option<u64>,
    pub vram_total_bytes: Option<u64>,
    pub daemon_rss_bytes: u64,
    /// The worktree with the most resident memory, if any worktree has processes.
    pub top_worktree: Option<WorktreeResources>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct Hello {
    pub protocol: u32,
    pub version: String,
    pub daemon_pid: u32,
    pub session_id: Id,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct Status {
    pub protocol: u32,
    pub version: String,
    pub daemon_pid: u32,
    pub session_id: Id,
    pub started_at_ms: u64,
    pub socket_path: PathBuf,
    pub data_dir: PathBuf,
    pub repos: usize,
    pub worktrees: usize,
    pub panes: usize,
    pub live_panes: usize,
    pub agents: usize,
    pub clients: usize,
    pub integrations: Integrations,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, TS)]
pub struct Integrations {
    pub claude_hooks: bool,
    pub codex_hooks: bool,
    pub pi_extension: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum IntegrationLevel {
    Full,
    Partial,
    ProcessOnly,
    Unavailable,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct IntegrationStatus {
    pub kind: AgentKind,
    pub level: IntegrationLevel,
    pub binary: Option<PathBuf>,
    pub lifecycle: bool,
    pub resume: bool,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct StateDef {
    pub id: String,
    pub label: String,
    pub order: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct HookDef {
    pub event: String,
    pub command: String,
    pub state: Option<String>,
    pub mode: HookMode,
    pub timeout_s: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum HookMode {
    Async,
    Pane,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct HookRun {
    pub event: String,
    pub command: String,
    pub worktree_id: Option<Id>,
    pub started_at_ms: u64,
    pub duration_ms: u64,
    pub exit_code: Option<i32>,
    pub ok: bool,
    pub output_tail: String,
}

/// Payload every hook receives on stdin. Fields are present when they apply.
#[derive(Debug, Clone, Default, Serialize, Deserialize, TS)]
pub struct HookEvent {
    pub event: String,
    pub at_ms: u64,
    pub worktree: Option<HookWorktree>,
    pub previous_state: Option<String>,
    pub pane: Option<HookPane>,
    pub agent: Option<HookAgent>,
    pub attention: Option<AttentionItem>,
    pub action: Option<HookAction>,
}

/// The `action` field of a hook event: the Action that started the pane. The Action and runtime events fill it.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct HookAction {
    pub id: String,
    pub label: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct HookWorktree {
    pub id: Id,
    pub path: PathBuf,
    pub repo_id: Id,
    pub repo_path: PathBuf,
    pub branch: Option<String>,
    pub name: String,
    pub state: Option<String>,
    pub project: Option<String>,
    pub tags: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct HookPane {
    pub id: Id,
    pub tab_id: Id,
    pub cwd: PathBuf,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct HookAgent {
    pub kind: AgentKind,
    pub state: AgentState,
    pub session_ref: Option<String>,
}

pub const HOOK_EVENTS: &[&str] = &[
    "worktree.discovered",
    "worktree.created",
    "worktree.before_archive",
    "worktree.archived",
    "worktree.restored",
    "worktree.state_changed",
    "pane.created",
    "pane.closed",
    "agent.started",
    "agent.working",
    "agent.waiting",
    "agent.idle",
    "agent.exited",
    "attention.created",
    "action.started",
    "action.exited",
    "action.crashed",
    "runtime.endpoint_discovered",
    "runtime.endpoint_removed",
    "checkpoint.created",
    "checkpoint.resolved",
    "annotation.sent",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum IssueLevel {
    Warning,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct ConfigIssue {
    pub level: IssueLevel,
    pub key: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct Config {
    pub shell: String,
    pub editor_command: Vec<String>,
    pub worktree_parent_dir: Option<PathBuf>,
    pub resource_warning_bytes: u64,
    pub scrollback_lines: u32,
    pub font_family: String,
    pub font_size: u32,
    #[serde(default)]
    pub theme: ThemeConfig,
    pub max_panes_per_tab: u32,
    pub keybindings: BTreeMap<String, String>,
    pub agents: BTreeMap<String, AgentCommand>,
    #[serde(default)]
    pub archive_cleanup: Vec<String>,
    #[serde(default)]
    pub states: Vec<StateDef>,
    #[serde(default)]
    pub hooks: Vec<HookDef>,
    #[serde(default)]
    pub notifications: NotificationSettings,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct NotificationSettings {
    /// Desktop notifications while Tomo is not focused.
    pub desktop: bool,
    /// Sounds for rare moments only: a human checkpoint and a rare town unlock.
    pub sounds: bool,
}

impl Default for NotificationSettings {
    fn default() -> Self {
        NotificationSettings { desktop: true, sounds: false }
    }
}

/// `[theme]` after validation. Invalid values are already dropped and reported by `config_check`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct ThemeConfig {
    /// Base theme id: `system`, `murasaki-dark`, `murasaki-light`, `paper`, or `ink`.
    pub name: String,
    /// Base theme for a light OS appearance when `name` is `system`.
    pub light: String,
    /// Base theme for a dark OS appearance when `name` is `system`.
    pub dark: String,
    /// Token overrides keyed by token name (`bg`, `surface`, ...). Values are `#rgb` or `#rrggbb`; `accent` also takes a preset name.
    pub colors: BTreeMap<String, String>,
}

impl Default for ThemeConfig {
    fn default() -> Self {
        ThemeConfig { name: "system".into(), light: "murasaki-light".into(), dark: "murasaki-dark".into(), colors: BTreeMap::new() }
    }
}

/// Where a dragged pane lands relative to a target pane.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum DropPlace {
    Center,
    Left,
    Right,
    Top,
    Bottom,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct AgentCommand {
    pub command: String,
    pub args: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct Repo {
    pub id: Id,
    pub path: PathBuf,
    pub name: String,
    pub exists: bool,
    #[serde(default)]
    pub remote_url: Option<String>,
    #[serde(default)]
    pub github: Option<GitHubRepo>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct GitHubRepo {
    pub owner: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct Worktree {
    pub id: Id,
    pub repo_id: Id,
    pub path: PathBuf,
    pub name: String,
    pub branch: Option<String>,
    pub head: String,
    pub detached: bool,
    pub is_main: bool,
    pub exists: bool,
    pub git: Option<GitSummary>,
    pub metadata: WorktreeMetadata,
    pub last_active_ms: Option<u64>,
    #[serde(default)]
    pub first_seen_ms: Option<u64>,
    #[serde(default)]
    pub archived_at_ms: Option<u64>,
    #[serde(default)]
    pub archiving: bool,
    pub tab_count: usize,
    pub pane_count: usize,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
pub struct GitSummary {
    pub branch: Option<String>,
    pub head: String,
    pub detached: bool,
    pub dirty: bool,
    pub files_changed: u32,
    pub untracked: u32,
    #[serde(default)]
    pub conflicts: u32,
    pub insertions: u32,
    pub deletions: u32,
    pub ahead: Option<u32>,
    pub behind: Option<u32>,
    pub upstream: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct WorktreeMetadata {
    pub display_name: Option<String>,
    pub project: Option<String>,
    #[serde(default)]
    pub state: Option<String>,
    #[serde(default)]
    pub tags: Vec<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, TS)]
pub struct MetadataPatch {
    #[serde(default, with = "double_option")]
    #[ts(optional, type = "string | null")]
    pub display_name: Option<Option<String>>,
    #[serde(default, with = "double_option")]
    #[ts(optional, type = "string | null")]
    pub project: Option<Option<String>>,
    #[serde(default, with = "double_option")]
    #[ts(optional, type = "string | null")]
    pub state: Option<Option<String>>,
    #[serde(default)]
    #[ts(optional)]
    pub tags: Option<Vec<String>>,
}

mod double_option {
    use serde::{Deserialize, Deserializer, Serialize, Serializer};
    pub fn serialize<T: Serialize, S: Serializer>(v: &Option<Option<T>>, s: S) -> Result<S::Ok, S::Error> {
        match v {
            Some(inner) => inner.serialize(s),
            None => s.serialize_none(),
        }
    }
    pub fn deserialize<'de, T: Deserialize<'de>, D: Deserializer<'de>>(d: D) -> Result<Option<Option<T>>, D::Error> {
        Option::<T>::deserialize(d).map(Some)
    }
}

impl MetadataPatch {
    pub fn apply(&self, base: &WorktreeMetadata) -> WorktreeMetadata {
        WorktreeMetadata {
            display_name: self.display_name.clone().unwrap_or_else(|| base.display_name.clone()),
            project: self.project.clone().unwrap_or_else(|| base.project.clone()),
            state: self.state.clone().unwrap_or_else(|| base.state.clone()),
            tags: self.tags.clone().unwrap_or_else(|| base.tags.clone()),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct Tab {
    pub id: Id,
    pub worktree_id: Id,
    pub title: String,
    pub position: i64,
    pub layout: LayoutNode,
    pub active_pane_id: Option<Id>,
    pub is_active: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum LayoutNode {
    Leaf { pane_id: Id },
    Split { id: Id, direction: SplitDirection, ratio: f64, first: Box<LayoutNode>, second: Box<LayoutNode> },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum PaneOrigin {
    Live,
    Restored,
    Resumed,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct Pane {
    pub id: Id,
    pub tab_id: Id,
    pub worktree_id: Id,
    pub title: String,
    pub user_title: Option<String>,
    pub cwd: PathBuf,
    pub cols: u16,
    pub rows: u16,
    pub pid: Option<u32>,
    pub live: bool,
    pub origin: PaneOrigin,
    pub exit_code: Option<i32>,
    pub agent: Option<AgentPresence>,
    pub created_at_ms: u64,
    /// `source.id` when `source.kind` is `action`. Clients from before the Actions addon read it; see [`PaneSource::action_id`].
    #[serde(default)]
    pub action_id: Option<String>,
    #[serde(default)]
    pub source: Option<PaneSource>,
    /// Command line of the newest child of the pane's shell, for icons and titles.
    #[serde(default)]
    pub process_cmd: Option<String>,
    #[serde(default)]
    pub kind: PaneKind,
    /// Current URL of a browser surface.
    #[serde(default)]
    pub url: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum PaneKind {
    #[default]
    Terminal,
    Browser,
}

/// What started a pane, as the spawner names it. Core keeps it in memory only and never reads `kind`,
/// so a restored or reopened pane has no source.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct PaneSource {
    /// The owner, for example `action`.
    pub kind: String,
    /// The owner's id for the thing that runs, for example the Action id.
    pub id: String,
    /// A name for people: titles, endpoint labels, toasts.
    pub label: String,
}

/// The `PaneSource.kind` of a pane that an Action started.
pub const ACTION_SOURCE_KIND: &str = "action";

impl PaneSource {
    /// The value of the older `action_id` wire fields, which installed clients still read.
    pub fn action_id(source: Option<&PaneSource>) -> Option<String> {
        source.filter(|s| s.kind == ACTION_SOURCE_KIND).map(|s| s.id.clone())
    }
}

/// One agent conversation stored by the agent itself, rooted at a worktree.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct AgentSession {
    pub kind: AgentKind,
    pub id: String,
    pub title: Option<String>,
    pub branch: Option<String>,
    pub updated_at_ms: u64,
    pub turns: u32,
    pub path: PathBuf,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum AgentKind {
    Claude,
    Codex,
    Pi,
}

impl AgentKind {
    pub fn label(self) -> &'static str {
        match self {
            AgentKind::Claude => "Claude",
            AgentKind::Codex => "Codex",
            AgentKind::Pi => "Pi",
        }
    }

    pub fn all() -> [AgentKind; 3] {
        [AgentKind::Claude, AgentKind::Codex, AgentKind::Pi]
    }
}

impl std::str::FromStr for AgentKind {
    type Err = String;
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s.to_ascii_lowercase().as_str() {
            "claude" => Ok(AgentKind::Claude),
            "codex" => Ok(AgentKind::Codex),
            "pi" => Ok(AgentKind::Pi),
            other => Err(format!("unknown agent kind: {other}")),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum AgentState {
    Working,
    Waiting,
    Idle,
    Exited,
    Unknown,
}

impl AgentState {
    pub fn glyph(self) -> &'static str {
        match self {
            AgentState::Working => "●",
            AgentState::Waiting => "◉",
            AgentState::Idle => "○",
            AgentState::Exited => "×",
            AgentState::Unknown => "?",
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            AgentState::Working => "working",
            AgentState::Waiting => "waiting",
            AgentState::Idle => "idle",
            AgentState::Exited => "exited",
            AgentState::Unknown => "unknown",
        }
    }
}

/// Lower number = stronger authority. See PRD §14.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum Authority {
    Lifecycle = 1,
    Report = 2,
    Screen = 3,
    Heuristic = 4,
    Unknown = 5,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct AgentPresence {
    pub pane_id: Id,
    pub worktree_id: Id,
    pub kind: AgentKind,
    pub state: AgentState,
    pub session_ref: Option<String>,
    pub authority: Authority,
    pub updated_at_ms: u64,
    pub pid: Option<u32>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum Ownership {
    Owned,
    Observed,
    Unknown,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct ProcessInfo {
    pub pid: u32,
    pub ppid: Option<u32>,
    pub name: String,
    pub cmd: String,
    pub cwd: Option<PathBuf>,
    pub cpu_percent: f32,
    pub rss_bytes: u64,
    pub start_time_s: u64,
    pub worktree_id: Option<Id>,
    pub pane_id: Option<Id>,
    pub ownership: Ownership,
    pub depth: u32,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, TS)]
pub struct WorktreeResources {
    pub worktree_id: Id,
    pub cpu_percent: f32,
    pub rss_bytes: u64,
    pub process_count: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum AttentionLevel {
    Attention,
    Info,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct AttentionItem {
    pub id: Id,
    pub worktree_id: Id,
    pub pane_id: Option<Id>,
    pub level: AttentionLevel,
    pub message: String,
    pub created_at_ms: u64,
    pub viewed_at_ms: Option<u64>,
    #[serde(default)]
    pub kind: AttentionKind,
    #[serde(default)]
    pub url: Option<String>,
    #[serde(default)]
    pub agent_kind: Option<AgentKind>,
    #[serde(default)]
    pub resolved_at_ms: Option<u64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum AttentionKind {
    #[default]
    Waiting,
    /// An agent asked a human to review or decide. Created by `tomo checkpoint`.
    Checkpoint,
    /// A process that a pane source started exited, and Tomo did not stop it. The owner of the source raises it; today only Actions do.
    Crash,
}

/// `tomo checkpoint`: an explicit request for human review or a decision.
#[derive(Debug, Clone, Default, Serialize, Deserialize, TS)]
pub struct CheckpointSpec {
    pub message: String,
    #[serde(default)]
    pub url: Option<String>,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub worktree_id: Option<Id>,
    #[serde(default)]
    pub pane_id: Option<Id>,
}

// ---- runtime endpoints: observed listening sockets owned by tracked processes

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum RuntimeProtocol {
    Http,
    Https,
    Tcp,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct RuntimeEndpoint {
    pub id: Id,
    pub worktree_id: Id,
    pub pane_id: Option<Id>,
    pub action_id: Option<String>,
    pub pid: u32,
    pub process: String,
    pub protocol: RuntimeProtocol,
    pub host: String,
    pub port: u16,
    pub label: Option<String>,
    pub discovered_at_ms: u64,
}

// ---- evidence bundles: structured context sent to an existing agent session

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct Annotation {
    pub text: String,
    pub url: String,
    pub selector: Option<String>,
    pub element_text: Option<String>,
    /// x, y, width, height in CSS pixels.
    pub rect: Option<[f64; 4]>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct EvidenceBundle {
    pub source: String,
    pub worktree_id: Id,
    pub url: Option<String>,
    pub action_id: Option<String>,
    pub annotations: Vec<Annotation>,
    pub instruction: String,
    #[serde(default)]
    #[ts(optional)]
    pub markdown: Option<String>,
    #[serde(default)]
    #[ts(optional)]
    pub note_count: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct PullRequest {
    pub number: u64,
    pub title: String,
    pub url: String,
    pub state: String,
    pub draft: bool,
    pub review_decision: Option<String>,
    pub mergeable: Option<String>,
    pub checks_passed: u32,
    pub checks_failed: u32,
    pub checks_pending: u32,
    pub fetched_at_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct PrStatusResult {
    pub available: bool,
    pub reason: Option<String>,
    pub pr: Option<PullRequest>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct FsEntry {
    pub name: String,
    pub rel_path: String,
    pub is_dir: bool,
    pub size: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct SpawnResult {
    pub pane: Pane,
    pub tab: Tab,
    pub agent: Option<AgentPresence>,
}

/// The Core part of the `subscribe` snapshot.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct CoreSnapshot {
    pub status: Status,
    pub config: Config,
    pub repos: Vec<Repo>,
    pub worktrees: Vec<Worktree>,
    pub tabs: Vec<Tab>,
    pub panes: Vec<Pane>,
    pub agents: Vec<AgentPresence>,
    pub attention: Vec<AttentionItem>,
    pub resources: Vec<WorktreeResources>,
    #[serde(default)]
    pub endpoints: Vec<RuntimeEndpoint>,
    #[ts(type = "unknown")]
    pub ui_state: Value,
}

/// What `subscribe` returns: everything a client needs to render. Core builds `core`, and `tomod` `dispatch.rs` adds the addon fields. On the wire every field is top level.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct Snapshot {
    #[serde(flatten)]
    pub core: CoreSnapshot,
    #[serde(default)]
    pub usage: Vec<UsageSnapshot>,
    #[serde(default)]
    pub actions: Vec<ActionSet>,
}

pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn request_round_trips_with_tagged_method() {
        let req = Request { id: 7, call: Call::PaneResize { pane_id: "p".into(), cols: 80, rows: 24 } };
        let text = serde_json::to_string(&req).unwrap();
        assert!(text.contains("\"method\":\"pane_resize\""));
        let back: Request = serde_json::from_str(&text).unwrap();
        assert_eq!(back.id, 7);
    }

    #[test]
    fn metadata_patch_distinguishes_unset_from_clear() {
        let base = WorktreeMetadata { display_name: Some("a".into()), project: Some("p".into()), state: Some("active".into()), tags: vec!["x".into()] };
        let patch: MetadataPatch = serde_json::from_str(r#"{"project": null, "state": "merged"}"#).unwrap();
        let out = patch.apply(&base);
        assert_eq!(out.display_name.as_deref(), Some("a"));
        assert_eq!(out.project, None);
        assert_eq!(out.state.as_deref(), Some("merged"));
        assert_eq!(out.tags, vec!["x".to_string()]);
    }

    #[test]
    fn worktree_create_accepts_the_old_town_slug_field() {
        let old: WorktreeCreate = serde_json::from_str(r#"{"repo_id":"r","branch":"b","new_branch":true,"start_ref":null,"path":null,"town_slug":"aogashima"}"#).unwrap();
        let new: WorktreeCreate = serde_json::from_str(r#"{"repo_id":"r","branch":"b","new_branch":true,"start_ref":null,"path":null,"name_hint":"aogashima"}"#).unwrap();
        assert_eq!((old.name_hint.as_deref(), new.name_hint.as_deref()), (Some("aogashima"), Some("aogashima")));
    }

    #[test]
    fn frame_event_serializes_flat() {
        let f = Frame::Event { seq: 3, event: Event::AttentionCleared };
        let text = serde_json::to_string(&f).unwrap();
        assert_eq!(text, r#"{"seq":3,"event":"attention_cleared"}"#);
    }
}

#[cfg(test)]
mod bindings {
    use super::*;
    use std::path::Path;

    const HEADER: &str = "// GENERATED FROM tomo-proto. DO NOT EDIT.\n// Run: TOMO_WRITE_TYPES=1 cargo test -p tomo-proto\n\n";

    fn export_all(dir: &Path) {
        std::fs::create_dir_all(dir).unwrap();
        std::env::set_var("TS_RS_EXPORT_DIR", dir);
        let cfg = ts_rs::Config::from_env().with_large_int("number");
        Snapshot::export_all(&cfg).unwrap();
        Event::export_all(&cfg).unwrap();
        HookEvent::export_all(&cfg).unwrap();
        IntegrationStatus::export_all(&cfg).unwrap();
        ConfigIssue::export_all(&cfg).unwrap();
        PrStatusResult::export_all(&cfg).unwrap();
        Town::export_all(&cfg).unwrap();
        TownHistory::export_all(&cfg).unwrap();
        FsEntry::export_all(&cfg).unwrap();
        SpawnResult::export_all(&cfg).unwrap();
        MetadataPatch::export_all(&cfg).unwrap();
        WorktreeCreate::export_all(&cfg).unwrap();
        PaneCreate::export_all(&cfg).unwrap();
        AgentSpawn::export_all(&cfg).unwrap();
        AgentReport::export_all(&cfg).unwrap();
        RpcError::export_all(&cfg).unwrap();
        Hello::export_all(&cfg).unwrap();
        ArchiveResult::export_all(&cfg).unwrap();
        AgentSession::export_all(&cfg).unwrap();
        DropPlace::export_all(&cfg).unwrap();
        NotificationSettings::export_all(&cfg).unwrap();
        ThemeConfig::export_all(&cfg).unwrap();
        ActivityEvent::export_all(&cfg).unwrap();
        ActivityQuery::export_all(&cfg).unwrap();
        CoreActivity::export_all(&cfg).unwrap();
        ActionActivity::export_all(&cfg).unwrap();
        RuntimeActivity::export_all(&cfg).unwrap();
        GitHubActivity::export_all(&cfg).unwrap();
        AgentationActivity::export_all(&cfg).unwrap();
        CheckpointSpec::export_all(&cfg).unwrap();
        EvidenceBundle::export_all(&cfg).unwrap();
        UsageSnapshot::export_all(&cfg).unwrap();
        RuntimeEndpoint::export_all(&cfg).unwrap();
        ActionRunResult::export_all(&cfg).unwrap();
        CheckpointMode::export_all(&cfg).unwrap();
        Diagnostic::export_all(&cfg).unwrap();
        DiagnosticLevel::export_all(&cfg).unwrap();
        SystemStats::export_all(&cfg).unwrap();
        let mut names: Vec<String> = std::fs::read_dir(dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| n.ends_with(".ts") && n != "index.ts")
            .collect();
        names.sort();
        for name in &names {
            let path = dir.join(name);
            let body = std::fs::read_to_string(&path).unwrap();
            std::fs::write(&path, format!("{HEADER}{body}")).unwrap();
        }
        let index: String = names.iter().map(|n| format!("export * from \"./{}\";\n", n.trim_end_matches(".ts"))).collect();
        std::fs::write(dir.join("index.ts"), format!("{HEADER}{index}")).unwrap();
    }

    fn snapshot(dir: &Path) -> std::collections::BTreeMap<String, String> {
        std::fs::read_dir(dir)
            .map(|rd| {
                rd.filter_map(|e| e.ok())
                    .filter(|e| e.path().extension().map_or(false, |x| x == "ts"))
                    .map(|e| (e.file_name().to_string_lossy().into_owned(), std::fs::read_to_string(e.path()).unwrap_or_default()))
                    .collect()
            })
            .unwrap_or_default()
    }

    #[test]
    fn generated_typescript_bindings_are_fresh() {
        let target = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../app/src/generated");
        let tmp = std::env::temp_dir().join(format!("tomo-proto-bindings-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        export_all(&tmp);
        if std::env::var_os("TOMO_WRITE_TYPES").is_some() {
            let _ = std::fs::remove_dir_all(&target);
            std::fs::create_dir_all(&target).unwrap();
            for (name, body) in snapshot(&tmp) {
                std::fs::write(target.join(name), body).unwrap();
            }
        }
        let expected = snapshot(&tmp);
        let actual = snapshot(&target);
        let _ = std::fs::remove_dir_all(&tmp);
        assert_eq!(actual, expected, "app/src/generated is stale; run TOMO_WRITE_TYPES=1 cargo test -p tomo-proto");
    }
}

#[cfg(test)]
mod addon_activity_kinds {
    use super::*;

    #[test]
    fn addon_kinds_keep_their_stored_strings() {
        let kinds: Vec<ActivityKind> = vec![
            ActionActivity::Started.into(),
            ActionActivity::Stopped.into(),
            ActionActivity::Completed.into(),
            ActionActivity::Crashed.into(),
            RuntimeActivity::EndpointDiscovered.into(),
            GitHubActivity::PrMerged.into(),
            AgentationActivity::AnnotationsSent.into(),
        ];
        assert_eq!(
            kinds.iter().map(ActivityKind::as_str).collect::<Vec<_>>(),
            ["action_started", "action_stopped", "action_completed", "action_crashed", "endpoint_discovered", "pr_merged", "annotations_sent"]
        );
    }
}
