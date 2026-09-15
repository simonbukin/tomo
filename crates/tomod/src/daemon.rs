use crate::activity;
use crate::agents;
use crate::config::{self, Paths};
use crate::git;
use crate::layout;
use crate::procs::{self, ProcMonitor, ProcRow};
use crate::pty::{PtySession, Scrollback, Spawn};
use crate::events;
use crate::features::{actions, editor, reopen, sessions};
use crate::store::{MetaRow, PaneRow, Store, TabRow};
use anyhow::{anyhow, Result};
use base64::Engine;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};
use tokio::sync::mpsc;
use tomo_proto::*;

pub const VERSION: &str = env!("CARGO_PKG_VERSION");
const B64: base64::engine::GeneralPurpose = base64::engine::general_purpose::STANDARD;
const PI_EXTENSION_SOURCE: &str = include_str!("../../../integrations/pi/tomo-status.ts");

pub struct Client {
    pub tx: mpsc::UnboundedSender<String>,
    pub subscribed: bool,
    pub attached: HashSet<Id>,
}

#[derive(Debug, Clone)]
pub struct WorktreeState {
    pub id: Id,
    pub repo_id: Id,
    pub path: PathBuf,
    pub branch: Option<String>,
    pub head: String,
    pub detached: bool,
    pub is_main: bool,
    pub exists: bool,
    pub gitdir: Option<String>,
    pub git: Option<GitSummary>,
    pub metadata: WorktreeMetadata,
    pub last_active_ms: Option<u64>,
    pub first_seen_ms: Option<u64>,
    pub archived_at_ms: Option<u64>,
}

pub struct PaneState {
    pub row: PaneRow,
    pub pty: Option<Arc<PtySession>>,
    pub origin: PaneOrigin,
    pub exit_code: Option<i32>,
    pub process_title: Option<String>,
    pub process_cmd: Option<String>,
    pub pending_line: Option<String>,
    pub last_output_ms: u64,
    pub scrollback: Scrollback,
    /// Set when Tomo itself ends the pane's process, so the exit is a stop and not a crash.
    pub stop_intent: bool,
}

const DIAGNOSTICS_KEPT: usize = 200;

pub struct Inner {
    pub store: Store,
    pub config: Config,
    pub repos: Vec<Repo>,
    pub worktrees: HashMap<Id, WorktreeState>,
    pub tabs: HashMap<Id, TabRow>,
    pub panes: HashMap<Id, PaneState>,
    pub agents: HashMap<Id, AgentPresence>,
    pub clients: HashMap<u64, Client>,
    pub seq: u64,
    pub procs: ProcMonitor,
    pub proc_rows: Vec<ProcRow>,
    pub proc_rows_at_ms: u64,
    pub resources: Vec<WorktreeResources>,
    pub prs: HashMap<Id, PrStatusResult>,
    pub archiving: HashSet<Id>,
    pub hook_queue: Vec<HookEvent>,
    pub actions: HashMap<Id, ActionSet>,
    pub discovered_once: bool,
    pub last_full_poll_ms: u64,
    pub usage: Vec<UsageSnapshot>,
    pub endpoints: Vec<RuntimeEndpoint>,
    pub endpoint_gone_ms: HashMap<Id, u64>,
    pub endpoints_at_ms: u64,
    pub closed_tabs: Vec<reopen::ClosedTab>,
    pub diagnostics: std::collections::VecDeque<Diagnostic>,
    /// The current problem per `source:subject`, so a repeated poll records a diagnostic only on a change.
    pub problems: HashMap<String, String>,
}

/// Plain function lists that addons join at fixed points of Core operations. The composition root builds it once at startup.
pub struct Seams {
    /// Names the directory of a worktree created without a path, before `git worktree add`. An error refuses the create.
    pub worktree_namer: Option<fn(&Store, &WorktreeCreate) -> Result<Option<String>, RpcError>>,
    /// Runs under the state lock after `git worktree add` and discovery, before `worktree_create` returns.
    pub worktree_created: Vec<fn(&mut Inner, &CreatedWorktree) -> Result<(), RpcError>>,
    /// Runs under the state lock when a worktree gets a new id: a move on disk, or a restore at a new path.
    pub worktree_rebound: Vec<fn(&Store, &str, &str) -> Result<()>>,
}

pub struct CreatedWorktree {
    pub id: Id,
    pub repo_id: Id,
    /// What `worktree_namer` returned. `None` when the client gave a path or no namer exists.
    pub name: Option<String>,
}

pub struct Daemon {
    pub paths: Paths,
    pub session_id: Id,
    pub started_at_ms: u64,
    pub tomo_bin: PathBuf,
    pub inner: Mutex<Inner>,
    pub stop: tokio::sync::Notify,
    pub refresh: tokio::sync::Notify,
    pub repos_changed: tokio::sync::Notify,
    pub rt: tokio::runtime::Handle,
    pub seams: Seams,
}

pub fn err(code: ErrorCode, msg: impl Into<String>) -> RpcError {
    RpcError { code, message: msg.into() }
}

pub fn internal(e: anyhow::Error) -> RpcError {
    err(ErrorCode::Internal, e.to_string())
}

/// The diagnostic for a problem that goes from `before` to `after`. `None` means no problem.
pub fn problem_change(subject: &str, before: Option<&str>, after: Option<&str>) -> Option<(DiagnosticLevel, String)> {
    match (before, after) {
        (b, a) if b == a => None,
        (_, Some(p)) => Some((DiagnosticLevel::Warning, format!("{subject}: {p}"))),
        (Some(_), None) => Some((DiagnosticLevel::Info, format!("{subject}: ok again"))),
        (None, None) => None,
    }
}

pub(crate) fn new_id() -> Id {
    uuid::Uuid::new_v4().simple().to_string()[..12].to_string()
}

pub fn path_id(path: &Path) -> Id {
    uuid::Uuid::new_v5(&uuid::Uuid::NAMESPACE_URL, path.to_string_lossy().as_bytes()).simple().to_string()[..12].to_string()
}

fn canonical(path: &Path) -> PathBuf {
    std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

fn locate_tomo_bin() -> PathBuf {
    if let Ok(p) = std::env::var("TOMO_BIN") {
        return PathBuf::from(p);
    }
    if let Ok(exe) = std::env::current_exe() {
        let sibling = exe.with_file_name("tomo");
        if sibling.exists() {
            return sibling;
        }
    }
    std::env::var("PATH")
        .ok()
        .and_then(|path| std::env::split_paths(&path).map(|d| d.join("tomo")).find(|p| p.exists()))
        .unwrap_or_else(|| PathBuf::from("tomo"))
}

pub fn ok<T: serde::Serialize>(v: T) -> Result<Value, RpcError> {
    serde_json::to_value(v).map_err(|e| err(ErrorCode::Internal, e.to_string()))
}

impl Daemon {
    pub fn new(paths: Paths, seams: Seams) -> Result<Arc<Self>> {
        paths.ensure()?;
        let store = Store::open(&paths.db)?;
        let config = config::load(&paths.config)?;
        let daemon = Arc::new(Daemon {
            session_id: new_id(),
            started_at_ms: now_ms(),
            tomo_bin: locate_tomo_bin(),
            inner: Mutex::new(Inner {
                store,
                config,
                repos: Vec::new(),
                worktrees: HashMap::new(),
                tabs: HashMap::new(),
                panes: HashMap::new(),
                agents: HashMap::new(),
                clients: HashMap::new(),
                seq: 0,
                procs: ProcMonitor::new(),
                proc_rows: Vec::new(),
                proc_rows_at_ms: 0,
                resources: Vec::new(),
                prs: HashMap::new(),
                archiving: HashSet::new(),
                hook_queue: Vec::new(),
                actions: HashMap::new(),
                discovered_once: false,
                last_full_poll_ms: 0,
                usage: Vec::new(),
                endpoints: Vec::new(),
                endpoint_gone_ms: HashMap::new(),
                endpoints_at_ms: 0,
                closed_tabs: Vec::new(),
                diagnostics: std::collections::VecDeque::new(),
                problems: HashMap::new(),
            }),
            stop: tokio::sync::Notify::new(),
            refresh: tokio::sync::Notify::new(),
            repos_changed: tokio::sync::Notify::new(),
            rt: tokio::runtime::Handle::current(),
            seams,
            paths,
        });
        daemon.write_integration_files()?;
        Ok(daemon)
    }

    pub fn lock(&self) -> MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|p| p.into_inner())
    }

    pub fn claude_settings_path(&self) -> PathBuf {
        self.paths.integrations_dir.join("claude-hooks.json")
    }

    pub fn pi_extension_path(&self) -> PathBuf {
        self.paths.integrations_dir.join("tomo-status.ts")
    }

    fn write_integration_files(&self) -> Result<()> {
        let settings = agents::claude_hooks_settings(&self.tomo_bin);
        std::fs::write(self.claude_settings_path(), serde_json::to_string_pretty(&settings)?)?;
        std::fs::write(self.pi_extension_path(), PI_EXTENSION_SOURCE)?;
        Ok(())
    }

    pub fn integrations(&self) -> Integrations {
        let home = dirs::home_dir().unwrap_or_default();
        let has = |p: PathBuf, needle: &str| std::fs::read_to_string(p).map(|t| t.contains(needle)).unwrap_or(false);
        Integrations {
            claude_hooks: has(home.join(".claude/settings.json"), "hook claude"),
            codex_hooks: has(home.join(".codex/hooks.json"), "hook codex"),
            pi_extension: home.join(".pi/agent/extensions/tomo-status.ts").exists(),
        }
    }

    // ---------------------------------------------------------------- events

    pub fn emit(inner: &mut Inner, event: Event) {
        inner.seq += 1;
        let frame = Frame::Event { seq: inner.seq, event };
        let Ok(text) = serde_json::to_string(&frame) else { return };
        for client in inner.clients.values().filter(|c| c.subscribed) {
            let _ = client.tx.send(text.clone());
        }
    }

    /// Records what Tomo itself did or noticed and pushes it to clients. Work events go to `record`.
    pub fn diagnostic(inner: &mut Inner, level: DiagnosticLevel, source: &str, message: impl Into<String>) {
        let at_ms = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
        let diagnostic = Diagnostic { at_ms, level, source: source.to_string(), message: message.into() };
        if inner.diagnostics.len() >= DIAGNOSTICS_KEPT {
            inner.diagnostics.pop_front();
        }
        inner.diagnostics.push_back(diagnostic.clone());
        Self::emit(inner, Event::Diagnostic { diagnostic });
    }

    /// Records a diagnostic only when a subsystem problem appears, changes, or clears.
    /// Returns true when a new or different problem appeared.
    pub fn diagnostic_on_change(inner: &mut Inner, source: &str, subject: &str, problem: Option<String>) -> bool {
        let key = format!("{source}:{subject}");
        let change = problem_change(subject, inner.problems.get(&key).map(String::as_str), problem.as_deref());
        match problem {
            Some(p) => inner.problems.insert(key, p),
            None => inner.problems.remove(&key),
        };
        let Some((level, message)) = change else { return false };
        Self::diagnostic(inner, level, source, message);
        level == DiagnosticLevel::Warning
    }

    pub(crate) fn emit_tabs(inner: &mut Inner, worktree_id: &str) {
        for t in inner.tabs.values().filter(|t| t.worktree_id == worktree_id && !layout::is_valid(&t.layout)) {
            tracing::warn!("tab {} has an invalid layout: {:?}", t.id, t.layout);
        }
        let tabs = Self::tabs_of(inner, worktree_id);
        Self::emit(inner, Event::TabsChanged { worktree_id: worktree_id.to_string(), tabs });
    }

    pub(crate) fn emit_pane(inner: &mut Inner, pane_id: &str) {
        if let Some(pane) = Self::pane_view(inner, pane_id) {
            Self::emit(inner, Event::PaneChanged { pane });
        }
    }

    // ----------------------------------------------------------------- views

    pub fn repo_views(inner: &Inner) -> Vec<Repo> {
        inner.repos.clone()
    }

    pub fn worktree_view(inner: &Inner, w: &WorktreeState) -> Worktree {
        let name = w
            .metadata
            .display_name
            .clone()
            .filter(|n| !n.trim().is_empty())
            .unwrap_or_else(|| w.path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| w.path.to_string_lossy().into_owned()));
        let tab_count = inner.tabs.values().filter(|t| t.worktree_id == w.id).count();
        let pane_count = inner.panes.values().filter(|p| p.row.worktree_id == w.id).count();
        Worktree {
            id: w.id.clone(),
            repo_id: w.repo_id.clone(),
            path: w.path.clone(),
            name,
            branch: w.branch.clone(),
            head: w.head.clone(),
            detached: w.detached,
            is_main: w.is_main,
            exists: w.exists,
            git: w.git.clone(),
            metadata: w.metadata.clone(),
            last_active_ms: w.last_active_ms,
            first_seen_ms: w.first_seen_ms,
            archived_at_ms: w.archived_at_ms,
            archiving: inner.archiving.contains(&w.id),
            tab_count,
            pane_count,
        }
    }

    pub fn worktree_views(inner: &Inner) -> Vec<Worktree> {
        let mut list: Vec<Worktree> = inner.worktrees.values().map(|w| Self::worktree_view(inner, w)).collect();
        list.sort_by(|a, b| (&a.repo_id, !a.is_main, &a.path).cmp(&(&b.repo_id, !b.is_main, &b.path)));
        list
    }

    pub fn tab_view(_inner: &Inner, t: &TabRow) -> Tab {
        Tab {
            id: t.id.clone(),
            worktree_id: t.worktree_id.clone(),
            title: t.title.clone(),
            position: t.position,
            layout: t.layout.clone(),
            active_pane_id: t.active_pane_id.clone(),
            is_active: t.is_active,
        }
    }

    pub fn tabs_of(inner: &Inner, worktree_id: &str) -> Vec<Tab> {
        let mut tabs: Vec<Tab> = inner.tabs.values().filter(|t| t.worktree_id == worktree_id).map(|t| Self::tab_view(inner, t)).collect();
        tabs.sort_by_key(|t| t.position);
        tabs
    }

    pub fn all_tabs(inner: &Inner) -> Vec<Tab> {
        let mut tabs: Vec<Tab> = inner.tabs.values().map(|t| Self::tab_view(inner, t)).collect();
        tabs.sort_by(|a, b| (&a.worktree_id, a.position).cmp(&(&b.worktree_id, b.position)));
        tabs
    }

    pub fn pane_view(inner: &Inner, pane_id: &str) -> Option<Pane> {
        let p = inner.panes.get(pane_id)?;
        let agent = inner.agents.get(pane_id).cloned();
        let title = p
            .row
            .user_title
            .clone()
            .or_else(|| agent.as_ref().map(|a| a.kind.label().to_string()))
            .or_else(|| p.process_title.clone())
            .unwrap_or_else(|| Path::new(&inner.config.shell).file_name().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default());
        Some(Pane {
            id: p.row.id.clone(),
            tab_id: p.row.tab_id.clone(),
            worktree_id: p.row.worktree_id.clone(),
            title,
            user_title: p.row.user_title.clone(),
            cwd: p.row.cwd.clone(),
            cols: p.row.cols,
            rows: p.row.rows,
            pid: p.pty.as_ref().map(|x| x.pid),
            live: p.row.kind == PaneKind::Browser || (p.pty.is_some() && p.exit_code.is_none()),
            origin: p.origin,
            exit_code: p.exit_code,
            agent,
            created_at_ms: p.row.created_at_ms,
            action_id: p.row.action_id.clone(),
            process_cmd: p.process_cmd.clone(),
            kind: p.row.kind,
            url: p.row.url.clone(),
        })
    }

    pub fn pane_views(inner: &Inner, worktree_id: Option<&str>) -> Vec<Pane> {
        let mut panes: Vec<Pane> = inner
            .panes
            .keys()
            .filter_map(|id| Self::pane_view(inner, id))
            .filter(|p| worktree_id.map_or(true, |w| p.worktree_id == w))
            .collect();
        panes.sort_by_key(|p| p.created_at_ms);
        panes
    }

    pub fn status(&self, inner: &Inner) -> Status {
        Status {
            protocol: PROTOCOL_VERSION,
            version: VERSION.to_string(),
            daemon_pid: std::process::id(),
            session_id: self.session_id.clone(),
            started_at_ms: self.started_at_ms,
            socket_path: self.paths.socket.clone(),
            data_dir: self.paths.data_dir.clone(),
            repos: inner.repos.len(),
            worktrees: inner.worktrees.len(),
            panes: inner.panes.len(),
            live_panes: inner.panes.values().filter(|p| p.pty.is_some() && p.exit_code.is_none()).count(),
            agents: inner.agents.len(),
            clients: inner.clients.len(),
            integrations: self.integrations(),
        }
    }

    // ------------------------------------------------------------- discovery

    pub async fn discover(self: &Arc<Self>, summaries: Summaries) -> Result<()> {
        let rows = self.lock().store.repos()?;
        let mut repos: Vec<Repo> = Vec::with_capacity(rows.len());
        for r in rows {
            repos.push(repo_view(r.id, r.path).await);
        }
        let mut found: Vec<(Repo, Vec<git::WorktreeEntry>, PathBuf)> = Vec::new();
        for repo in &repos {
            if !repo.exists {
                continue;
            }
            match (git::list_worktrees(&repo.path).await, git::common_dir(&repo.path).await) {
                (Ok(entries), Ok(common)) => found.push((repo.clone(), entries, common)),
                (Err(e), _) | (_, Err(e)) => tracing::warn!("discover {}: {e}", repo.path.display()),
            }
        }
        let summaries = match summaries {
            Summaries::All => futures_summaries(&found).await,
            Summaries::Cached => HashMap::new(),
        };
        let mut inner = self.lock();
        let repos_changed = inner.repos.iter().map(|r| &r.path).ne(repos.iter().map(|r| &r.path));
        inner.repos = repos;
        if repos_changed {
            self.repos_changed.notify_one();
        }
        let meta_rows = inner.store.meta_all()?;
        let mut next: HashMap<Id, WorktreeState> = HashMap::new();
        for (repo, entries, common) in &found {
            let main_path = common.parent().map(Path::to_path_buf).unwrap_or_else(|| repo.path.clone());
            for entry in entries.iter().filter(|e| !e.bare) {
                let path = canonical(&entry.path);
                let id = path_id(&path);
                let gitdir = git::gitdir_name(&path);
                let existing = meta_rows.iter().find(|m| m.id == id).cloned().or_else(|| {
                    let moved = meta_rows.iter().find(|m| m.repo_id == repo.id && m.gitdir.is_some() && m.gitdir == gitdir && !m.path.exists())?;
                    self.rebind(&mut inner, &moved.id, &id, &path).ok()?;
                    Some(MetaRow { id: id.clone(), path: path.clone(), ..moved.clone() })
                });
                let previous = inner.worktrees.get(&id);
                let row = MetaRow {
                    id: id.clone(),
                    repo_id: repo.id.clone(),
                    path: path.clone(),
                    gitdir: gitdir.clone(),
                    metadata: existing.as_ref().map(|m| m.metadata.clone()).unwrap_or_default(),
                    last_active_ms: existing.as_ref().and_then(|m| m.last_active_ms),
                    first_seen_ms: existing.as_ref().and_then(|m| m.first_seen_ms).or(Some(now_ms())),
                    archived_at_ms: None,
                    archived_branch: None,
                };
                let needs_write = existing.as_ref().map_or(true, |m| m.path != path || m.gitdir != gitdir || m.repo_id != repo.id || m.first_seen_ms.is_none() || m.archived_at_ms.is_some());
                if needs_write {
                    inner.store.meta_upsert(&row)?;
                }
                next.insert(
                    id.clone(),
                    WorktreeState {
                        id: id.clone(),
                        repo_id: repo.id.clone(),
                        path: path.clone(),
                        branch: entry.branch.clone(),
                        head: entry.head.clone(),
                        detached: entry.detached,
                        is_main: canonical(&main_path) == path,
                        exists: path.exists() && !entry.prunable,
                        gitdir,
                        git: summaries.get(&path).cloned().or_else(|| previous.and_then(|p| p.git.clone())),
                        metadata: row.metadata,
                        last_active_ms: row.last_active_ms,
                        first_seen_ms: row.first_seen_ms,
                        archived_at_ms: None,
                    },
                );
            }
        }
        let runtime_ids: HashSet<Id> = inner.tabs.values().map(|t| t.worktree_id.clone()).collect();
        let orphans: Vec<MetaRow> = meta_rows
            .iter()
            .filter(|m| !next.contains_key(&m.id) && (runtime_ids.contains(&m.id) || (m.archived_at_ms.is_some() && !m.path.exists())))
            .cloned()
            .collect();
        for m in orphans.iter() {
            next.insert(
                m.id.clone(),
                WorktreeState {
                    id: m.id.clone(),
                    repo_id: m.repo_id.clone(),
                    path: m.path.clone(),
                    branch: m.archived_branch.clone(),
                    head: String::new(),
                    detached: false,
                    is_main: false,
                    exists: false,
                    gitdir: m.gitdir.clone(),
                    git: None,
                    metadata: m.metadata.clone(),
                    last_active_ms: m.last_active_ms,
                    first_seen_ms: m.first_seen_ms,
                    archived_at_ms: m.archived_at_ms,
                },
            );
        }
        let fresh: Vec<Id> = if inner.discovered_once { next.keys().filter(|id| !inner.worktrees.contains_key(*id)).cloned().collect() } else { Vec::new() };
        inner.worktrees = next;
        inner.discovered_once = true;
        for id in fresh {
            let ev = events::envelope(&inner, "worktree.discovered", Some(&id));
            inner.hook_queue.push(ev);
        }
        let repos = Self::repo_views(&inner);
        Self::emit(&mut inner, Event::ReposChanged { repos });
        let worktrees = Self::worktree_views(&inner);
        Self::emit(&mut inner, Event::WorktreesChanged { worktrees });
        drop(inner);
        self.reload_actions();
        self.flush_hooks();
        Ok(())
    }

    /// Re-reads every worktree's `.tomo.toml`. A malformed file never blocks
    /// the worktree: it yields an empty set plus one notice.
    pub fn reload_actions(self: &Arc<Self>) {
        let targets: Vec<(Id, PathBuf)> = self.lock().worktrees.values().filter(|w| w.exists).map(|w| (w.id.clone(), w.path.clone())).collect();
        let loaded: Vec<ActionSet> = targets.into_iter().map(|(id, path)| {
            let (actions, error) = actions::load(&path);
            ActionSet { worktree_id: id, actions, error }
        }).collect();
        let mut inner = self.lock();
        let live: HashSet<&Id> = loaded.iter().map(|s| &s.worktree_id).collect();
        inner.actions.retain(|id, _| live.contains(id));
        for set in loaded {
            let previous = inner.actions.get(&set.worktree_id);
            let changed = previous.map_or(true, |p| p.actions != set.actions || p.error != set.error);
            if !changed {
                continue;
            }
            let name = inner.worktrees.get(&set.worktree_id).map(|w| Self::worktree_view(&inner, w).name).unwrap_or_default();
            if Self::diagnostic_on_change(&mut inner, "config", &format!("{name} .tomo.toml"), set.error.clone()) {
                Self::emit(&mut inner, Event::Notice { level: NoticeLevel::Warning, message: format!("{name}: {}", set.error.as_deref().unwrap_or_default()) });
            }
            inner.actions.insert(set.worktree_id.clone(), set.clone());
            Self::emit(&mut inner, Event::ActionsChanged { set });
        }
    }

    fn action_def(inner: &Inner, worktree_id: &str, action_id: &str) -> Result<ActionDef, RpcError> {
        let set = inner.actions.get(worktree_id).ok_or_else(|| err(ErrorCode::NotFound, "worktree not found or has no .tomo.toml"))?;
        set.actions.iter().find(|a| a.id == action_id).cloned().ok_or_else(|| {
            let known: Vec<&str> = set.actions.iter().map(|a| a.id.as_str()).collect();
            err(ErrorCode::NotFound, format!("unknown action {action_id:?}; known actions: {}", known.join(", ")))
        })
    }

    fn running_action_pane(inner: &Inner, worktree_id: &str, action_id: &str) -> Option<Id> {
        inner.panes.values().find(|p| p.row.worktree_id == worktree_id && p.row.action_id.as_deref() == Some(action_id) && p.pty.is_some() && p.exit_code.is_none()).map(|p| p.row.id.clone())
    }

    pub fn hook_pane(inner: &Inner, pane_id: &str) -> Option<HookPane> {
        inner.panes.get(pane_id).map(|p| HookPane { id: p.row.id.clone(), tab_id: p.row.tab_id.clone(), cwd: p.row.cwd.clone() })
    }

    fn queue_action_event(inner: &mut Inner, event: &str, worktree_id: &str, action: &ActionDef, pane_id: Option<&str>) {
        let mut ev = events::envelope(inner, event, Some(worktree_id));
        ev.action = Some(HookAction { id: action.id.clone(), label: action.label.clone() });
        ev.pane = pane_id.and_then(|p| Self::hook_pane(inner, p));
        inner.hook_queue.push(ev);
    }

    fn record_action(inner: &mut Inner, kind: ActivityKind, worktree_id: &str, action: &ActionDef, pane_id: Option<&str>, verb: &str) {
        let mut ev = activity::event(kind, Some(worktree_id), format!("{} {verb}", action.label));
        ev.pane_id = pane_id.map(str::to_string);
        ev.payload = json!({ "action_id": action.id, "pane_id": pane_id });
        Self::record(inner, ev);
    }

    fn set_stop_intent(inner: &mut Inner, pane_id: &str) {
        if let Some(p) = inner.panes.get_mut(pane_id) {
            p.stop_intent = true;
        }
    }

    fn action_or_placeholder(inner: &Inner, worktree_id: &str, action_id: &str) -> ActionDef {
        Self::action_def(inner, worktree_id, action_id).unwrap_or_else(|_| ActionDef { id: action_id.to_string(), label: action_id.to_string(), command: String::new(), mode: ActionMode::Pane, show: ActionShow::Menu, shortcut: None })
    }

    fn focus_pane(inner: &mut Inner, pane_id: &str) {
        let Some((tab_id, worktree_id)) = inner.panes.get(pane_id).map(|p| (p.row.tab_id.clone(), p.row.worktree_id.clone())) else { return };
        let changed: Vec<TabRow> = inner
            .tabs
            .values_mut()
            .filter(|t| t.worktree_id == worktree_id)
            .filter_map(|t| {
                let active = t.id == tab_id;
                let next_pane = if active { Some(pane_id.to_string()) } else { t.active_pane_id.clone() };
                if t.is_active == active && t.active_pane_id == next_pane {
                    return None;
                }
                t.is_active = active;
                t.active_pane_id = next_pane;
                Some(t.clone())
            })
            .collect();
        for t in &changed {
            let _ = inner.store.tab_upsert(t);
        }
        if !changed.is_empty() {
            Self::emit_tabs(inner, &worktree_id);
        }
        Self::emit(inner, Event::FocusRequest { worktree_id, tab_id, pane_id: pane_id.to_string() });
    }

    fn run_action(self: &Arc<Self>, worktree_id: &str, action_id: &str) -> Result<ActionRunResult, RpcError> {
        let mut inner = self.lock();
        let action = Self::action_def(&inner, worktree_id, action_id)?;
        let w = inner.worktrees.get(worktree_id).filter(|w| w.exists).ok_or_else(|| err(ErrorCode::NotFound, "worktree not found"))?.clone();
        match action.mode {
            ActionMode::External => {
                let mut cmd = std::process::Command::new("sh");
                cmd.arg("-c").arg(&action.command).current_dir(&w.path);
                cmd.env("TOMO_WORKTREE_ID", worktree_id).env("TOMO_WORKTREE_PATH", &w.path).env("TOMO_SOCKET", &self.paths.socket).env("TOMO_BIN", &self.tomo_bin);
                cmd.stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null());
                cmd.spawn().map_err(|e| err(ErrorCode::Internal, format!("{}: {e}", action.command)))?;
                Self::queue_action_event(&mut inner, "action.started", worktree_id, &action, None);
                Self::record_action(&mut inner, ActivityKind::ActionStarted, worktree_id, &action, None, "started");
                Ok(ActionRunResult { action, pane: None, reused: false })
            }
            ActionMode::Pane => {
                if let Some(pane_id) = Self::running_action_pane(&inner, worktree_id, action_id) {
                    Self::focus_pane(&mut inner, &pane_id);
                    let pane = Self::pane_view(&inner, &pane_id);
                    return Ok(ActionRunResult { action, pane, reused: true });
                }
                let argv = [inner.config.shell.clone(), "-lc".into(), action.command.clone()];
                let (_, pane_id) = self.spawn_in_worktree(&mut inner, worktree_id, w.path.clone(), None, None, SplitDirection::Horizontal, Some(&argv), Some(action.label.clone()), None)?;
                if let Some(pane) = inner.panes.get_mut(&pane_id) {
                    pane.row.action_id = Some(action.id.clone());
                    let row = pane.row.clone();
                    let _ = inner.store.pane_upsert(&row);
                }
                Self::focus_pane(&mut inner, &pane_id);
                Self::emit_pane(&mut inner, &pane_id);
                Self::queue_action_event(&mut inner, "action.started", worktree_id, &action, Some(&pane_id));
                Self::record_action(&mut inner, ActivityKind::ActionStarted, worktree_id, &action, Some(&pane_id), "started");
                let pane = Self::pane_view(&inner, &pane_id);
                Ok(ActionRunResult { action, pane, reused: false })
            }
        }
    }

    fn stop_action(self: &Arc<Self>, worktree_id: &str, action_id: &str) -> Result<bool, RpcError> {
        let mut inner = self.lock();
        let action = Self::action_def(&inner, worktree_id, action_id)?;
        let Some(pane_id) = Self::running_action_pane(&inner, worktree_id, action_id) else { return Ok(false) };
        Self::set_stop_intent(&mut inner, &pane_id);
        Self::queue_action_event(&mut inner, "action.exited", worktree_id, &action, Some(&pane_id));
        Self::record_action(&mut inner, ActivityKind::ActionStopped, worktree_id, &action, Some(&pane_id), "stopped");
        if let Some(pid) = inner.panes.get(&pane_id).and_then(|p| p.pty.as_ref()).map(|p| p.pid) {
            for child in procs::descendants(&inner.proc_rows, pid) {
                procs::kill_tree(&inner.proc_rows, child);
            }
        }
        self.persist_scrollback(&inner, &pane_id);
        Self::remove_pane(&mut inner, &pane_id);
        Self::emit_tabs(&mut inner, worktree_id);
        Ok(true)
    }

    /// Dispatches hook events queued while the state lock was held.
    pub fn flush_hooks(self: &Arc<Self>) {
        let queued: Vec<HookEvent> = std::mem::take(&mut self.lock().hook_queue);
        for ev in queued {
            self.dispatch(ev);
        }
    }

    fn rebind(&self, inner: &mut Inner, old: &str, new: &str, path: &Path) -> Result<()> {
        inner.store.rebind_worktree(old, new, path)?;
        Self::rebind_runtime(inner, old, new);
        for seam in &self.seams.worktree_rebound {
            if let Err(e) = seam(&inner.store, old, new) {
                tracing::warn!("rebind {old} to {new}: {e}");
            }
        }
        Ok(())
    }

    fn rebind_runtime(inner: &mut Inner, old: &str, new: &str) {
        for t in inner.tabs.values_mut().filter(|t| t.worktree_id == old) {
            t.worktree_id = new.to_string();
        }
        for p in inner.panes.values_mut().filter(|p| p.row.worktree_id == old) {
            p.row.worktree_id = new.to_string();
        }
        for a in inner.agents.values_mut().filter(|a| a.worktree_id == old) {
            a.worktree_id = new.to_string();
        }
    }

    pub async fn refresh_git(self: &Arc<Self>, worktree_id: &str) -> Option<GitSummary> {
        let path = self.lock().worktrees.get(worktree_id)?.path.clone();
        let summary = git::summary(&path).await.ok()?;
        let mut inner = self.lock();
        let w = inner.worktrees.get_mut(worktree_id)?;
        let changed = w.git.as_ref() != Some(&summary);
        w.git = Some(summary.clone());
        w.branch = summary.branch.clone().or(w.branch.clone());
        if changed {
            let worktrees = Self::worktree_views(&inner);
            Self::emit(&mut inner, Event::WorktreesChanged { worktrees });
        }
        Some(summary)
    }

    pub fn resolve_worktree(inner: &Inner, path: &Path) -> Option<Id> {
        let path = canonical(path);
        inner
            .worktrees
            .values()
            .filter(|w| path.starts_with(&w.path))
            .max_by_key(|w| w.path.as_os_str().len())
            .map(|w| w.id.clone())
    }

    pub(crate) fn touch(inner: &mut Inner, worktree_id: &str) {
        let now = now_ms();
        if let Some(w) = inner.worktrees.get_mut(worktree_id) {
            w.last_active_ms = Some(now);
        }
        let _ = inner.store.meta_touch(worktree_id, now);
    }

    // ----------------------------------------------------------- tabs/panes

    fn pane_env(&self, inner: &Inner, pane_id: &str, tab_id: &str, worktree_id: &str) -> Vec<(String, String)> {
        let worktree_path = inner.worktrees.get(worktree_id).map(|w| w.path.to_string_lossy().into_owned()).unwrap_or_default();
        vec![
            ("TOMO_PANE_ID".into(), pane_id.into()),
            ("TOMO_TAB_ID".into(), tab_id.into()),
            ("TOMO_WORKTREE_ID".into(), worktree_id.into()),
            ("TOMO_WORKTREE_PATH".into(), worktree_path),
            ("TOMO_SESSION_ID".into(), self.session_id.clone()),
            ("TOMO_SOCKET".into(), self.paths.socket.to_string_lossy().into_owned()),
            ("TOMO_DATA_DIR".into(), self.paths.data_dir.to_string_lossy().into_owned()),
            ("TOMO_BIN".into(), self.tomo_bin.to_string_lossy().into_owned()),
            ("TERM".into(), "xterm-256color".into()),
            ("COLORTERM".into(), "truecolor".into()),
            ("TERM_PROGRAM".into(), "tomo".into()),
            ("PROMPT_EOL_MARK".into(), String::new()),
        ]
    }

    /// Variables that mark a process as nested inside another agent or Tomo pane.
    /// A shell started by Tomo must not inherit them from however tomod was launched.
    fn inherited_env_to_remove() -> Vec<String> {
        std::env::vars()
            .map(|(k, _)| k)
            .filter(|k| k == "CLAUDECODE" || k.starts_with("CLAUDE_CODE_") || k.starts_with("TOMO_") || k.starts_with("ORCA_") || k == "CODEX_THREAD_ID")
            .collect()
    }

    fn start_pty(self: &Arc<Self>, inner: &mut Inner, pane_id: &str, command: Option<&[String]>) -> Result<()> {
        let pane = inner.panes.get(pane_id).ok_or_else(|| anyhow!("pane missing"))?;
        let row = pane.row.clone();
        if row.kind == PaneKind::Browser {
            return Ok(());
        }
        let cwd = if row.cwd.is_dir() { row.cwd.clone() } else { dirs::home_dir().unwrap_or_else(|| PathBuf::from("/")) };
        let shell = inner.config.shell.clone();
        let (program, args): (String, Vec<String>) = match command {
            Some(argv) if !argv.is_empty() => (argv[0].clone(), argv[1..].to_vec()),
            _ => (shell, vec!["-l".to_string()]),
        };
        let env = self.pane_env(inner, pane_id, &row.tab_id, &row.worktree_id);
        let env_remove = Self::inherited_env_to_remove();
        let out_daemon = Arc::downgrade(self);
        let out_pane = pane_id.to_string();
        let sink: crate::pty::OutputSink = Arc::new(move |bytes: &[u8]| {
            if let Some(d) = out_daemon.upgrade() {
                d.on_output(&out_pane, bytes);
            }
        });
        let exit_daemon = Arc::downgrade(self);
        let exit_pane = pane_id.to_string();
        let on_exit: crate::pty::ExitSink = Box::new(move |code| {
            if let Some(d) = exit_daemon.upgrade() {
                let _runtime = d.rt.enter();
                d.on_exit(&exit_pane, code);
            }
        });
        let session = PtySession::spawn(
            Spawn { program: &program, args: &args, cwd: &cwd, env: &env, env_remove: &env_remove, cols: row.cols.max(2), rows: row.rows.max(2) },
            sink,
            on_exit,
        )?;
        let pane = inner.panes.get_mut(pane_id).ok_or_else(|| anyhow!("pane missing"))?;
        pane.pty = Some(Arc::new(session));
        pane.exit_code = None;
        if pane.pending_line.is_some() {
            self.type_pending_when_quiet(pane_id.to_string());
        }
        Ok(())
    }

    fn on_output(&self, pane_id: &str, bytes: &[u8]) {
        {
            let mut inner = self.lock();
            let Some(pane) = inner.panes.get_mut(pane_id) else { return };
            pane.scrollback.push(bytes);
            pane.last_output_ms = now_ms();
            let encoded = B64.encode(bytes);
            let frame = Frame::Event { seq: 0, event: Event::PaneOutput { pane_id: pane_id.to_string(), data_base64: encoded } };
            if let Ok(text) = serde_json::to_string(&frame) {
                for client in inner.clients.values().filter(|c| c.attached.contains(pane_id)) {
                    let _ = client.tx.send(text.clone());
                }
            }
        }
    }

    /// Types the queued command once the shell has produced output and then gone quiet,
    /// so the line lands after the prompt instead of inside shell start-up output.
    pub(crate) fn type_pending_when_quiet(self: &Arc<Self>, pane_id: String) {
        let daemon = self.clone();
        tokio::spawn(async move {
            let started = now_ms();
            loop {
                tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                let ready = {
                    let mut inner = daemon.lock();
                    let Some(pane) = inner.panes.get_mut(&pane_id) else { return };
                    if pane.pending_line.is_none() || pane.pty.is_none() {
                        return;
                    }
                    let quiet = pane.last_output_ms > 0 && now_ms().saturating_sub(pane.last_output_ms) >= 300;
                    let timeout = now_ms().saturating_sub(started) > 5000;
                    (quiet || timeout).then(|| (pane.pending_line.take().unwrap(), pane.pty.clone().unwrap()))
                };
                if let Some((line, pty)) = ready {
                    let _ = pty.write(format!("{line}\n").as_bytes());
                    return;
                }
            }
        });
    }

    fn on_exit(self: &Arc<Self>, pane_id: &str, code: Option<i32>) {
        let mut inner = self.lock();
        let Some(pane) = inner.panes.get_mut(pane_id) else { return };
        pane.exit_code = Some(code.unwrap_or(-1));
        let worktree_id = pane.row.worktree_id.clone();
        let action_id = pane.row.action_id.clone();
        let stop_intent = pane.stop_intent;
        Self::emit(&mut inner, Event::PaneExited { pane_id: pane_id.to_string(), exit_code: code });
        if let Some(aid) = action_id {
            let action = Self::action_or_placeholder(&inner, &worktree_id, &aid);
            Self::queue_action_event(&mut inner, "action.exited", &worktree_id, &action, Some(pane_id));
            match (code, stop_intent) {
                (Some(0), _) => Self::record_action(&mut inner, ActivityKind::ActionCompleted, &worktree_id, &action, Some(pane_id), "completed"),
                (_, true) => Self::record_action(&mut inner, ActivityKind::ActionStopped, &worktree_id, &action, Some(pane_id), "stopped"),
                (_, false) => Self::action_crashed(&mut inner, &worktree_id, &action, pane_id, code.unwrap_or(-1)),
            }
        }
        if let Some(agent) = inner.agents.get_mut(pane_id).filter(|a| a.state != AgentState::Exited) {
            let was_waiting = agent.state == AgentState::Waiting;
            agent.state = AgentState::Exited;
            agent.authority = Authority::Lifecycle;
            agent.updated_at_ms = now_ms();
            let agent = agent.clone();
            Self::emit(&mut inner, Event::AgentChanged { agent: agent.clone() });
            Self::record_agent(&mut inner, ActivityKind::AgentExited, &agent, "exited");
            if was_waiting {
                Self::resolve_waiting(&mut inner, pane_id);
            }
        }
        if code == Some(0) {
            let _ = Self::remove_pane(&mut inner, pane_id);
            Self::emit_tabs(&mut inner, &worktree_id);
        } else {
            Self::emit_pane(&mut inner, pane_id);
        }
        drop(inner);
        self.flush_hooks();
    }

    fn persist_scrollback(&self, inner: &Inner, pane_id: &str) {
        if let Some(pane) = inner.panes.get(pane_id) {
            let _ = std::fs::write(self.paths.scrollback_dir.join(format!("{pane_id}.bin")), pane.scrollback.snapshot());
        }
    }

    fn remove_pane(inner: &mut Inner, pane_id: &str) -> Option<PaneState> {
        let pane = inner.panes.remove(pane_id)?;
        let mut ev = events::envelope(inner, "pane.closed", Some(&pane.row.worktree_id));
        ev.pane = Some(HookPane { id: pane.row.id.clone(), tab_id: pane.row.tab_id.clone(), cwd: pane.row.cwd.clone() });
        inner.hook_queue.push(ev);
        if let Some(pty) = &pane.pty {
            pty.hangup();
        }
        if inner.agents.remove(pane_id).is_some_and(|a| a.state == AgentState::Waiting) {
            Self::resolve_waiting(inner, pane_id);
        }
        Self::emit(inner, Event::AgentRemoved { pane_id: pane_id.to_string() });
        let _ = inner.store.pane_delete(pane_id);
        let tab_id = pane.row.tab_id.clone();
        if let Some(tab) = inner.tabs.get_mut(&tab_id) {
            match layout::remove(&tab.layout, pane_id) {
                Some(next) => {
                    tab.layout = next;
                    if tab.active_pane_id.as_deref() == Some(pane_id) {
                        tab.active_pane_id = layout::pane_ids(&tab.layout).first().cloned();
                    }
                    let tab = tab.clone();
                    let _ = inner.store.tab_upsert(&tab);
                }
                None => {
                    let worktree_id = tab.worktree_id.clone();
                    let was_active = tab.is_active;
                    inner.tabs.remove(&tab_id);
                    let _ = inner.store.tab_delete(&tab_id);
                    if was_active {
                        let mut siblings: Vec<&mut TabRow> = inner.tabs.values_mut().filter(|t| t.worktree_id == worktree_id).collect();
                        siblings.sort_by_key(|t| t.position);
                        if let Some(first) = siblings.first_mut() {
                            first.is_active = true;
                            let first = first.clone();
                            let _ = inner.store.tab_upsert(&first);
                        }
                    }
                }
            }
        }
        Some(pane)
    }

    pub(crate) fn create_tab(inner: &mut Inner, worktree_id: &str, title: Option<String>) -> TabRow {
        let position = inner.tabs.values().filter(|t| t.worktree_id == worktree_id).map(|t| t.position).max().map_or(0, |p| p + 1);
        for t in inner.tabs.values_mut().filter(|t| t.worktree_id == worktree_id) {
            t.is_active = false;
        }
        let tab = TabRow {
            id: new_id(),
            worktree_id: worktree_id.to_string(),
            title: title.unwrap_or_else(|| format!("Tab {}", position + 1)),
            position,
            layout: LayoutNode::Leaf { pane_id: String::new() },
            active_pane_id: None,
            is_active: true,
        };
        inner.tabs.insert(tab.id.clone(), tab.clone());
        tab
    }

    /// Creates the pane row in memory and in the store, then starts its PTY.
    pub(crate) fn create_pane(
        self: &Arc<Self>,
        inner: &mut Inner,
        tab_id: &str,
        worktree_id: &str,
        cwd: PathBuf,
        command: Option<&[String]>,
        title: Option<String>,
        agent_kind: Option<AgentKind>,
        session_ref: Option<String>,
        pending_line: Option<String>,
        origin: PaneOrigin,
    ) -> Result<Id> {
        let id = new_id();
        let row = PaneRow {
            id: id.clone(),
            tab_id: tab_id.to_string(),
            worktree_id: worktree_id.to_string(),
            user_title: title,
            cwd,
            cols: 120,
            rows: 30,
            agent_kind,
            session_ref: session_ref.clone(),
            created_at_ms: now_ms(),
            action_id: None,
            kind: PaneKind::Terminal,
            url: None,
        };
        inner.store.pane_upsert(&row)?;
        inner.panes.insert(
            id.clone(),
            PaneState { row, pty: None, origin, exit_code: None, process_title: None, process_cmd: None, pending_line, last_output_ms: 0, scrollback: Scrollback::default(), stop_intent: false },
        );
        if let Some(kind) = agent_kind {
            let presence = AgentPresence {
                pane_id: id.clone(),
                worktree_id: worktree_id.to_string(),
                kind,
                state: AgentState::Unknown,
                session_ref,
                authority: Authority::Unknown,
                updated_at_ms: now_ms(),
                pid: None,
            };
            inner.agents.insert(id.clone(), presence.clone());
            Self::emit(inner, Event::AgentChanged { agent: presence.clone() });
            Self::record_agent(inner, ActivityKind::AgentStarted, &presence, "started");
        }
        if let Err(e) = self.start_pty(inner, &id, command) {
            inner.panes.remove(&id);
            inner.agents.remove(&id);
            let _ = inner.store.pane_delete(&id);
            return Err(e);
        }
        let mut ev = events::envelope(inner, "pane.created", Some(worktree_id));
        ev.pane = inner.panes.get(&id).map(|p| HookPane { id: p.row.id.clone(), tab_id: p.row.tab_id.clone(), cwd: p.row.cwd.clone() });
        inner.hook_queue.push(ev);
        Ok(id)
    }

    pub(crate) fn create_browser_pane(inner: &mut Inner, tab_id: &str, worktree_id: &str, cwd: PathBuf, url: String) -> Result<Id> {
        let id = new_id();
        let row = PaneRow {
            id: id.clone(),
            tab_id: tab_id.to_string(),
            worktree_id: worktree_id.to_string(),
            user_title: None,
            cwd,
            cols: 0,
            rows: 0,
            agent_kind: None,
            session_ref: None,
            created_at_ms: now_ms(),
            action_id: None,
            kind: PaneKind::Browser,
            url: Some(url),
        };
        inner.store.pane_upsert(&row)?;
        let hook_pane = HookPane { id: row.id.clone(), tab_id: row.tab_id.clone(), cwd: row.cwd.clone() };
        inner.panes.insert(
            id.clone(),
            PaneState { row, pty: None, origin: PaneOrigin::Live, exit_code: None, process_title: None, process_cmd: None, stop_intent: false, pending_line: None, last_output_ms: 0, scrollback: Scrollback::default() },
        );
        let mut ev = events::envelope(inner, "pane.created", Some(worktree_id));
        ev.pane = Some(hook_pane);
        inner.hook_queue.push(ev);
        Ok(id)
    }

    fn terminal_only(inner: &Inner, pane_id: &str) -> Result<(), RpcError> {
        match inner.panes.get(pane_id) {
            None => Err(err(ErrorCode::NotFound, "pane not found")),
            Some(p) if p.row.kind == PaneKind::Browser => Err(err(ErrorCode::BadRequest, "browser panes have no terminal")),
            Some(_) => Ok(()),
        }
    }

    fn place_pane(inner: &mut Inner, tab_id: &str, pane_id: &str, split_from: Option<&str>, direction: SplitDirection) {
        let Some(tab) = inner.tabs.get_mut(tab_id) else { return };
        let target = split_from.map(str::to_string).or_else(|| tab.active_pane_id.clone());
        tab.layout = match (&tab.layout, target) {
            (LayoutNode::Leaf { pane_id: p }, _) if p.is_empty() => layout::leaf(pane_id),
            (node, Some(t)) if layout::contains(node, &t) => layout::split(node, &t, direction, pane_id, &new_id()),
            (node, _) => {
                let last = layout::pane_ids(node).last().cloned().unwrap_or_default();
                layout::split(node, &last, direction, pane_id, &new_id())
            }
        };
        tab.active_pane_id = Some(pane_id.to_string());
        let tab = tab.clone();
        let _ = inner.store.tab_upsert(&tab);
    }

    fn worktree_for_spawn(inner: &Inner, worktree_id: Option<&str>, cwd: Option<&Path>) -> Result<(Id, PathBuf), RpcError> {
        if let Some(id) = worktree_id {
            let w = inner.worktrees.get(id).ok_or_else(|| err(ErrorCode::NotFound, format!("worktree {id} not found")))?;
            return Ok((w.id.clone(), cwd.map(Path::to_path_buf).unwrap_or_else(|| w.path.clone())));
        }
        let cwd = cwd.ok_or_else(|| err(ErrorCode::BadRequest, "worktree_id or cwd required"))?;
        let id = Self::resolve_worktree(inner, cwd).ok_or_else(|| err(ErrorCode::NotFound, format!("{} is not inside a known worktree", cwd.display())))?;
        Ok((id, cwd.to_path_buf()))
    }

    fn active_tab(inner: &Inner, worktree_id: &str) -> Option<Id> {
        let mut tabs: Vec<&TabRow> = inner.tabs.values().filter(|t| t.worktree_id == worktree_id).collect();
        tabs.sort_by_key(|t| (!t.is_active, t.position));
        tabs.first().map(|t| t.id.clone())
    }

    pub(crate) fn spawn_in_worktree(
        self: &Arc<Self>,
        inner: &mut Inner,
        worktree_id: &str,
        cwd: PathBuf,
        tab_id: Option<&str>,
        split_from: Option<&str>,
        direction: SplitDirection,
        command: Option<&[String]>,
        title: Option<String>,
        agent: Option<(AgentKind, Option<String>, String)>,
    ) -> Result<(Id, Id), RpcError> {
        let crowded = |inner: &Inner, t: &str| inner.tabs.get(t).map_or(false, |tab| layout::pane_ids(&tab.layout).len() >= inner.config.max_panes_per_tab as usize);
        let tab_id = match tab_id.map(str::to_string).or_else(|| split_from.and_then(|p| inner.panes.get(p)).map(|p| p.row.tab_id.clone())).or_else(|| Self::active_tab(inner, worktree_id)) {
            Some(t) if inner.tabs.contains_key(&t) && !(tab_id.is_none() && split_from.is_none() && crowded(inner, &t)) => t,
            _ => Self::create_tab(inner, worktree_id, None).id,
        };
        let (kind, session_ref, pending) = match agent {
            Some((k, s, line)) => (Some(k), s, Some(line)),
            None => (None, None, None),
        };
        let pane_id = self.create_pane(inner, &tab_id, worktree_id, cwd, command, title, kind, session_ref, pending, PaneOrigin::Live).map_err(internal)?;
        Self::place_pane(inner, &tab_id, &pane_id, split_from, direction);
        Self::touch(inner, worktree_id);
        Self::emit_tabs(inner, worktree_id);
        Self::emit_pane(inner, &pane_id);
        Ok((tab_id, pane_id))
    }

    fn pane_has_children(inner: &Inner, pane_id: &str) -> bool {
        let Some(pid) = inner.panes.get(pane_id).and_then(|p| p.pty.as_ref()).map(|p| p.pid) else { return false };
        !procs::descendants(&inner.proc_rows, pid).is_empty()
    }

    // ------------------------------------------------------------- restore

    pub fn restore(self: &Arc<Self>) -> Result<()> {
        let mut inner = self.lock();
        let tabs = inner.store.tabs()?;
        let panes = inner.store.panes()?;
        let referenced: HashSet<Id> = tabs.iter().flat_map(|t| layout::pane_ids(&t.layout)).collect();
        for t in &tabs {
            inner.tabs.insert(t.id.clone(), t.clone());
        }
        for mut row in panes {
            if !referenced.contains(&row.id) {
                let _ = inner.store.pane_delete(&row.id);
                continue;
            }
            if row.action_id.take().is_some() {
                let _ = inner.store.pane_upsert(&row);
            }
            let resume_ref = row.session_ref.clone().or_else(|| (row.agent_kind == Some(AgentKind::Codex)).then(|| "--last".to_string()));
            let (origin, pending) = match (row.agent_kind, resume_ref.as_deref()) {
                (Some(kind), Some(session)) => {
                    let cmd = inner.config.agents.get(kind.label().to_lowercase().as_str()).cloned().unwrap_or(AgentCommand { command: kind.label().to_lowercase(), args: vec![] });
                    let plan = agents::spawn_plan(kind, &cmd, Some(session), &self.claude_settings_path(), &self.pi_extension_path(), &[]);
                    (PaneOrigin::Resumed, Some(agents::shell_line(&plan.argv)))
                }
                _ => (PaneOrigin::Restored, None),
            };
            let scrollback = std::fs::read(self.paths.scrollback_dir.join(format!("{}.bin", row.id))).map(Scrollback::from_bytes).unwrap_or_default();
            let mut scrollback = scrollback;
            scrollback.push(b"\r\n\x1b[2m[tomo] daemon restarted: output above is from the previous session\x1b[0m\r\n");
            if let Some(kind) = row.agent_kind {
                let _ = inner.store.attention_resolve_waiting(&row.id, now_ms());
                inner.agents.insert(
                    row.id.clone(),
                    AgentPresence {
                        pane_id: row.id.clone(),
                        worktree_id: row.worktree_id.clone(),
                        kind,
                        state: AgentState::Unknown,
                        session_ref: row.session_ref.clone(),
                        authority: Authority::Unknown,
                        updated_at_ms: now_ms(),
                        pid: None,
                    },
                );
            }
            inner.panes.insert(
                row.id.clone(),
                PaneState { row: row.clone(), pty: None, origin, exit_code: None, process_title: None, process_cmd: None, pending_line: pending, last_output_ms: 0, scrollback, stop_intent: false },
            );
            if let Err(e) = self.start_pty(&mut inner, &row.id, None) {
                tracing::warn!("restore pane {}: {e}", row.id);
            }
        }
        let empty_tabs: Vec<Id> = inner.tabs.values().filter(|t| layout::pane_ids(&t.layout).iter().all(|p| !inner.panes.contains_key(p))).map(|t| t.id.clone()).collect();
        for id in empty_tabs {
            inner.tabs.remove(&id);
            let _ = inner.store.tab_delete(&id);
        }
        let fixups: Vec<TabRow> = inner
            .tabs
            .values()
            .filter_map(|t| {
                let missing: Vec<Id> = layout::pane_ids(&t.layout).into_iter().filter(|p| !inner.panes.contains_key(p)).collect();
                if missing.is_empty() {
                    return None;
                }
                let layout = missing.iter().try_fold(t.layout.clone(), |l, p| layout::remove(&l, p))?;
                Some(TabRow { layout, ..t.clone() })
            })
            .collect();
        for t in fixups {
            let _ = inner.store.tab_upsert(&t);
            inner.tabs.insert(t.id.clone(), t);
        }
        let _ = inner.store.attention_prune(200);
        Ok(())
    }

    /// Hangs up every pane. A daemon stop is never a crash, so every pane carries stop intent first.
    pub fn shutdown(&self) {
        let mut inner = self.lock();
        for pane in inner.panes.values_mut() {
            pane.stop_intent = true;
        }
        for id in inner.panes.keys() {
            self.persist_scrollback(&inner, id);
        }
        for pane in inner.panes.values() {
            if let Some(pty) = &pane.pty {
                pty.hangup();
            }
        }
    }

    // -------------------------------------------------------------- agents

    pub fn apply_report(inner: &mut Inner, report: &AgentReport, pid: Option<u32>) {
        let Some(worktree_id) = inner.panes.get(&report.pane_id).map(|p| p.row.worktree_id.clone()) else { return };
        let pid = pid.or_else(|| inner.agents.get(&report.pane_id).and_then(|a| a.pid));
        let previous = inner.agents.get(&report.pane_id).map(|a| a.state);
        let Some(next) = agents::merge(inner.agents.get(&report.pane_id), report, &worktree_id, pid) else { return };
        if let Some(pane) = inner.panes.get_mut(&report.pane_id) {
            if pane.row.session_ref != next.session_ref || pane.row.agent_kind != Some(next.kind) {
                pane.row.session_ref = next.session_ref.clone();
                pane.row.agent_kind = Some(next.kind);
                let row = pane.row.clone();
                let _ = inner.store.pane_upsert(&row);
            }
        }
        inner.agents.insert(report.pane_id.clone(), next.clone());
        Self::emit(inner, Event::AgentChanged { agent: next.clone() });
        Self::emit_pane(inner, &report.pane_id);
        if previous.is_none() {
            Self::record_agent(inner, ActivityKind::AgentStarted, &next, "started");
        }
        if previous != Some(next.state) && next.state != AgentState::Unknown {
            let name = if previous.is_none() { "agent.started".to_string() } else { format!("agent.{}", next.state.name()) };
            let mut ev = events::envelope(inner, &name, Some(&worktree_id));
            ev.pane = inner.panes.get(&report.pane_id).map(|p| HookPane { id: p.row.id.clone(), tab_id: p.row.tab_id.clone(), cwd: p.row.cwd.clone() });
            ev.agent = Some(HookAgent { kind: next.kind, state: next.state, session_ref: next.session_ref.clone() });
            inner.hook_queue.push(ev);
        }
        if next.state == AgentState::Waiting && previous != Some(AgentState::Waiting) {
            let attention_id = Self::add_attention(inner, &worktree_id, Some(&report.pane_id), AttentionLevel::Attention, format!("{} is waiting for you", next.kind.label()));
            let repeat = Self::recorded_recently(inner, ActivityKind::AgentWaiting, activity::WAITING_REPEAT_MS, |a| a.pane_id.as_deref() == Some(&report.pane_id));
            if !repeat {
                let mut ev = Self::agent_event(ActivityKind::AgentWaiting, &next, "is waiting for you");
                ev.attention_id = attention_id;
                Self::record(inner, ev);
            }
        }
        if next.state == AgentState::Exited && previous != Some(AgentState::Exited) {
            Self::record_agent(inner, ActivityKind::AgentExited, &next, "exited");
        }
        if next.state != AgentState::Waiting && previous == Some(AgentState::Waiting) {
            Self::resolve_waiting(inner, &report.pane_id);
        }
    }

    fn resolve_waiting(inner: &mut Inner, pane_id: &str) {
        for id in inner.store.attention_resolve_waiting(pane_id, now_ms()).unwrap_or_default() {
            Self::emit(inner, Event::AttentionResolved { id });
        }
    }

    fn add_attention(inner: &mut Inner, worktree_id: &str, pane_id: Option<&str>, level: AttentionLevel, message: String) -> Option<Id> {
        let duplicate = inner
            .store
            .attention_list()
            .unwrap_or_default()
            .iter()
            .any(|a| a.viewed_at_ms.is_none() && a.pane_id.as_deref() == pane_id && pane_id.is_some() && a.message == message);
        if duplicate {
            return None;
        }
        let item = AttentionItem {
            id: new_id(),
            worktree_id: worktree_id.to_string(),
            pane_id: pane_id.map(str::to_string),
            level,
            message,
            created_at_ms: now_ms(),
            viewed_at_ms: None,
            kind: AttentionKind::Waiting,
            url: None,
            agent_kind: pane_id.and_then(|p| inner.agents.get(p)).map(|a| a.kind),
            resolved_at_ms: None,
        };
        let id = item.id.clone();
        Self::push_attention(inner, item);
        Some(id)
    }

    fn push_attention(inner: &mut Inner, item: AttentionItem) {
        let _ = inner.store.attention_insert(&item);
        let mut ev = events::envelope(inner, "attention.created", Some(&item.worktree_id));
        ev.attention = Some(item.clone());
        ev.pane = item.pane_id.as_deref().and_then(|p| Self::hook_pane(inner, p));
        inner.hook_queue.push(ev);
        Self::emit(inner, Event::AttentionAdded { item });
    }

    fn action_crashed(inner: &mut Inner, worktree_id: &str, action: &ActionDef, pane_id: &str, exit_code: i32) {
        let item = AttentionItem {
            id: new_id(),
            worktree_id: worktree_id.to_string(),
            pane_id: Some(pane_id.to_string()),
            level: AttentionLevel::Attention,
            message: format!("{} exited with code {exit_code}", action.label),
            created_at_ms: now_ms(),
            viewed_at_ms: None,
            kind: AttentionKind::Crash,
            url: None,
            agent_kind: None,
            resolved_at_ms: None,
        };
        Self::push_attention(inner, item.clone());
        let mut hook = events::envelope(inner, "action.crashed", Some(worktree_id));
        hook.action = Some(HookAction { id: action.id.clone(), label: action.label.clone() });
        hook.pane = Self::hook_pane(inner, pane_id);
        hook.attention = Some(item.clone());
        inner.hook_queue.push(hook);
        let mut ev = activity::event(ActivityKind::ActionCrashed, Some(worktree_id), format!("{} crashed", action.label));
        ev.pane_id = Some(pane_id.to_string());
        ev.detail = Some(format!("exit code {exit_code}"));
        ev.payload = json!({ "action_id": action.id, "exit_code": exit_code, "pane_id": pane_id });
        ev.attention_id = Some(item.id);
        Self::record(inner, ev);
    }

    fn agent_event(kind: ActivityKind, agent: &AgentPresence, verb: &str) -> ActivityEvent {
        let mut ev = activity::event(kind, Some(&agent.worktree_id), format!("{} {verb}", agent.kind.label()));
        ev.pane_id = Some(agent.pane_id.clone());
        ev.agent_kind = Some(agent.kind);
        ev.payload = json!({ "session_ref": agent.session_ref });
        ev
    }

    fn record_agent(inner: &mut Inner, kind: ActivityKind, agent: &AgentPresence, verb: &str) {
        Self::record(inner, Self::agent_event(kind, agent, verb));
    }

    fn worktree_name(inner: &Inner, worktree_id: &str) -> String {
        inner.worktrees.get(worktree_id).map(|w| Self::worktree_view(inner, w).name).unwrap_or_else(|| worktree_id.to_string())
    }

    pub fn meta_row_of(inner: &Inner, w: &WorktreeState, metadata: WorktreeMetadata) -> MetaRow {
        let archived_branch = inner.store.meta_all().unwrap_or_default().into_iter().find(|m| m.id == w.id).and_then(|m| m.archived_branch);
        MetaRow {
            id: w.id.clone(),
            repo_id: w.repo_id.clone(),
            path: w.path.clone(),
            gitdir: w.gitdir.clone(),
            metadata,
            last_active_ms: w.last_active_ms,
            first_seen_ms: w.first_seen_ms,
            archived_at_ms: w.archived_at_ms,
            archived_branch,
        }
    }

    fn close_worktree_panes(inner: &mut Inner, worktree_id: &str) {
        let tab_ids: Vec<Id> = inner.tabs.values().filter(|t| t.worktree_id == worktree_id).map(|t| t.id.clone()).collect();
        for tab_id in tab_ids {
            let panes = inner.tabs.get(&tab_id).map(|t| layout::pane_ids(&t.layout)).unwrap_or_default();
            for pane_id in panes {
                Self::set_stop_intent(inner, &pane_id);
                if let Some(pid) = inner.panes.get(&pane_id).and_then(|p| p.pty.as_ref()).map(|p| p.pid) {
                    for child in procs::descendants(&inner.proc_rows, pid) {
                        procs::kill_tree(&inner.proc_rows, child);
                    }
                }
                Self::remove_pane(inner, &pane_id);
            }
            inner.tabs.remove(&tab_id);
            let _ = inner.store.tab_delete(&tab_id);
        }
        Self::emit_tabs(inner, worktree_id);
    }

    fn remove_cleanup_dirs(path: &Path, names: &[String]) -> Vec<String> {
        names.iter().filter(|n| path.join(n).is_dir()).filter(|n| std::fs::remove_dir_all(path.join(n)).is_ok()).cloned().collect()
    }

    /// Makes every non-ignored change recoverable from the branch before the tree goes away.
    async fn archive_checkpoint(path: &Path, mode: CheckpointMode) -> Result<Option<String>, RpcError> {
        if mode == CheckpointMode::Discard {
            return Ok(None);
        }
        let s = git::summary(path).await.map_err(|e| err(ErrorCode::Git, e.to_string()))?;
        if s.detached {
            return Err(err(ErrorCode::Conflict, "worktree is on a detached HEAD; check out a branch first, or archive with --discard"));
        }
        if s.conflicts > 0 {
            return Err(err(ErrorCode::Conflict, format!("worktree has {} unresolved conflicts; resolve them first, or archive with --discard", s.conflicts)));
        }
        if !s.dirty {
            return Ok(None);
        }
        if mode == CheckpointMode::RequireClean {
            return Err(err(ErrorCode::Conflict, "worktree has uncommitted changes; commit them, archive without --no-checkpoint, or use --discard"));
        }
        git::checkpoint(path, "tomo: archive checkpoint").await.map_err(|e| err(ErrorCode::Git, format!("checkpoint commit failed: {e}")))
    }

    async fn archive_worktree(self: &Arc<Self>, worktree_id: &str, checkpoint: CheckpointMode) -> Result<Value, RpcError> {
        let (path, repo_path, branch, event, head) = {
            let mut inner = self.lock();
            let w = inner.worktrees.get(worktree_id).ok_or_else(|| err(ErrorCode::NotFound, "worktree not found"))?.clone();
            if w.is_main {
                return Err(err(ErrorCode::BadRequest, "the main worktree cannot be archived"));
            }
            if w.archived_at_ms.is_some() {
                return Err(err(ErrorCode::Conflict, "worktree is already archived"));
            }
            if !inner.archiving.insert(worktree_id.to_string()) {
                return Err(err(ErrorCode::Conflict, "worktree is already being archived"));
            }
            let repo_path = inner.repos.iter().find(|r| r.id == w.repo_id).map(|r| r.path.clone()).ok_or_else(|| err(ErrorCode::NotFound, "repo not found"))?;
            Self::emit(&mut inner, Event::WorktreeArchiving { worktree_id: worktree_id.to_string() });
            let worktrees = Self::worktree_views(&inner);
            Self::emit(&mut inner, Event::WorktreesChanged { worktrees });
            let event = events::envelope(&inner, "worktree.before_archive", Some(worktree_id));
            (w.path.clone(), repo_path, w.branch.clone().unwrap_or_default(), event, w.head.clone())
        };
        let result = self.archive_steps(worktree_id, &path, &repo_path, &branch, event, checkpoint).await;
        let mut inner = self.lock();
        inner.archiving.remove(worktree_id);
        match result {
            Ok(result) => {
                let ev = events::envelope(&inner, "worktree.archived", Some(worktree_id));
                inner.hook_queue.push(ev);
                let title = format!("{} archived", Self::worktree_name(&inner, worktree_id));
                let mut ev = activity::event(ActivityKind::Archived, Some(worktree_id), title);
                ev.detail = result.checkpoint_commit.as_ref().map(|c| format!("checkpoint {}", &c[..c.len().min(7)]));
                ev.payload = json!({ "branch": result.branch, "checkpoint_commit": result.checkpoint_commit, "head": head });
                Self::record(&mut inner, ev);
                let worktrees = Self::worktree_views(&inner);
                Self::emit(&mut inner, Event::WorktreesChanged { worktrees });
                drop(inner);
                self.flush_hooks();
                ok(result)
            }
            Err(e) => {
                let worktrees = Self::worktree_views(&inner);
                Self::emit(&mut inner, Event::WorktreesChanged { worktrees });
                Err(e)
            }
        }
    }

    async fn archive_steps(self: &Arc<Self>, worktree_id: &str, path: &Path, repo_path: &Path, branch: &str, event: HookEvent, checkpoint: CheckpointMode) -> Result<ArchiveResult, RpcError> {
        if let Err(run) = self.gate(event).await {
            return Err(err(ErrorCode::Aborted, format!("before_archive hook refused ({}): {}", run.command, run.output_tail.lines().last().unwrap_or(""))));
        }
        let checkpoint_commit = Self::archive_checkpoint(path, checkpoint).await?;
        {
            let mut inner = self.lock();
            Self::close_worktree_panes(&mut inner, worktree_id);
        }
        let cleanup = self.lock().config.archive_cleanup.clone();
        let dir = path.to_path_buf();
        let removed = tokio::task::spawn_blocking(move || Self::remove_cleanup_dirs(&dir, &cleanup)).await.unwrap_or_default();
        git::worktree_remove(repo_path, path).await.map_err(|e| err(ErrorCode::Git, e.to_string()))?;
        {
            let inner = self.lock();
            let Some(w) = inner.worktrees.get(worktree_id).cloned() else { return Err(err(ErrorCode::NotFound, "worktree not found")) };
            let mut row = Self::meta_row_of(&inner, &w, w.metadata.clone());
            row.archived_at_ms = Some(now_ms());
            row.archived_branch = (!branch.is_empty()).then(|| branch.to_string());
            inner.store.meta_upsert(&row).map_err(internal)?;
        }
        self.discover(Summaries::Cached).await.map_err(internal)?;
        Ok(ArchiveResult { worktree_id: worktree_id.to_string(), branch: (!branch.is_empty()).then(|| branch.to_string()), checkpoint_commit, cleanup_removed: removed })
    }

    async fn restore_worktree(self: &Arc<Self>, worktree_id: &str) -> Result<Value, RpcError> {
        let (path, repo_path, branch, row) = {
            let inner = self.lock();
            let w = inner.worktrees.get(worktree_id).ok_or_else(|| err(ErrorCode::NotFound, "worktree not found"))?;
            let row = Self::meta_row_of(&inner, w, w.metadata.clone());
            let branch = row.archived_branch.clone().ok_or_else(|| err(ErrorCode::BadRequest, "worktree is not archived or has no branch to restore"))?;
            let repo_path = inner.repos.iter().find(|r| r.id == w.repo_id).map(|r| r.path.clone()).ok_or_else(|| err(ErrorCode::NotFound, "repo not found"))?;
            (w.path.clone(), repo_path, branch, row)
        };
        if !git::branch_exists(&repo_path, &branch).await {
            return Err(err(ErrorCode::Git, format!("branch {branch} no longer exists; create the worktree again from another ref")));
        }
        let path = if path.parent().map_or(false, |p| p.is_dir()) {
            path
        } else {
            let parent = self.lock().config.worktree_parent_dir.clone().unwrap_or_else(|| repo_path.parent().unwrap_or(&repo_path).to_path_buf());
            parent.join(path.file_name().map(|n| n.to_os_string()).unwrap_or_default())
        };
        git::worktree_add(&repo_path, &path, &branch, false, None).await.map_err(|e| err(ErrorCode::Git, e.to_string()))?;
        let id = path_id(&canonical(&path));
        {
            let mut inner = self.lock();
            inner.store.meta_upsert(&MetaRow { archived_at_ms: None, archived_branch: None, path: path.clone(), ..row }).map_err(internal)?;
            if id != worktree_id {
                if let Err(e) = self.rebind(&mut inner, worktree_id, &id, &canonical(&path)) {
                    tracing::warn!("restore {worktree_id}: rebind to {id}: {e}");
                }
            }
        }
        self.discover(Summaries::Cached).await.map_err(internal)?;
        let mut inner = self.lock();
        let ev = events::envelope(&inner, "worktree.restored", Some(&id));
        inner.hook_queue.push(ev);
        let title = format!("{} restored", Self::worktree_name(&inner, &id));
        let mut ev = activity::event(ActivityKind::Restored, Some(&id), title);
        ev.payload = json!({ "branch": branch });
        Self::record(&mut inner, ev);
        let view = inner.worktrees.get(&id).map(|w| Self::worktree_view(&inner, w));
        drop(inner);
        self.flush_hooks();
        view.ok_or_else(|| err(ErrorCode::Internal, "restored worktree not discovered")).and_then(ok)
    }

    // ------------------------------------------------------------ dispatch

    pub async fn handle(self: &Arc<Self>, client_id: u64, call: Call) -> Result<Value, RpcError> {
        let result = self.handle_inner(client_id, call).await;
        self.flush_hooks();
        result
    }

    async fn handle_inner(self: &Arc<Self>, client_id: u64, call: Call) -> Result<Value, RpcError> {
        match call {
            Call::Hello { protocol, client } => {
                if protocol != PROTOCOL_VERSION {
                    return Err(err(ErrorCode::Unsupported, format!("protocol {protocol} unsupported; daemon speaks {PROTOCOL_VERSION}")));
                }
                tracing::info!("client {client_id} hello from {client}");
                ok(Hello { protocol: PROTOCOL_VERSION, version: VERSION.into(), daemon_pid: std::process::id(), session_id: self.session_id.clone() })
            }
            Call::Status => {
                let inner = self.lock();
                ok(self.status(&inner))
            }
            Call::Subscribe => {
                tracing::info!("client {client_id} subscribed");
                let mut inner = self.lock();
                if let Some(c) = inner.clients.get_mut(&client_id) {
                    c.subscribed = true;
                }
                let attention = inner.store.attention_list().map_err(internal)?;
                let ui_state = inner.store.kv_get("ui_state").map_err(internal)?.and_then(|s| serde_json::from_str::<Value>(&s).ok()).unwrap_or(Value::Null);
                ok(Snapshot {
                    status: self.status(&inner),
                    config: inner.config.clone(),
                    repos: Self::repo_views(&inner),
                    worktrees: Self::worktree_views(&inner),
                    tabs: Self::all_tabs(&inner),
                    panes: Self::pane_views(&inner, None),
                    agents: inner.agents.values().cloned().collect(),
                    attention,
                    resources: inner.resources.clone(),
                    actions: inner.actions.values().cloned().collect(),
                    endpoints: inner.endpoints.clone(),
                    usage: inner.usage.clone(),
                    ui_state,
                })
            }
            Call::ConfigGet => {
                let cfg = config::load(&self.paths.config).map_err(internal)?;
                self.lock().config = cfg.clone();
                ok(cfg)
            }
            Call::DaemonStop => {
                self.stop.notify_one();
                Ok(Value::Null)
            }
            Call::IntegrationsInstall => {
                crate::integrations::install(&self.tomo_bin, PI_EXTENSION_SOURCE).map_err(internal)?;
                ok(self.integrations())
            }
            Call::IntegrationsStatus => {
                let mut inner = self.lock();
                let list = crate::integrations::status(&inner.config);
                crate::integrations::record_health(&mut inner, &list);
                ok(list)
            }
            Call::ConfigCheck => {
                let (cfg, parse_issues) = config::load_checked(&self.paths.config).map_err(internal)?;
                ok([parse_issues, config::check(&cfg)].concat())
            }
            Call::ConfigSet { key, value } => ok(crate::settings::set(self, &key, &value)?),
            Call::ConfigOpen => crate::settings::open(self).map(|_| Value::Null),
            Call::HookLog { limit } => ok(events::read_log(&self.paths.hook_log, limit.unwrap_or(50))),
            Call::LayoutEqualize { tab_id } => {
                let mut inner = self.lock();
                let tab = inner.tabs.get_mut(&tab_id).ok_or_else(|| err(ErrorCode::NotFound, "tab not found"))?;
                tab.layout = layout::equalize(&tab.layout);
                let tab = tab.clone();
                inner.store.tab_upsert(&tab).map_err(internal)?;
                Self::emit_tabs(&mut inner, &tab.worktree_id);
                ok(Self::tab_view(&inner, &tab))
            }
            Call::LayoutRotate { tab_id, split_id } => {
                let mut inner = self.lock();
                let tab = inner.tabs.get_mut(&tab_id).ok_or_else(|| err(ErrorCode::NotFound, "tab not found"))?;
                let target = split_id.or_else(|| tab.active_pane_id.as_deref().and_then(|p| layout::split_of(&tab.layout, p))).ok_or_else(|| err(ErrorCode::BadRequest, "tab has no split to rotate"))?;
                tab.layout = layout::rotate(&tab.layout, &target);
                let tab = tab.clone();
                inner.store.tab_upsert(&tab).map_err(internal)?;
                Self::emit_tabs(&mut inner, &tab.worktree_id);
                ok(Self::tab_view(&inner, &tab))
            }
            Call::PaneSwap { pane_a, pane_b } => {
                let mut inner = self.lock();
                let tab_id = inner.panes.get(&pane_a).map(|p| p.row.tab_id.clone()).ok_or_else(|| err(ErrorCode::NotFound, "pane not found"))?;
                if inner.panes.get(&pane_b).map(|p| &p.row.tab_id) != Some(&tab_id) {
                    return Err(err(ErrorCode::BadRequest, "panes must be in the same tab"));
                }
                let tab = inner.tabs.get_mut(&tab_id).ok_or_else(|| err(ErrorCode::NotFound, "tab not found"))?;
                tab.layout = layout::swap(&tab.layout, &pane_a, &pane_b);
                let tab = tab.clone();
                inner.store.tab_upsert(&tab).map_err(internal)?;
                Self::emit_tabs(&mut inner, &tab.worktree_id);
                ok(Self::tab_view(&inner, &tab))
            }
            Call::PaneZoom { pane_id, tab_id } => {
                let mut inner = self.lock();
                let tab_id = match (&pane_id, tab_id) {
                    (Some(p), _) => inner.panes.get(p).map(|x| x.row.tab_id.clone()).ok_or_else(|| err(ErrorCode::NotFound, "pane not found"))?,
                    (None, Some(t)) => t,
                    (None, None) => return Err(err(ErrorCode::BadRequest, "pane_id or tab_id required")),
                };
                Self::emit(&mut inner, Event::ZoomRequest { tab_id, pane_id });
                Ok(Value::Null)
            }

            Call::RepoList => ok(Self::repo_views(&self.lock())),
            Call::RepoAdd { path } => {
                let top = git::toplevel(&config::expand_tilde(&path)).await.map_err(|e| err(ErrorCode::Git, e.to_string()))?;
                let top = canonical(&top);
                let id = path_id(&top);
                self.lock().store.repo_add(&id, &top, now_ms()).map_err(internal)?;
                self.discover(Summaries::All).await.map_err(internal)?;
                ok(repo_view(id, top).await)
            }
            Call::RepoRemove { repo_id } => {
                {
                    let mut inner = self.lock();
                    inner.store.repo_remove(&repo_id).map_err(internal)?;
                    let orphaned: Vec<Id> = inner.worktrees.values().filter(|w| w.repo_id == repo_id).map(|w| w.id.clone()).collect();
                    for id in orphaned {
                        let has_runtime = inner.tabs.values().any(|t| t.worktree_id == id);
                        if !has_runtime {
                            inner.worktrees.remove(&id);
                        }
                    }
                }
                self.discover(Summaries::All).await.map_err(internal)?;
                Ok(Value::Null)
            }
            Call::RepoClone { url, dest } => {
                let dest = config::expand_tilde(&dest);
                git::clone(&url, &dest).await.map_err(|e| err(ErrorCode::Git, e.to_string()))?;
                let id = path_id(&canonical(&dest));
                self.lock().store.repo_add(&id, &canonical(&dest), now_ms()).map_err(internal)?;
                self.discover(Summaries::All).await.map_err(internal)?;
                ok(repo_view(id, canonical(&dest)).await)
            }

            Call::WorktreeList => ok(Self::worktree_views(&self.lock())),
            Call::WorktreeRefresh => {
                self.discover(Summaries::All).await.map_err(internal)?;
                ok(Self::worktree_views(&self.lock()))
            }
            Call::WorktreeCreate(spec) => {
                let (repo_path, parent_dir, name) = {
                    let inner = self.lock();
                    let repo = inner.repos.iter().find(|r| r.id == spec.repo_id).ok_or_else(|| err(ErrorCode::NotFound, "repo not found"))?;
                    let name = match (&spec.path, self.seams.worktree_namer) {
                        (None, Some(namer)) => namer(&inner.store, &spec)?,
                        _ => None,
                    };
                    (repo.path.clone(), inner.config.worktree_parent_dir.clone(), name)
                };
                let parent = parent_dir.unwrap_or_else(|| repo_path.parent().unwrap_or(&repo_path).to_path_buf());
                let path = match (&spec.path, &name) {
                    (Some(p), _) => config::expand_tilde(p),
                    (None, Some(name)) => parent.join(name),
                    (None, None) => parent.join(spec.branch.replace('/', "-")),
                };
                git::worktree_add(&repo_path, &path, &spec.branch, spec.new_branch, spec.start_ref.as_deref())
                    .await
                    .map_err(|e| err(ErrorCode::Git, e.to_string()))?;
                self.discover(Summaries::All).await.map_err(internal)?;
                let id = path_id(&canonical(&path));
                let mut inner = self.lock();
                let created = CreatedWorktree { id: id.clone(), repo_id: spec.repo_id.clone(), name };
                for seam in &self.seams.worktree_created {
                    seam(&mut inner, &created)?;
                }
                let ev = events::envelope(&inner, "worktree.created", Some(&id));
                inner.hook_queue.push(ev);
                inner.worktrees.get(&id).map(|w| Self::worktree_view(&inner, w)).ok_or_else(|| err(ErrorCode::Internal, "worktree created but not discovered")).and_then(ok)
            }
            Call::WorktreeArchive { worktree_id, checkpoint } => self.archive_worktree(&worktree_id, checkpoint).await,
            Call::ActionList { worktree_id } => {
                let inner = self.lock();
                if !inner.worktrees.contains_key(&worktree_id) {
                    return Err(err(ErrorCode::NotFound, "worktree not found"));
                }
                ok(inner.actions.get(&worktree_id).cloned().unwrap_or(ActionSet { worktree_id, actions: vec![], error: None }))
            }
            Call::ActionRun { worktree_id, action_id } => self.run_action(&worktree_id, &action_id).and_then(ok),
            Call::ActionStop { worktree_id, action_id } => {
                self.stop_action(&worktree_id, &action_id)?;
                Ok(Value::Null)
            }
            Call::ActionRestart { worktree_id, action_id } => {
                self.stop_action(&worktree_id, &action_id)?;
                self.run_action(&worktree_id, &action_id).and_then(ok)
            }
            Call::WorktreeRestore { worktree_id } => self.restore_worktree(&worktree_id).await,
            Call::WorktreeOpen { worktree_id } => {
                let needs_pane = {
                    let inner = self.lock();
                    if !inner.worktrees.contains_key(&worktree_id) {
                        return Err(err(ErrorCode::NotFound, "worktree not found"));
                    }
                    !inner.tabs.values().any(|t| t.worktree_id == worktree_id)
                };
                let mut inner = self.lock();
                if needs_pane {
                    let cwd = inner.worktrees[&worktree_id].path.clone();
                    self.spawn_in_worktree(&mut inner, &worktree_id, cwd, None, None, SplitDirection::Horizontal, None, None, None)?;
                }
                Self::touch(&mut inner, &worktree_id);
                let w = Self::worktree_view(&inner, &inner.worktrees[&worktree_id]);
                let tabs = Self::tabs_of(&inner, &worktree_id);
                let handle = self.clone();
                let id = worktree_id.clone();
                tokio::spawn(async move {
                    handle.refresh_git(&id).await;
                });
                Ok(json!({ "worktree": w, "tabs": tabs }))
            }
            Call::WorktreeResolve { path } => {
                let inner = self.lock();
                let id = Self::resolve_worktree(&inner, &path).ok_or_else(|| err(ErrorCode::NotFound, format!("{} is not inside a known worktree", path.display())))?;
                ok(Self::worktree_view(&inner, &inner.worktrees[&id]))
            }
            Call::MetadataGet { worktree_id } => {
                let inner = self.lock();
                inner.worktrees.get(&worktree_id).map(|w| w.metadata.clone()).ok_or_else(|| err(ErrorCode::NotFound, "worktree not found")).and_then(ok)
            }
            Call::MetadataSet { worktree_id, patch } => {
                let mut inner = self.lock();
                let w = inner.worktrees.get(&worktree_id).ok_or_else(|| err(ErrorCode::NotFound, "worktree not found"))?;
                let mut next = patch.apply(&w.metadata);
                next.display_name = next.display_name.map(|n| n.trim().to_string()).filter(|n| !n.is_empty());
                next.project = next.project.map(|n| n.trim().to_string()).filter(|n| !n.is_empty());
                next.tags = next.tags.into_iter().map(|t| t.trim().trim_start_matches('#').to_string()).filter(|t| !t.is_empty()).collect();
                next.state = next.state.map(|st| st.trim().to_string()).filter(|st| !st.is_empty());
                if let Some(st) = &next.state {
                    if !inner.config.states.iter().any(|d| &d.id == st) {
                        let known: Vec<&str> = inner.config.states.iter().map(|d| d.id.as_str()).collect();
                        return Err(err(ErrorCode::BadRequest, format!("unknown state {st:?}; known states: {}", known.join(", "))));
                    }
                }
                let previous_state = w.metadata.state.clone();
                let row = Self::meta_row_of(&inner, w, next.clone());
                inner.store.meta_upsert(&row).map_err(internal)?;
                inner.worktrees.get_mut(&worktree_id).unwrap().metadata = next.clone();
                if previous_state != next.state {
                    let mut ev = events::envelope(&inner, "worktree.state_changed", Some(&worktree_id));
                    ev.previous_state = previous_state.clone();
                    inner.hook_queue.push(ev);
                    let mut ev = activity::event(ActivityKind::StateChanged, Some(&worktree_id), format!("state → {}", next.state.as_deref().unwrap_or("none")));
                    ev.detail = Some(Self::worktree_name(&inner, &worktree_id));
                    ev.payload = json!({ "state": next.state, "previous_state": previous_state });
                    Self::record(&mut inner, ev);
                }
                Self::emit(&mut inner, Event::MetadataChanged { worktree_id: worktree_id.clone(), metadata: next.clone() });
                let worktrees = Self::worktree_views(&inner);
                Self::emit(&mut inner, Event::WorktreesChanged { worktrees });
                ok(next)
            }

            Call::TabCreate { worktree_id, title } => {
                let mut inner = self.lock();
                let cwd = inner.worktrees.get(&worktree_id).ok_or_else(|| err(ErrorCode::NotFound, "worktree not found"))?.path.clone();
                let tab = Self::create_tab(&mut inner, &worktree_id, title);
                for t in inner.tabs.values().filter(|t| t.worktree_id == worktree_id && t.id != tab.id).cloned().collect::<Vec<_>>() {
                    let _ = inner.store.tab_upsert(&t);
                }
                self.spawn_in_worktree(&mut inner, &worktree_id, cwd, Some(&tab.id), None, SplitDirection::Horizontal, None, None, None)?;
                ok(Self::tab_view(&inner, &inner.tabs[&tab.id]))
            }
            Call::TabClose { tab_id, force } => {
                let mut inner = self.lock();
                let tab = inner.tabs.get(&tab_id).ok_or_else(|| err(ErrorCode::NotFound, "tab not found"))?.clone();
                let panes = layout::pane_ids(&tab.layout);
                if !force && panes.iter().any(|p| Self::pane_has_children(&inner, p)) {
                    return Err(err(ErrorCode::Conflict, "tab has running processes"));
                }
                reopen::remember(&mut inner, &tab);
                for p in &panes {
                    Self::set_stop_intent(&mut inner, p);
                    self.persist_scrollback(&inner, p);
                    Self::remove_pane(&mut inner, p);
                }
                inner.tabs.remove(&tab_id);
                let _ = inner.store.tab_delete(&tab_id);
                Self::emit_tabs(&mut inner, &tab.worktree_id);
                Ok(Value::Null)
            }
            Call::TabRename { tab_id, title } => {
                let mut inner = self.lock();
                let tab = inner.tabs.get_mut(&tab_id).ok_or_else(|| err(ErrorCode::NotFound, "tab not found"))?;
                tab.title = title;
                let tab = tab.clone();
                inner.store.tab_upsert(&tab).map_err(internal)?;
                Self::emit_tabs(&mut inner, &tab.worktree_id);
                ok(Self::tab_view(&inner, &tab))
            }
            Call::TabReopen { worktree_id } => {
                let mut inner = self.lock();
                if !inner.worktrees.get(&worktree_id).is_some_and(|w| w.exists) {
                    return Err(err(ErrorCode::NotFound, "worktree not found"));
                }
                let tab_id = self.reopen_tab(&mut inner, &worktree_id).map_err(internal)?.ok_or_else(|| err(ErrorCode::NotFound, "no closed tab to reopen"))?;
                ok(Self::tab_view(&inner, &inner.tabs[&tab_id]))
            }
            Call::TabMove { tab_id, position } => {
                let mut inner = self.lock();
                let worktree_id = crate::moves::move_tab(&mut inner, &tab_id, position)?;
                Self::emit_tabs(&mut inner, &worktree_id);
                ok(Self::tabs_of(&inner, &worktree_id))
            }
            Call::PaneMove { pane_id, target_pane_id, tab_id, place } => {
                let mut inner = self.lock();
                let moved = crate::moves::move_pane(&mut inner, &pane_id, target_pane_id.as_deref(), tab_id.as_deref(), place)?;
                Self::emit_tabs(&mut inner, &moved.worktree_id);
                for p in &moved.panes {
                    Self::emit_pane(&mut inner, p);
                }
                ok(Self::tabs_of(&inner, &moved.worktree_id))
            }
            Call::PaneTail { pane_id, lines } => {
                let inner = self.lock();
                let pane = inner.panes.get(&pane_id).ok_or_else(|| err(ErrorCode::NotFound, "pane not found"))?;
                ok(pane.scrollback.plain_tail(lines.unwrap_or(8).clamp(1, 200) as usize))
            }
            Call::TabActivate { tab_id } => {
                let mut inner = self.lock();
                let worktree_id = inner.tabs.get(&tab_id).ok_or_else(|| err(ErrorCode::NotFound, "tab not found"))?.worktree_id.clone();
                let changed: Vec<TabRow> = inner
                    .tabs
                    .values_mut()
                    .filter(|t| t.worktree_id == worktree_id && t.is_active != (t.id == tab_id))
                    .map(|t| {
                        t.is_active = t.id == tab_id;
                        t.clone()
                    })
                    .collect();
                for t in &changed {
                    let _ = inner.store.tab_upsert(t);
                }
                if !changed.is_empty() {
                    Self::emit_tabs(&mut inner, &worktree_id);
                }
                Ok(Value::Null)
            }
            Call::LayoutResize { tab_id, split_id, ratio } => {
                let mut inner = self.lock();
                let tab = inner.tabs.get_mut(&tab_id).ok_or_else(|| err(ErrorCode::NotFound, "tab not found"))?;
                tab.layout = layout::resize(&tab.layout, &split_id, ratio);
                let tab = tab.clone();
                inner.store.tab_upsert(&tab).map_err(internal)?;
                Self::emit_tabs(&mut inner, &tab.worktree_id);
                Ok(Value::Null)
            }

            Call::PaneList { worktree_id } => ok(Self::pane_views(&self.lock(), worktree_id.as_deref())),
            Call::PaneCreate(spec) => {
                let mut inner = self.lock();
                let (worktree_id, cwd) = Self::worktree_for_spawn(&inner, spec.worktree_id.as_deref(), spec.cwd.as_deref())?;
                let (tab_id, pane_id) = self.spawn_in_worktree(&mut inner, &worktree_id, cwd, spec.tab_id.as_deref(), None, SplitDirection::Horizontal, spec.command.as_deref(), spec.title, None)?;
                ok(json!({ "pane": Self::pane_view(&inner, &pane_id), "tab": Self::tab_view(&inner, &inner.tabs[&tab_id]) }))
            }
            Call::PaneSplit { pane_id, direction, command } => {
                let mut inner = self.lock();
                let (worktree_id, cwd) = {
                    let p = inner.panes.get(&pane_id).ok_or_else(|| err(ErrorCode::NotFound, "pane not found"))?;
                    (p.row.worktree_id.clone(), p.row.cwd.clone())
                };
                let (tab_id, new_id) = self.spawn_in_worktree(&mut inner, &worktree_id, cwd, None, Some(&pane_id), direction, command.as_deref(), None, None)?;
                ok(json!({ "pane": Self::pane_view(&inner, &new_id), "tab": Self::tab_view(&inner, &inner.tabs[&tab_id]) }))
            }
            Call::PaneClose { pane_id, force } => {
                let mut inner = self.lock();
                let worktree_id = inner.panes.get(&pane_id).ok_or_else(|| err(ErrorCode::NotFound, "pane not found"))?.row.worktree_id.clone();
                if !force && Self::pane_has_children(&inner, &pane_id) {
                    return Err(err(ErrorCode::Conflict, "pane has running processes"));
                }
                reopen::remember_if_last(&mut inner, &pane_id);
                Self::set_stop_intent(&mut inner, &pane_id);
                self.persist_scrollback(&inner, &pane_id);
                Self::remove_pane(&mut inner, &pane_id);
                Self::emit_tabs(&mut inner, &worktree_id);
                Ok(Value::Null)
            }
            Call::PaneFocus { pane_id } => {
                let mut inner = self.lock();
                let (tab_id, worktree_id) = {
                    let p = inner.panes.get(&pane_id).ok_or_else(|| err(ErrorCode::NotFound, "pane not found"))?;
                    (p.row.tab_id.clone(), p.row.worktree_id.clone())
                };
                let changed: Vec<TabRow> = inner
                    .tabs
                    .values_mut()
                    .filter(|t| t.worktree_id == worktree_id)
                    .filter_map(|t| {
                        let active = t.id == tab_id;
                        let next_pane = if active { Some(pane_id.clone()) } else { t.active_pane_id.clone() };
                        if t.is_active == active && t.active_pane_id == next_pane {
                            return None;
                        }
                        t.is_active = active;
                        t.active_pane_id = next_pane;
                        Some(t.clone())
                    })
                    .collect();
                for t in &changed {
                    let _ = inner.store.tab_upsert(t);
                }
                Self::touch(&mut inner, &worktree_id);
                for id in inner.store.attention_view_pane(&pane_id, now_ms()).unwrap_or_default() {
                    Self::emit(&mut inner, Event::AttentionViewed { id });
                }
                if !changed.is_empty() {
                    Self::emit_tabs(&mut inner, &worktree_id);
                }
                Self::emit(&mut inner, Event::FocusRequest { worktree_id, tab_id, pane_id });
                Ok(Value::Null)
            }
            Call::PaneRename { pane_id, title } => {
                let mut inner = self.lock();
                let pane = inner.panes.get_mut(&pane_id).ok_or_else(|| err(ErrorCode::NotFound, "pane not found"))?;
                pane.row.user_title = title.filter(|t| !t.trim().is_empty());
                let row = pane.row.clone();
                inner.store.pane_upsert(&row).map_err(internal)?;
                Self::emit_pane(&mut inner, &pane_id);
                Ok(Value::Null)
            }
            Call::PaneSend { pane_id, data_base64 } => {
                let data = B64.decode(data_base64).map_err(|e| err(ErrorCode::BadRequest, e.to_string()))?;
                Self::terminal_only(&self.lock(), &pane_id)?;
                let pty = self.lock().panes.get(&pane_id).and_then(|p| p.pty.clone()).ok_or_else(|| err(ErrorCode::NotFound, "pane not live"))?;
                pty.write(&data).map_err(internal)?;
                Ok(Value::Null)
            }
            Call::PaneResize { pane_id, cols, rows } => {
                let mut inner = self.lock();
                Self::terminal_only(&inner, &pane_id)?;
                let pane = inner.panes.get_mut(&pane_id).ok_or_else(|| err(ErrorCode::NotFound, "pane not found"))?;
                if pane.row.cols != cols || pane.row.rows != rows {
                    pane.row.cols = cols;
                    pane.row.rows = rows;
                    if let Some(pty) = &pane.pty {
                        let _ = pty.resize(cols.max(2), rows.max(2));
                    }
                    let row = pane.row.clone();
                    let _ = inner.store.pane_upsert(&row);
                }
                Ok(Value::Null)
            }
            Call::PaneAttach { pane_id } => {
                let mut inner = self.lock();
                Self::terminal_only(&inner, &pane_id)?;
                let snapshot = crate::pty::strip_terminal_queries(&inner.panes.get(&pane_id).ok_or_else(|| err(ErrorCode::NotFound, "pane not found"))?.scrollback.snapshot());
                let view = Self::pane_view(&inner, &pane_id);
                if let Some(c) = inner.clients.get_mut(&client_id) {
                    c.attached.insert(pane_id.clone());
                    let frame = Frame::Event { seq: 0, event: Event::PaneOutput { pane_id, data_base64: B64.encode(snapshot) } };
                    let _ = c.tx.send(serde_json::to_string(&frame).unwrap_or_default());
                }
                ok(view)
            }
            Call::PaneDetach { pane_id } => {
                if let Some(c) = self.lock().clients.get_mut(&client_id) {
                    c.attached.remove(&pane_id);
                }
                Ok(Value::Null)
            }
            Call::PaneKillTree { pane_id } => {
                let mut inner = self.lock();
                let pid = inner.panes.get(&pane_id).and_then(|p| p.pty.as_ref()).map(|p| p.pid).ok_or_else(|| err(ErrorCode::NotFound, "pane not live"))?;
                Self::set_stop_intent(&mut inner, &pane_id);
                for child in procs::descendants(&inner.proc_rows, pid) {
                    procs::kill_tree(&inner.proc_rows, child);
                }
                Ok(Value::Null)
            }

            Call::AgentList { worktree_id } => {
                let inner = self.lock();
                let mut agents: Vec<AgentPresence> = inner.agents.values().filter(|a| worktree_id.as_deref().map_or(true, |w| a.worktree_id == w)).cloned().collect();
                agents.sort_by(|a, b| (&a.worktree_id, &a.pane_id).cmp(&(&b.worktree_id, &b.pane_id)));
                ok(agents)
            }
            Call::AgentSpawn(spec) => {
                let mut inner = self.lock();
                let (worktree_id, cwd) = match (&spec.worktree_id, &spec.cwd, &spec.split_from) {
                    (None, None, Some(from)) => {
                        let p = inner.panes.get(from).ok_or_else(|| err(ErrorCode::NotFound, "pane not found"))?;
                        (p.row.worktree_id.clone(), p.row.cwd.clone())
                    }
                    _ => Self::worktree_for_spawn(&inner, spec.worktree_id.as_deref(), spec.cwd.as_deref())?,
                };
                let key = spec.kind.label().to_lowercase();
                let cmd = inner.config.agents.get(&key).cloned().unwrap_or(AgentCommand { command: key.clone(), args: vec![] });
                let plan = agents::spawn_plan(spec.kind, &cmd, spec.resume.as_deref(), &self.claude_settings_path(), &self.pi_extension_path(), &spec.extra_args);
                let line = agents::shell_line(&plan.argv);
                let tab_id = if spec.new_tab { Some(Self::create_tab(&mut inner, &worktree_id, Some(spec.kind.label().to_string())).id) } else { spec.tab_id.clone() };
                let (tab_id, pane_id) = self.spawn_in_worktree(
                    &mut inner,
                    &worktree_id,
                    cwd,
                    tab_id.as_deref(),
                    spec.split_from.as_deref(),
                    SplitDirection::Horizontal,
                    None,
                    None,
                    Some((spec.kind, plan.session_ref, line)),
                )?;
                ok(SpawnResult { pane: Self::pane_view(&inner, &pane_id).unwrap(), tab: Self::tab_view(&inner, &inner.tabs[&tab_id]), agent: inner.agents.get(&pane_id).cloned() })
            }
            Call::AgentHook { kind, pane_id, payload, at_ms } => {
                let outcome = agents::hook_outcome(kind, &payload);
                let mut inner = self.lock();
                if !inner.panes.contains_key(&pane_id) {
                    return Ok(Value::Null);
                }
                Self::apply_report(&mut inner, &AgentReport { pane_id, kind, state: outcome.state, session_ref: outcome.session_ref, authority: Authority::Lifecycle, at_ms }, None);
                Ok(Value::Null)
            }
            Call::AgentReport(report) => {
                let mut inner = self.lock();
                if !inner.panes.contains_key(&report.pane_id) {
                    return Err(err(ErrorCode::NotFound, "pane not found"));
                }
                Self::apply_report(&mut inner, &report, None);
                ok(inner.agents.get(&report.pane_id).cloned())
            }

            Call::Ps { worktree_id } => {
                let mut inner = self.lock();
                if now_ms().saturating_sub(inner.proc_rows_at_ms) > 1500 {
                    crate::monitor::poll_once(self, &mut inner, true);
                }
                let infos = crate::monitor::classify_all(&inner);
                ok(infos.into_iter().filter(|p| worktree_id.as_deref().map_or(true, |w| p.worktree_id.as_deref() == Some(w))).collect::<Vec<_>>())
            }
            Call::ProcessKillTree { pid } => {
                let inner = self.lock();
                let owned = crate::monitor::classify_all(&inner).into_iter().any(|p| p.pid == pid && p.ownership == Ownership::Owned);
                if !owned {
                    return Err(err(ErrorCode::Unsupported, format!("pid {pid} is not owned by a Tomo pane; refusing to kill it")));
                }
                procs::kill_tree(&inner.proc_rows, pid);
                Ok(Value::Null)
            }

            Call::Notify { pane_id, worktree_id, level, message } => {
                let message = message.trim().to_string();
                if message.is_empty() {
                    return Err(err(ErrorCode::BadRequest, "message is empty"));
                }
                let mut inner = self.lock();
                let worktree_id = worktree_id
                    .or_else(|| pane_id.as_ref().and_then(|p| inner.panes.get(p)).map(|p| p.row.worktree_id.clone()))
                    .ok_or_else(|| err(ErrorCode::BadRequest, "pane_id or worktree_id required"))?;
                if !inner.worktrees.contains_key(&worktree_id) {
                    return Err(err(ErrorCode::NotFound, "worktree not found"));
                }
                Self::add_attention(&mut inner, &worktree_id, pane_id.as_deref(), level, message);
                Ok(Value::Null)
            }
            Call::AttentionList => ok(self.lock().store.attention_list().map_err(internal)?),
            Call::AttentionNext => {
                let inner = self.lock();
                let next = inner.store.attention_list().map_err(internal)?.into_iter().find(|a| a.viewed_at_ms.is_none());
                ok(next)
            }
            Call::AttentionView { id } => {
                let mut inner = self.lock();
                if inner.store.attention_view(&id, now_ms()).map_err(internal)? {
                    Self::emit(&mut inner, Event::AttentionViewed { id });
                }
                Ok(Value::Null)
            }
            Call::AttentionClear => {
                let mut inner = self.lock();
                inner.store.attention_clear().map_err(internal)?;
                Self::emit(&mut inner, Event::AttentionCleared);
                Ok(Value::Null)
            }

            Call::GitSummary { worktree_id } => ok(self.refresh_git(&worktree_id).await),
            Call::PrStatus { worktree_id } => {
                let (path, cached) = {
                    let inner = self.lock();
                    let w = inner.worktrees.get(&worktree_id).ok_or_else(|| err(ErrorCode::NotFound, "worktree not found"))?;
                    (w.path.clone(), inner.prs.get(&worktree_id).cloned())
                };
                let fresh = cached.as_ref().and_then(|c| c.pr.as_ref()).map_or(false, |pr| now_ms().saturating_sub(pr.fetched_at_ms) < 60_000);
                if fresh {
                    return ok(cached);
                }
                let result = crate::github::pr_status(&path).await;
                let mut inner = self.lock();
                let changed = inner.prs.get(&worktree_id).map(|c| &c.pr) != Some(&result.pr);
                let was_merged = inner.prs.get(&worktree_id).and_then(|c| c.pr.as_ref()).map_or(false, |pr| pr.state == "merged");
                inner.prs.insert(worktree_id.clone(), result.clone());
                if let Some(pr) = result.pr.as_ref().filter(|pr| pr.state == "merged" && !was_merged) {
                    let mut ev = activity::event(ActivityKind::PrMerged, Some(&worktree_id), format!("PR #{} merged", pr.number));
                    ev.detail = Some(pr.title.clone());
                    ev.payload = json!({ "number": pr.number, "url": pr.url });
                    Self::record(&mut inner, ev);
                }
                if changed {
                    Self::emit(&mut inner, Event::PrChanged { worktree_id, pr: result.pr.clone() });
                }
                ok(result)
            }
            Call::FsList { worktree_id, rel_path } => {
                let root = self.lock().worktrees.get(&worktree_id).ok_or_else(|| err(ErrorCode::NotFound, "worktree not found"))?.path.clone();
                let dir = safe_join(&root, &rel_path).ok_or_else(|| err(ErrorCode::BadRequest, "path escapes worktree"))?;
                let mut entries: Vec<FsEntry> = std::fs::read_dir(&dir)
                    .map_err(|e| err(ErrorCode::Io, e.to_string()))?
                    .filter_map(|e| e.ok())
                    .filter(|e| e.file_name() != ".git")
                    .map(|e| {
                        let meta = e.metadata().ok();
                        let name = e.file_name().to_string_lossy().into_owned();
                        let rel = if rel_path.is_empty() { name.clone() } else { format!("{}/{}", rel_path.trim_end_matches('/'), name) };
                        FsEntry { is_dir: meta.as_ref().map_or(false, |m| m.is_dir()), size: meta.map_or(0, |m| m.len()), name, rel_path: rel }
                    })
                    .collect();
                entries.sort_by(|a, b| (!a.is_dir, a.name.to_lowercase()).cmp(&(!b.is_dir, b.name.to_lowercase())));
                ok(entries)
            }
            Call::OpenExternal { worktree_id, rel_path, target } => {
                let (root, editor) = {
                    let inner = self.lock();
                    let w = inner.worktrees.get(&worktree_id).ok_or_else(|| err(ErrorCode::NotFound, "worktree not found"))?;
                    (w.path.clone(), inner.config.editor_command.clone())
                };
                let path = safe_join(&root, &rel_path).ok_or_else(|| err(ErrorCode::BadRequest, "path escapes worktree"))?;
                let argv: Vec<String> = match target {
                    ExternalTarget::Finder => vec!["open".into(), "-R".into(), path.to_string_lossy().into_owned()],
                    ExternalTarget::Editor => {
                        let mut argv: Vec<String> = editor.iter().map(|a| a.replace("{path}", &path.to_string_lossy())).collect();
                        if !editor.iter().any(|a| a.contains("{path}")) {
                            argv.push(path.to_string_lossy().into_owned());
                        }
                        argv
                    }
                };
                if argv.is_empty() {
                    return Err(err(ErrorCode::BadRequest, "editor_command is empty"));
                }
                let launched = std::process::Command::new(&argv[0])
                    .args(&argv[1..])
                    .current_dir(&root)
                    .stdin(std::process::Stdio::null())
                    .stdout(std::process::Stdio::null())
                    .stderr(std::process::Stdio::null())
                    .spawn();
                match launched {
                    Ok(_) => Ok(Value::Null),
                    Err(e) if target == ExternalTarget::Editor => {
                        let _ = std::process::Command::new("open").arg(&path).spawn();
                        let mut inner = self.lock();
                        Self::emit(&mut inner, Event::Notice { level: NoticeLevel::Warning, message: format!("{} not found ({e}); opened with the default app instead", argv[0]) });
                        Ok(Value::Null)
                    }
                    Err(e) => Err(err(ErrorCode::Io, format!("{}: {e}", argv[0]))),
                }
            }

            Call::OpenLocation { path, line, col } => {
                if !path.is_absolute() {
                    return Err(err(ErrorCode::BadRequest, "path must be absolute"));
                }
                if !path.exists() {
                    return Err(err(ErrorCode::NotFound, format!("{} does not exist", path.display())));
                }
                let editor_command = self.lock().config.editor_command.clone();
                if let Some(message) = editor::open_location(&editor_command, &path, line, col) {
                    Self::emit(&mut self.lock(), Event::Notice { level: NoticeLevel::Warning, message });
                }
                Ok(Value::Null)
            }
            Call::SessionList { worktree_id, limit } => {
                let cwd = self.lock().worktrees.get(&worktree_id).map(|w| w.path.clone()).ok_or_else(|| err(ErrorCode::NotFound, "worktree not found"))?;
                let home = dirs::home_dir().ok_or_else(|| err(ErrorCode::Internal, "no home directory"))?;
                let list = tokio::task::spawn_blocking(move || sessions::list(&home, &cwd, limit.unwrap_or(20))).await.map_err(|e| err(ErrorCode::Internal, e.to_string()))?;
                ok(list)
            }
            Call::DiagnosticsList { limit } => {
                let inner = self.lock();
                ok(inner.diagnostics.iter().rev().take(limit.map_or(DIAGNOSTICS_KEPT, |n| n as usize)).cloned().collect::<Vec<_>>())
            }
            Call::SystemStats => ok(crate::system::fresh(self).await),
            Call::UsageGet { refresh } => {
                if refresh || self.lock().usage.is_empty() {
                    crate::usage::refresh(self).await;
                }
                ok(self.lock().usage.clone())
            }
            Call::RuntimeList { worktree_id } => {
                let stale = now_ms().saturating_sub(self.lock().endpoints_at_ms) > 1500;
                if stale {
                    let d = self.clone();
                    let _ = tokio::task::spawn_blocking(move || crate::monitor::poll_and_scan(&d, false)).await;
                }
                let inner = self.lock();
                let mut list: Vec<RuntimeEndpoint> = inner.endpoints.iter().filter(|e| worktree_id.as_deref().map_or(true, |w| e.worktree_id == w)).cloned().collect();
                list.sort_by(|a, b| (&a.worktree_id, a.port, a.pid).cmp(&(&b.worktree_id, b.port, b.pid)));
                ok(list)
            }
            Call::ActivityList(query) => ok(self.lock().store.activity_list(&query).map_err(internal)?),
            Call::CheckpointCreate(spec) => {
                let message = spec.message.trim().to_string();
                if message.is_empty() {
                    return Err(err(ErrorCode::BadRequest, "message is empty"));
                }
                let mut inner = self.lock();
                let pane = spec.pane_id.as_deref().and_then(|p| inner.panes.get(p)).map(|p| (p.row.id.clone(), p.row.worktree_id.clone()));
                let worktree_id = spec.worktree_id.clone().or_else(|| pane.as_ref().map(|(_, w)| w.clone())).ok_or_else(|| err(ErrorCode::BadRequest, "pane_id or worktree_id required"))?;
                if !inner.worktrees.contains_key(&worktree_id) {
                    return Err(err(ErrorCode::NotFound, "worktree not found"));
                }
                let pane_id = pane.map(|(p, _)| p);
                let agent = pane_id.as_deref().and_then(|p| inner.agents.get(p)).cloned();
                let title = spec.title.map(|t| t.trim().to_string()).filter(|t| !t.is_empty());
                let item = AttentionItem {
                    id: new_id(),
                    worktree_id: worktree_id.clone(),
                    pane_id: pane_id.clone(),
                    level: AttentionLevel::Attention,
                    message: title.clone().unwrap_or_else(|| message.clone()),
                    created_at_ms: now_ms(),
                    viewed_at_ms: None,
                    kind: AttentionKind::Checkpoint,
                    url: spec.url.map(|u| u.trim().to_string()).filter(|u| !u.is_empty()),
                    agent_kind: agent.as_ref().map(|a| a.kind),
                    resolved_at_ms: None,
                };
                Self::push_attention(&mut inner, item.clone());
                let mut ev = activity::event(ActivityKind::CheckpointCreated, Some(&worktree_id), item.message.clone());
                ev.pane_id = pane_id.clone();
                ev.agent_kind = item.agent_kind;
                ev.detail = title.is_some().then_some(message);
                ev.payload = json!({ "url": item.url });
                ev.attention_id = Some(item.id.clone());
                Self::record(&mut inner, ev);
                let mut hook = events::envelope(&inner, "checkpoint.created", Some(&worktree_id));
                hook.attention = Some(item.clone());
                hook.pane = pane_id.as_deref().and_then(|p| Self::hook_pane(&inner, p));
                hook.agent = agent.map(|a| HookAgent { kind: a.kind, state: a.state, session_ref: a.session_ref });
                inner.hook_queue.push(hook);
                ok(item)
            }
            Call::CheckpointResolve { id } => {
                let mut inner = self.lock();
                let item = inner.store.attention_get(&id).map_err(internal)?.ok_or_else(|| err(ErrorCode::NotFound, "attention item not found"))?;
                if item.resolved_at_ms.is_some() {
                    return ok(item);
                }
                let now = now_ms();
                inner.store.attention_resolve(&id, now).map_err(internal)?;
                let item = AttentionItem { resolved_at_ms: Some(now), ..item };
                Self::emit(&mut inner, Event::AttentionResolved { id: id.clone() });
                let mut ev = activity::event(ActivityKind::CheckpointResolved, Some(&item.worktree_id), format!("{} resolved", item.message));
                ev.pane_id = item.pane_id.clone();
                ev.agent_kind = item.agent_kind;
                ev.payload = json!({ "kind": item.kind, "url": item.url });
                ev.attention_id = Some(id);
                Self::record(&mut inner, ev);
                let mut hook = events::envelope(&inner, "checkpoint.resolved", Some(&item.worktree_id));
                hook.attention = Some(item.clone());
                hook.pane = item.pane_id.as_deref().and_then(|p| Self::hook_pane(&inner, p));
                inner.hook_queue.push(hook);
                ok(item)
            }
            Call::BrowserOpen { worktree_id, url, tab_id } => {
                let mut inner = self.lock();
                let cwd = inner.worktrees.get(&worktree_id).ok_or_else(|| err(ErrorCode::NotFound, "worktree not found"))?.path.clone();
                let url = url.map(|u| u.trim().to_string()).filter(|u| !u.is_empty()).unwrap_or_else(|| "about:blank".to_string());
                let tab_id = match tab_id {
                    Some(t) if inner.tabs.contains_key(&t) => t,
                    Some(_) => return Err(err(ErrorCode::NotFound, "tab not found")),
                    None => {
                        let tab = Self::create_tab(&mut inner, &worktree_id, Some("Browser".to_string()));
                        for t in inner.tabs.values().filter(|t| t.worktree_id == worktree_id && t.id != tab.id).cloned().collect::<Vec<_>>() {
                            let _ = inner.store.tab_upsert(&t);
                        }
                        tab.id
                    }
                };
                let pane_id = Self::create_browser_pane(&mut inner, &tab_id, &worktree_id, cwd, url).map_err(internal)?;
                Self::place_pane(&mut inner, &tab_id, &pane_id, None, SplitDirection::Horizontal);
                Self::touch(&mut inner, &worktree_id);
                Self::emit_tabs(&mut inner, &worktree_id);
                Self::emit_pane(&mut inner, &pane_id);
                ok(json!({ "pane": Self::pane_view(&inner, &pane_id), "tab": Self::tab_view(&inner, &inner.tabs[&tab_id]) }))
            }
            Call::BrowserNavigate { pane_id, url } => {
                let mut inner = self.lock();
                let pane = inner.panes.get_mut(&pane_id).ok_or_else(|| err(ErrorCode::NotFound, "pane not found"))?;
                if pane.row.kind != PaneKind::Browser {
                    return Err(err(ErrorCode::BadRequest, "pane is not a browser"));
                }
                pane.row.url = Some(url);
                let row = pane.row.clone();
                inner.store.pane_upsert(&row).map_err(internal)?;
                Self::emit_pane(&mut inner, &pane_id);
                ok(Self::pane_view(&inner, &pane_id))
            }
            Call::AnnotationsSend { pane_id, bundle } => {
                let mut inner = self.lock();
                let pane = inner.panes.get(&pane_id).ok_or_else(|| err(ErrorCode::NotFound, "pane not found"))?;
                let agent = inner.agents.get(&pane_id).filter(|a| a.state != AgentState::Exited).cloned().ok_or_else(|| err(ErrorCode::BadRequest, "pane has no live agent"))?;
                let pty = pane.pty.clone().filter(|_| pane.exit_code.is_none()).ok_or_else(|| err(ErrorCode::BadRequest, "agent pane is not live"))?;
                let worktree_id = pane.row.worktree_id.clone();
                let hook_pane = HookPane { id: pane.row.id.clone(), tab_id: pane.row.tab_id.clone(), cwd: pane.row.cwd.clone() };
                let (name, branch) = inner
                    .worktrees
                    .get(&bundle.worktree_id)
                    .or_else(|| inner.worktrees.get(&worktree_id))
                    .map(|w| (Self::worktree_view(&inner, w).name, w.branch.clone().unwrap_or_else(|| "detached".to_string())))
                    .unwrap_or_default();
                let runtime = bundle
                    .action_id
                    .as_deref()
                    .and_then(|a| Self::action_def(&inner, &worktree_id, a).ok())
                    .map(|a| a.label)
                    .or_else(|| bundle.url.clone())
                    .unwrap_or_else(|| "-".to_string());
                let text = evidence_text(&name, &branch, &runtime, &bundle);
                pty.write(pasted(&text).as_bytes()).map_err(internal)?;
                let event = ActivityEvent {
                    id: new_id(),
                    kind: ActivityKind::AnnotationsSent,
                    occurred_at_ms: now_ms(),
                    worktree_id: Some(worktree_id.clone()),
                    pane_id: Some(pane_id.clone()),
                    agent_kind: Some(agent.kind),
                    title: evidence_title(&bundle, agent.kind.label()),
                    detail: bundle.url.clone(),
                    payload: serde_json::to_value(&bundle).unwrap_or(Value::Null),
                    attention_id: None,
                };
                Self::record(&mut inner, event.clone());
                let mut ev = events::envelope(&inner, "annotation.sent", Some(&worktree_id));
                ev.pane = Some(hook_pane);
                ev.agent = Some(HookAgent { kind: agent.kind, state: agent.state, session_ref: agent.session_ref.clone() });
                inner.hook_queue.push(ev);
                ok(event)
            }
            Call::UiStateGet => {
                let inner = self.lock();
                let v = inner.store.kv_get("ui_state").map_err(internal)?.and_then(|s| serde_json::from_str::<Value>(&s).ok()).unwrap_or(Value::Null);
                Ok(v)
            }
            Call::UiStateSet { state } => {
                self.lock().store.kv_set("ui_state", &state.to_string()).map_err(internal)?;
                Ok(Value::Null)
            }
            // The composition root answers every addon call before Core sees it.
            _ => Err(err(ErrorCode::Unsupported, "no handler for this call")),
        }
    }
}

/// The plain-text form of an evidence bundle, as typed into an agent's terminal.
pub fn evidence_text(worktree_name: &str, branch: &str, runtime: &str, bundle: &EvidenceBundle) -> String {
    let body = match bundle.markdown.as_deref().map(str::trim) {
        Some(markdown) if !markdown.is_empty() => markdown.to_string(),
        _ => bundle
            .annotations
            .iter()
            .enumerate()
            .map(|(i, a)| {
                let selector = a.selector.as_deref().unwrap_or("-");
                let element = a.element_text.as_deref().unwrap_or("").replace('\n', " ");
                format!("{}. [{selector}] \"{element}\" — {}", i + 1, a.text.trim())
            })
            .collect::<Vec<_>>()
            .join("\n"),
    };
    format!("Browser feedback from Tomo\nworktree: {worktree_name} ({branch})\nruntime: {runtime}\n\n{body}\n\n{}", bundle.instruction.trim())
}

fn evidence_title(bundle: &EvidenceBundle, agent: &str) -> String {
    match bundle.note_count {
        Some(1) => format!("Sent 1 note → {agent}"),
        Some(n) => format!("Sent {n} notes → {agent}"),
        None => format!("Sent {} annotations → {agent}", bundle.annotations.len()),
    }
}

// Bracketed paste keeps a multi-line block as one input in Claude, Codex, and Pi;
// a bare newline would submit the first line alone. The final CR submits.
fn pasted(text: &str) -> String {
    format!("\x1b[200~{text}\x1b[201~\r")
}

pub async fn repo_view(id: Id, path: PathBuf) -> Repo {
    let exists = path.exists();
    let remote_url = if exists { git::remote_url(&path).await } else { None };
    let github = remote_url.as_deref().and_then(git::github_repo).map(|(owner, name)| GitHubRepo { owner, name });
    Repo { id, name: repo_name(&path), exists, path, remote_url, github }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Summaries {
    All,
    Cached,
}

pub fn repo_name(path: &Path) -> String {
    path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| path.to_string_lossy().into_owned())
}

fn safe_join(root: &Path, rel: &str) -> Option<PathBuf> {
    let rel = rel.trim_start_matches('/');
    if rel.split('/').any(|c| c == "..") {
        return None;
    }
    Some(if rel.is_empty() { root.to_path_buf() } else { root.join(rel) })
}

async fn futures_summaries(found: &[(Repo, Vec<git::WorktreeEntry>, PathBuf)]) -> HashMap<PathBuf, GitSummary> {
    let mut set = tokio::task::JoinSet::new();
    for path in found.iter().flat_map(|(_, entries, _)| entries.iter().filter(|e| !e.bare && !e.prunable).map(|e| canonical(&e.path))) {
        set.spawn(async move {
            let summary = git::summary(&path).await.ok();
            (path, summary)
        });
    }
    let mut out = HashMap::new();
    while let Some(Ok((path, summary))) = set.join_next().await {
        if let Some(s) = summary {
            out.insert(path, s);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn problem_change_records_only_appear_change_and_clear() {
        assert_eq!(problem_change("usage", None, None), None);
        assert_eq!(problem_change("usage", Some("no token"), Some("no token")), None);
        assert_eq!(problem_change("usage", None, Some("no token")), Some((DiagnosticLevel::Warning, "usage: no token".into())));
        assert_eq!(problem_change("usage", Some("no token"), Some("timeout")), Some((DiagnosticLevel::Warning, "usage: timeout".into())));
        assert_eq!(problem_change("usage", Some("timeout"), None), Some((DiagnosticLevel::Info, "usage: ok again".into())));
    }

    #[test]
    fn evidence_text_lists_annotations_in_order() {
        let bundle = EvidenceBundle {
            source: "browser annotation".into(),
            worktree_id: "w".into(),
            url: Some("http://localhost:1420/".into()),
            action_id: None,
            annotations: vec![
                Annotation { text: "wrong color".into(), url: "http://localhost:1420/".into(), selector: Some("#save".into()), element_text: Some("Save".into()), rect: None },
                Annotation { text: "cut off".into(), url: "http://localhost:1420/".into(), selector: None, element_text: None, rect: Some([1.0, 2.0, 3.0, 4.0]) },
            ],
            instruction: "Review and address these annotations.".into(),
            markdown: None,
            note_count: None,
        };
        let text = evidence_text("labor", "feat/x", "http://localhost:1420/", &bundle);
        assert_eq!(
            text,
            "Browser feedback from Tomo\nworktree: labor (feat/x)\nruntime: http://localhost:1420/\n\n1. [#save] \"Save\" — wrong color\n2. [-] \"\" — cut off\n\nReview and address these annotations."
        );
        assert_eq!(evidence_title(&bundle, "Claude"), "Sent 2 annotations → Claude");
        assert!(pasted("x").ends_with("\x1b[201~\r"));
    }

    #[test]
    fn evidence_text_uses_the_markdown_body() {
        let bundle = EvidenceBundle {
            source: "browser feedback".into(),
            worktree_id: "w".into(),
            url: Some("http://localhost:1420/".into()),
            action_id: None,
            annotations: vec![],
            instruction: "Review and address this feedback.".into(),
            markdown: Some("## Tomo (http://localhost:1420/)\n\n1. button `main > button`\n   wrong color\n".into()),
            note_count: Some(3),
        };
        let text = evidence_text("labor", "feat/x", "http://localhost:1420/", &bundle);
        assert_eq!(
            text,
            "Browser feedback from Tomo\nworktree: labor (feat/x)\nruntime: http://localhost:1420/\n\n## Tomo (http://localhost:1420/)\n\n1. button `main > button`\n   wrong color\n\nReview and address this feedback."
        );
        assert_eq!(evidence_title(&bundle, "Claude"), "Sent 3 notes → Claude");
    }
}
