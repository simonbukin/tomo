//! Wire types shared by `tomod`, the `tomo` CLI, and the Tauri client.
//!
//! Transport: newline-delimited JSON over a Unix domain socket.
//! A client sends [`Request`] frames and receives [`Frame`] frames.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use std::path::PathBuf;

pub const PROTOCOL_VERSION: u32 = 1;

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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RpcError {
    pub code: ErrorCode,
    pub message: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    BadRequest,
    NotFound,
    Conflict,
    Git,
    Io,
    Unsupported,
    Internal,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "method", content = "params", rename_all = "snake_case")]
pub enum Call {
    Hello { protocol: u32, client: String },
    Status,
    Subscribe,
    ConfigGet,
    DaemonStop,
    IntegrationsInstall,

    RepoList,
    RepoAdd { path: PathBuf },
    RepoRemove { repo_id: Id },
    RepoClone { url: String, dest: PathBuf },

    WorktreeList,
    WorktreeRefresh,
    WorktreeCreate(WorktreeCreate),
    WorktreeOpen { worktree_id: Id },
    WorktreeResolve { path: PathBuf },
    MetadataGet { worktree_id: Id },
    MetadataSet { worktree_id: Id, patch: MetadataPatch },

    TabCreate { worktree_id: Id, title: Option<String> },
    TabClose { tab_id: Id, force: bool },
    TabRename { tab_id: Id, title: String },
    TabActivate { tab_id: Id },
    LayoutResize { tab_id: Id, split_id: Id, ratio: f64 },

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
    FsList { worktree_id: Id, rel_path: String },
    OpenExternal { worktree_id: Id, rel_path: String, target: ExternalTarget },

    UiStateGet,
    UiStateSet { state: Value },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorktreeCreate {
    pub repo_id: Id,
    pub branch: String,
    pub new_branch: bool,
    pub start_ref: Option<String>,
    pub path: Option<PathBuf>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct PaneCreate {
    pub worktree_id: Option<Id>,
    pub tab_id: Option<Id>,
    pub cwd: Option<PathBuf>,
    pub command: Option<Vec<String>>,
    pub title: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentSpawn {
    pub kind: AgentKind,
    pub worktree_id: Option<Id>,
    pub cwd: Option<PathBuf>,
    pub tab_id: Option<Id>,
    pub split_from: Option<Id>,
    pub resume: Option<String>,
    pub extra_args: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentReport {
    pub pane_id: Id,
    pub kind: AgentKind,
    pub state: Option<AgentState>,
    pub session_ref: Option<String>,
    pub authority: Authority,
    pub at_ms: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SplitDirection {
    Horizontal,
    Vertical,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExternalTarget {
    Finder,
    Editor,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "event", content = "data", rename_all = "snake_case")]
pub enum Event {
    ReposChanged { repos: Vec<Repo> },
    WorktreesChanged { worktrees: Vec<Worktree> },
    MetadataChanged { worktree_id: Id, metadata: WorktreeMetadata },
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
    Notice { level: NoticeLevel, message: String },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NoticeLevel {
    Info,
    Warning,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Hello {
    pub protocol: u32,
    pub version: String,
    pub daemon_pid: u32,
    pub session_id: Id,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
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

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Integrations {
    pub claude_hooks: bool,
    pub codex_hooks: bool,
    pub pi_extension: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Config {
    pub shell: String,
    pub editor_command: Vec<String>,
    pub worktree_parent_dir: Option<PathBuf>,
    pub resource_warning_bytes: u64,
    pub scrollback_lines: u32,
    pub font_family: String,
    pub font_size: u32,
    pub theme: String,
    pub keybindings: BTreeMap<String, String>,
    pub agents: BTreeMap<String, AgentCommand>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentCommand {
    pub command: String,
    pub args: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Repo {
    pub id: Id,
    pub path: PathBuf,
    pub name: String,
    pub exists: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
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
    pub tab_count: usize,
    pub pane_count: usize,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct GitSummary {
    pub branch: Option<String>,
    pub head: String,
    pub detached: bool,
    pub dirty: bool,
    pub files_changed: u32,
    pub untracked: u32,
    pub insertions: u32,
    pub deletions: u32,
    pub ahead: Option<u32>,
    pub behind: Option<u32>,
    pub upstream: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorktreeMetadata {
    pub display_name: Option<String>,
    pub project: Option<String>,
    pub priority: Option<u8>,
    #[serde(default)]
    pub tags: Vec<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct MetadataPatch {
    #[serde(default, with = "double_option")]
    pub display_name: Option<Option<String>>,
    #[serde(default, with = "double_option")]
    pub project: Option<Option<String>>,
    #[serde(default, with = "double_option")]
    pub priority: Option<Option<u8>>,
    #[serde(default)]
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
            priority: self.priority.unwrap_or(base.priority),
            tags: self.tags.clone().unwrap_or_else(|| base.tags.clone()),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Tab {
    pub id: Id,
    pub worktree_id: Id,
    pub title: String,
    pub position: i64,
    pub layout: LayoutNode,
    pub active_pane_id: Option<Id>,
    pub is_active: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum LayoutNode {
    Leaf { pane_id: Id },
    Split { id: Id, direction: SplitDirection, ratio: f64, first: Box<LayoutNode>, second: Box<LayoutNode> },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PaneOrigin {
    Live,
    Restored,
    Resumed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
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
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
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
}

/// Lower number = stronger authority. See PRD §14.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Authority {
    Lifecycle = 1,
    Report = 2,
    Screen = 3,
    Heuristic = 4,
    Unknown = 5,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Ownership {
    Owned,
    Observed,
    Unknown,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
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

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct WorktreeResources {
    pub worktree_id: Id,
    pub cpu_percent: f32,
    pub rss_bytes: u64,
    pub process_count: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AttentionLevel {
    Attention,
    Info,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AttentionItem {
    pub id: Id,
    pub worktree_id: Id,
    pub pane_id: Option<Id>,
    pub level: AttentionLevel,
    pub message: String,
    pub created_at_ms: u64,
    pub viewed_at_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FsEntry {
    pub name: String,
    pub rel_path: String,
    pub is_dir: bool,
    pub size: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SpawnResult {
    pub pane: Pane,
    pub tab: Tab,
    pub agent: Option<AgentPresence>,
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
        let base = WorktreeMetadata { display_name: Some("a".into()), project: Some("p".into()), priority: Some(2), tags: vec!["x".into()] };
        let patch: MetadataPatch = serde_json::from_str(r#"{"project": null, "priority": 1}"#).unwrap();
        let out = patch.apply(&base);
        assert_eq!(out.display_name.as_deref(), Some("a"));
        assert_eq!(out.project, None);
        assert_eq!(out.priority, Some(1));
        assert_eq!(out.tags, vec!["x".to_string()]);
    }

    #[test]
    fn frame_event_serializes_flat() {
        let f = Frame::Event { seq: 3, event: Event::AttentionCleared };
        let text = serde_json::to_string(&f).unwrap();
        assert_eq!(text, r#"{"seq":3,"event":"attention_cleared"}"#);
    }
}
