use crate::activity;
use crate::agents;
use crate::config::{self, Paths};
use crate::events;
use crate::features::{editor, reopen};
use crate::git;
use crate::layout;
use crate::procs::{self, ProcMonitor, ProcRow};
use crate::providers;
use crate::pty::{PtySession, Scrollback, Spawn};
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

pub struct Client {
    pub tx: mpsc::UnboundedSender<String>,
    pub subscribed: bool,
    pub attached: HashSet<Id>,
}

pub type WorktreeNamer = fn(&Store, &WorktreeCreate) -> Result<Option<String>, RpcError>;
pub type WorktreeCreatedHook = fn(&mut Inner, &CreatedWorktree) -> Result<(), RpcError>;
pub type WorktreeReboundHook = fn(&Store, &str, &str) -> Result<()>;

pub(crate) struct PaneSpec<'a> {
    pub command: Option<&'a [String]>,
    pub title: Option<String>,
    pub agent_kind: Option<AgentKind>,
    pub session_ref: Option<String>,
    pub pending_line: Option<String>,
    pub origin: PaneOrigin,
}

impl Default for PaneSpec<'_> {
    fn default() -> Self {
        Self { command: None, title: None, agent_kind: None, session_ref: None, pending_line: None, origin: PaneOrigin::Live }
    }
}

pub(crate) struct SpawnSpec<'a> {
    pub tab_id: Option<&'a str>,
    pub split_from: Option<&'a str>,
    pub direction: SplitDirection,
    pub command: Option<&'a [String]>,
    pub title: Option<String>,
    pub agent: Option<(AgentKind, Option<String>, String)>,
}

impl Default for SpawnSpec<'_> {
    fn default() -> Self {
        Self { tab_id: None, split_from: None, direction: SplitDirection::Horizontal, command: None, title: None, agent: None }
    }
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
    pub infra_name: String,
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
    pub screen: Option<Box<dyn crate::vt::Screen>>,
    /// Set when Tomo itself ends the pane's process, so the exit is a stop and not a crash.
    pub stop_intent: bool,
    /// Set by the code that spawned the pane. Memory only: a restore starts without it.
    pub source: Option<PaneSource>,
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
    pub archiving: HashSet<Id>,
    pub hook_queue: Vec<HookEvent>,
    pub discovered_once: bool,
    pub last_full_poll_ms: u64,
    pub closed_tabs: Vec<reopen::ClosedTab>,
    pub diagnostics: std::collections::VecDeque<Diagnostic>,
    /// The current problem per `source:subject`, so a repeated poll records a diagnostic only on a change.
    pub problems: HashMap<String, String>,
    /// The in-memory state of the addons of this daemon, under the same lock as Core state. Core never looks inside; the composition root fills it.
    pub addons: Box<dyn std::any::Any + Send>,
}

/// Plain function lists that addons join at fixed points of Core operations. The composition root builds it once at startup.
pub struct Seams {
    /// Names the directory of a worktree created without a path, before `git worktree add`. An error refuses the create.
    pub worktree_namer: Option<WorktreeNamer>,
    /// Runs under the state lock after `git worktree add` and discovery, before `worktree_create` returns.
    pub worktree_created: Vec<WorktreeCreatedHook>,
    /// Runs under the state lock when a worktree gets a new id: a move on disk, or a restore at a new path.
    pub worktree_rebound: Vec<WorktreeReboundHook>,
    /// A file in the root of each worktree that an addon reads. Core calls `reload` with no lock held, after each discovery and after the watcher sees that file change.
    pub worktree_files: Vec<WorktreeFile>,
    /// Runs under the state lock when a pane process exits, after `pane_exited` goes out and before Core updates the agent or removes a pane that exited with 0.
    pub pane_exited: Vec<fn(&mut Inner, &PaneExit)>,
    /// Runs with no lock held after each process poll of the monitor, before the queued hooks go out.
    pub process_polled: Vec<fn(&Arc<Daemon>)>,
}

#[derive(Clone, Copy)]
pub struct WorktreeFile {
    pub name: &'static str,
    pub reload: fn(&Arc<Daemon>),
}

pub struct PaneExit {
    pub pane_id: Id,
    pub worktree_id: Id,
    pub source: Option<PaneSource>,
    pub exit_code: Option<i32>,
    /// True when Tomo itself ended the process, so the exit is not a crash.
    pub stop_intent: bool,
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

/// The tty must stay silent for this long before Tomo types the queued line.
const PENDING_QUIET_MS: u64 = 300;
/// A pane that wrote nothing at all gets the line here, because a shell profile can be silent.
const PENDING_SILENT_MS: u64 = 5_000;
/// A tty that never goes quiet keeps the line until here. Then the line goes and a diagnostic stays.
const PENDING_BUSY_MS: u64 = 30_000;

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Pending {
    Wait,
    Type,
    Drop,
}

/// Decides what to do with the queued command line of a pane. Output that
/// still flows means a program reads the tty, and the line would land in that
/// program instead of the shell, so Tomo waits. A slow profile keeps the line
/// until it goes quiet.
pub(crate) fn pending_action(last_output_ms: u64, now: u64, started: u64) -> Pending {
    let elapsed = now.saturating_sub(started);
    if last_output_ms == 0 {
        return if elapsed >= PENDING_SILENT_MS { Pending::Type } else { Pending::Wait };
    }
    if now.saturating_sub(last_output_ms) >= PENDING_QUIET_MS {
        return Pending::Type;
    }
    if elapsed >= PENDING_BUSY_MS {
        Pending::Drop
    } else {
        Pending::Wait
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
    pub fn new(paths: Paths, seams: Seams, addons: Box<dyn std::any::Any + Send>) -> Result<Arc<Self>> {
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
                archiving: HashSet::new(),
                hook_queue: Vec::new(),
                discovered_once: false,
                last_full_poll_ms: 0,
                closed_tabs: Vec::new(),
                diagnostics: std::collections::VecDeque::new(),
                problems: HashMap::new(),
                addons,
            }),
            stop: tokio::sync::Notify::new(),
            refresh: tokio::sync::Notify::new(),
            repos_changed: tokio::sync::Notify::new(),
            rt: tokio::runtime::Handle::current(),
            seams,
            paths,
        });
        providers::write_launch_files(&daemon.paths.integrations_dir, &daemon.tomo_bin)?;
        Ok(daemon)
    }

    pub fn lock(&self) -> MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|p| p.into_inner())
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
        inner
            .repos
            .iter()
            .map(|r| Repo {
                worktree_parent: Some(config::worktree_parent(inner.config.worktree_parent_dir.as_deref(), &r.path)),
                branch_prefix: Some(inner.config.branch_prefix.clone()),
                ..r.clone()
            })
            .collect()
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
            action_id: PaneSource::action_id(p.source.as_ref()),
            source: p.source.clone(),
            process_cmd: p.process_cmd.clone(),
            kind: p.row.kind,
            url: p.row.url.clone(),
        })
    }

    fn pane_of(inner: &Inner, pane_id: &str) -> Result<Pane, RpcError> {
        Self::pane_view(inner, pane_id).ok_or_else(|| err(ErrorCode::Internal, "the pane vanished as it was made"))
    }

    fn pane_result(inner: &Inner, pane_id: &str, tab_id: &str) -> Result<PaneResult, RpcError> {
        Ok(PaneResult { pane: Self::pane_of(inner, pane_id)?, tab: Self::tab_view(inner, &inner.tabs[tab_id]) })
    }

    pub fn pane_views(inner: &Inner, worktree_id: Option<&str>) -> Vec<Pane> {
        let mut panes: Vec<Pane> =
            inner.panes.keys().filter_map(|id| Self::pane_view(inner, id)).filter(|p| worktree_id.is_none_or(|w| p.worktree_id == w)).collect();
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
            integrations: providers::installed(),
        }
    }

    // ------------------------------------------------------------- discovery

    pub async fn discover(self: &Arc<Self>, summaries: Summaries) -> Result<()> {
        let rows = self.lock().store.repos()?;
        let probes: Vec<_> = rows
            .into_iter()
            .map(|r| {
                tokio::spawn(async move {
                    let repo = repo_view(r.id, r.path).await;
                    let probe = match repo.exists {
                        true => Some(tokio::join!(git::list_worktrees(&repo.path), git::common_dir(&repo.path))),
                        false => None,
                    };
                    (repo, probe)
                })
            })
            .collect();
        let mut repos: Vec<Repo> = Vec::with_capacity(probes.len());
        let mut found: Vec<(Repo, Vec<git::WorktreeEntry>, PathBuf)> = Vec::new();
        for probe in probes {
            let (repo, probe) = probe.await?;
            match probe {
                Some((Ok(entries), Ok(common))) => found.push((repo.clone(), entries, common)),
                Some((Err(e), _)) | Some((_, Err(e))) => tracing::warn!("discover {}: {e}", repo.path.display()),
                None => {}
            }
            repos.push(repo);
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
                let strays: Vec<&MetaRow> = meta_rows.iter().filter(|m| m.id != id && m.path == path).collect();
                for stray in &strays {
                    if let Err(e) = self.rebind(&mut inner, &stray.id, &id, &path) {
                        tracing::warn!("rebind {} to {id}: {e}", stray.id);
                    }
                }
                let existing = if strays.is_empty() { existing } else { inner.store.meta_one(&id)?.or(existing) };
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
                    infra_name: Some(crate::identity::infra_name(
                        existing.as_ref().and_then(|m| m.infra_name.as_deref()),
                        existing
                            .as_ref()
                            .and_then(|m| m.metadata.display_name.as_deref())
                            .unwrap_or_else(|| path.file_name().and_then(|n| n.to_str()).unwrap_or("wt")),
                        &id,
                    )),
                };
                let needs_write = existing.as_ref().is_none_or(|m| {
                    m.path != path
                        || m.gitdir != gitdir
                        || m.repo_id != repo.id
                        || m.first_seen_ms.is_none()
                        || m.archived_at_ms.is_some()
                        || m.infra_name.is_none()
                });
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
                        infra_name: row.infra_name.clone().unwrap_or_default(),
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
                    infra_name: m.infra_name.clone().unwrap_or_default(),
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
        for file in &self.seams.worktree_files {
            (file.reload)(self);
        }
        self.flush_hooks();
        Ok(())
    }

    /// Types `text` into the live agent of a pane as one bracketed paste, then submits it. Returns the agent and the pane for a hook.
    pub fn paste_to_agent(inner: &Inner, pane_id: &str, text: &str) -> Result<(AgentPresence, HookPane), RpcError> {
        let pane = inner.panes.get(pane_id).ok_or_else(|| err(ErrorCode::NotFound, "pane not found"))?;
        let agent =
            inner.agents.get(pane_id).filter(|a| a.state != AgentState::Exited).cloned().ok_or_else(|| err(ErrorCode::BadRequest, "pane has no live agent"))?;
        let pty = pane.pty.clone().filter(|_| pane.exit_code.is_none()).ok_or_else(|| err(ErrorCode::BadRequest, "agent pane is not live"))?;
        pty.write(pasted(text).as_bytes()).map_err(internal)?;
        Ok((agent, HookPane { id: pane.row.id.clone(), tab_id: pane.row.tab_id.clone(), cwd: pane.row.cwd.clone() }))
    }

    pub fn hook_pane(inner: &Inner, pane_id: &str) -> Option<HookPane> {
        inner.panes.get(pane_id).map(|p| HookPane { id: p.row.id.clone(), tab_id: p.row.tab_id.clone(), cwd: p.row.cwd.clone() })
    }

    fn set_stop_intent(inner: &mut Inner, pane_id: &str) {
        if let Some(p) = inner.panes.get_mut(pane_id) {
            p.stop_intent = true;
        }
    }

    pub(crate) fn focus_pane(inner: &mut Inner, pane_id: &str) {
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

    /// Ends a pane as a stop, not a crash: kills its process tree, keeps its scrollback, and removes it. The caller emits the tabs.
    pub(crate) fn stop_pane(&self, inner: &mut Inner, pane_id: &str) {
        Self::set_stop_intent(inner, pane_id);
        if let Some(pid) = inner.panes.get(pane_id).and_then(|p| p.pty.as_ref()).map(|p| p.pid) {
            for child in procs::descendants(&inner.proc_rows, pid) {
                procs::kill_tree(&inner.proc_rows, child);
            }
        }
        self.persist_scrollback(inner, pane_id);
        Self::remove_pane(inner, pane_id);
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

    pub fn resolve_worktree(worktrees: &HashMap<Id, WorktreeState>, path: &Path) -> Option<Id> {
        let path = canonical(path);
        worktrees.values().filter(|w| path.starts_with(&w.path)).max_by_key(|w| w.path.as_os_str().len()).map(|w| w.id.clone())
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
        let infra_name = inner.worktrees.get(worktree_id).map(|w| w.infra_name.clone()).unwrap_or_default();
        vec![
            ("TOMO_INFRA_NAME".into(), infra_name.clone()),
            // What Compose calls a project. Everything it makes is named after this, so two
            // worktrees of one repository do not share a container, a network or a volume.
            ("COMPOSE_PROJECT_NAME".into(), infra_name),
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
        std::env::vars().map(|(k, _)| k).filter(|k| k.starts_with("TOMO_") || k.starts_with("ORCA_") || providers::marks_nested_agent(k)).collect()
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
            if let Some(screen) = pane.screen.as_mut() {
                screen.write(bytes);
            }
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
    /// While output still flows, a program can hold the tty, so Tomo waits: see `pending_action`.
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
                    match pending_action(pane.last_output_ms, now_ms(), started) {
                        Pending::Wait => None,
                        Pending::Type => Some((pane.pending_line.take().unwrap(), pane.pty.clone().unwrap())),
                        Pending::Drop => {
                            let line = pane.pending_line.take().unwrap_or_default();
                            let message = format!("pane {pane_id}: the terminal did not go quiet, so Tomo did not type {line:?}");
                            Daemon::diagnostic(&mut inner, DiagnosticLevel::Warning, "daemon", message);
                            return;
                        }
                    }
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
        let exit = PaneExit {
            pane_id: pane_id.to_string(),
            worktree_id: pane.row.worktree_id.clone(),
            source: pane.source.clone(),
            exit_code: code,
            stop_intent: pane.stop_intent,
        };
        let worktree_id = exit.worktree_id.clone();
        Self::emit(&mut inner, Event::PaneExited { pane_id: pane_id.to_string(), exit_code: code });
        for seam in &self.seams.pane_exited {
            seam(&mut inner, &exit);
        }
        if let Some(agent) = inner.agents.get_mut(pane_id).filter(|a| a.state != AgentState::Exited) {
            let was_waiting = agent.state == AgentState::Waiting;
            agent.state = AgentState::Exited;
            agent.authority = Authority::Lifecycle;
            agent.updated_at_ms = now_ms();
            let agent = agent.clone();
            Self::emit(&mut inner, Event::AgentChanged { agent: agent.clone() });
            Self::record_agent(&mut inner, CoreActivity::AgentExited, &agent, "exited");
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
    pub(crate) fn create_pane(self: &Arc<Self>, inner: &mut Inner, tab_id: &str, worktree_id: &str, cwd: PathBuf, spec: PaneSpec<'_>) -> Result<Id> {
        let PaneSpec { command, title, agent_kind, session_ref, pending_line, origin } = spec;
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
            kind: PaneKind::Terminal,
            url: None,
        };
        inner.store.pane_upsert(&row)?;
        inner.panes.insert(
            id.clone(),
            PaneState {
                row,
                pty: None,
                origin,
                exit_code: None,
                process_title: None,
                process_cmd: None,
                pending_line,
                last_output_ms: 0,
                scrollback: Scrollback::default(),
                screen: crate::vt::screen_for(
                    crate::vt::VtEngine::parse(&inner.config.vt_engine).unwrap_or_default(),
                    120,
                    30,
                    inner.config.scrollback_lines as usize,
                ),
                stop_intent: false,
                source: None,
            },
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
            Self::record_agent(inner, CoreActivity::AgentStarted, &presence, "started");
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

    fn terminal_only(inner: &Inner, pane_id: &str) -> Result<(), RpcError> {
        match inner.panes.get(pane_id) {
            None => Err(err(ErrorCode::NotFound, "pane not found")),
            Some(p) if p.row.kind == PaneKind::Browser => Err(err(ErrorCode::BadRequest, "browser panes have no terminal")),
            Some(_) => Ok(()),
        }
    }

    pub(crate) fn place_pane(inner: &mut Inner, tab_id: &str, pane_id: &str, split_from: Option<&str>, direction: SplitDirection) {
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

    fn worktree_for_spawn(worktrees: &HashMap<Id, WorktreeState>, worktree_id: Option<&str>, cwd: Option<&Path>) -> Result<(Id, PathBuf), RpcError> {
        if let Some(id) = worktree_id {
            let w = worktrees.get(id).ok_or_else(|| err(ErrorCode::NotFound, format!("worktree {id} not found")))?;
            return Ok((w.id.clone(), cwd.map(Path::to_path_buf).unwrap_or_else(|| w.path.clone())));
        }
        let cwd = cwd.ok_or_else(|| err(ErrorCode::BadRequest, "worktree_id or cwd required"))?;
        let id = Self::resolve_worktree(worktrees, cwd).ok_or_else(|| err(ErrorCode::NotFound, format!("{} is not inside a known worktree", cwd.display())))?;
        Ok((id, cwd.to_path_buf()))
    }

    pub(crate) fn active_tab(inner: &Inner, worktree_id: &str) -> Option<Id> {
        let mut tabs: Vec<&TabRow> = inner.tabs.values().filter(|t| t.worktree_id == worktree_id).collect();
        tabs.sort_by_key(|t| (!t.is_active, t.position));
        tabs.first().map(|t| t.id.clone())
    }

    pub(crate) fn spawn_in_worktree(self: &Arc<Self>, inner: &mut Inner, worktree_id: &str, cwd: PathBuf, spec: SpawnSpec<'_>) -> Result<(Id, Id), RpcError> {
        let SpawnSpec { tab_id, split_from, direction, command, title, agent } = spec;
        let crowded =
            |inner: &Inner, t: &str| inner.tabs.get(t).is_some_and(|tab| layout::pane_ids(&tab.layout).len() >= inner.config.max_panes_per_tab as usize);
        let tab_id = match tab_id
            .map(str::to_string)
            .or_else(|| split_from.and_then(|p| inner.panes.get(p)).map(|p| p.row.tab_id.clone()))
            .or_else(|| Self::active_tab(inner, worktree_id))
        {
            Some(t) if inner.tabs.contains_key(&t) && !(tab_id.is_none() && split_from.is_none() && crowded(inner, &t)) => t,
            _ => Self::create_tab(inner, worktree_id, None).id,
        };
        let (kind, session_ref, pending) = match agent {
            Some((k, s, line)) => (Some(k), s, Some(line)),
            None => (None, None, None),
        };
        let pane_id = self
            .create_pane(
                inner,
                &tab_id,
                worktree_id,
                cwd,
                PaneSpec { command, title, agent_kind: kind, session_ref, pending_line: pending, ..PaneSpec::default() },
            )
            .map_err(internal)?;
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
        let engine = inner.config.vt_engine.clone();
        let scrollback_lines = inner.config.scrollback_lines as usize;
        let tabs = inner.store.tabs()?;
        let panes = inner.store.panes()?;
        let referenced: HashSet<Id> = tabs.iter().flat_map(|t| layout::pane_ids(&t.layout)).collect();
        for t in &tabs {
            inner.tabs.insert(t.id.clone(), t.clone());
        }
        for row in panes {
            if !referenced.contains(&row.id) {
                let _ = inner.store.pane_delete(&row.id);
                continue;
            }
            let resume_ref = row.session_ref.clone().or_else(|| row.agent_kind.and_then(|k| providers::provider(k).resume_without_session).map(str::to_string));
            let (origin, pending) = match (row.agent_kind, resume_ref.as_deref()) {
                (Some(kind), Some(session)) => {
                    let plan = providers::launch(&inner.config, kind, Some(session), &self.paths.integrations_dir, &[]);
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
                PaneState {
                    row: row.clone(),
                    pty: None,
                    origin,
                    exit_code: None,
                    process_title: None,
                    process_cmd: None,
                    pending_line: pending,
                    last_output_ms: 0,
                    scrollback,
                    screen: crate::vt::screen_for(crate::vt::VtEngine::parse(&engine).unwrap_or_default(), 120, 30, scrollback_lines),
                    stop_intent: false,
                    source: None,
                },
            );
            if let Err(e) = self.start_pty(&mut inner, &row.id, None) {
                tracing::warn!("restore pane {}: {e}", row.id);
            }
        }
        let empty_tabs: Vec<Id> =
            inner.tabs.values().filter(|t| layout::pane_ids(&t.layout).iter().all(|p| !inner.panes.contains_key(p))).map(|t| t.id.clone()).collect();
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
            Self::record_agent(inner, CoreActivity::AgentStarted, &next, "started");
        }
        if previous != Some(next.state) && next.state != AgentState::Unknown {
            let name = if previous.is_none() { "agent.started".to_string() } else { format!("agent.{}", next.state.name()) };
            let mut ev = events::envelope(inner, &name, Some(&worktree_id));
            ev.pane = inner.panes.get(&report.pane_id).map(|p| HookPane { id: p.row.id.clone(), tab_id: p.row.tab_id.clone(), cwd: p.row.cwd.clone() });
            ev.agent = Some(HookAgent { kind: next.kind, state: next.state, session_ref: next.session_ref.clone() });
            inner.hook_queue.push(ev);
        }
        if next.state == AgentState::Waiting && previous != Some(AgentState::Waiting) {
            let attention_id =
                Self::add_attention(inner, &worktree_id, Some(&report.pane_id), AttentionLevel::Attention, format!("{} is waiting for you", next.kind.label()));
            let repeat =
                Self::recorded_recently(inner, CoreActivity::AgentWaiting, activity::WAITING_REPEAT_MS, |a| a.pane_id.as_deref() == Some(&report.pane_id));
            if !repeat {
                let mut ev = Self::agent_event(CoreActivity::AgentWaiting, &next, "is waiting for you");
                ev.attention_id = attention_id;
                Self::record(inner, ev);
            }
        }
        if next.state == AgentState::Exited && previous != Some(AgentState::Exited) {
            Self::record_agent(inner, CoreActivity::AgentExited, &next, "exited");
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

    pub(crate) fn push_attention(inner: &mut Inner, item: AttentionItem) {
        let _ = inner.store.attention_insert(&item);
        let mut ev = events::envelope(inner, "attention.created", Some(&item.worktree_id));
        ev.attention = Some(item.clone());
        ev.pane = item.pane_id.as_deref().and_then(|p| Self::hook_pane(inner, p));
        inner.hook_queue.push(ev);
        Self::emit(inner, Event::AttentionAdded { item });
    }

    fn agent_event(kind: CoreActivity, agent: &AgentPresence, verb: &str) -> ActivityEvent {
        let mut ev = activity::event(kind, Some(&agent.worktree_id), format!("{} {verb}", agent.kind.label()));
        ev.pane_id = Some(agent.pane_id.clone());
        ev.agent_kind = Some(agent.kind);
        ev.payload = json!({ "session_ref": agent.session_ref });
        ev
    }

    fn record_agent(inner: &mut Inner, kind: CoreActivity, agent: &AgentPresence, verb: &str) {
        Self::record(inner, Self::agent_event(kind, agent, verb));
    }

    fn worktree_name(inner: &Inner, worktree_id: &str) -> String {
        inner.worktrees.get(worktree_id).map(|w| Self::worktree_view(inner, w).name).unwrap_or_else(|| worktree_id.to_string())
    }

    pub fn meta_row_of(inner: &Inner, w: &WorktreeState, metadata: WorktreeMetadata) -> MetaRow {
        let stored = inner.store.meta_one(&w.id).ok().flatten();
        let archived_branch = stored.as_ref().and_then(|m| m.archived_branch.clone());
        let infra_name = stored.as_ref().and_then(|m| m.infra_name.clone());
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
            infra_name,
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
        let (target, event) = {
            let mut inner = self.lock();
            let w = inner.worktrees.get(worktree_id).ok_or_else(|| err(ErrorCode::NotFound, "worktree not found"))?.clone();
            let target = archive_target(&w, &inner.repos, &inner.archiving)?;
            inner.archiving.insert(worktree_id.to_string());
            Self::emit(&mut inner, Event::WorktreeArchiving { worktree_id: worktree_id.to_string() });
            let worktrees = Self::worktree_views(&inner);
            Self::emit(&mut inner, Event::WorktreesChanged { worktrees });
            let event = events::envelope(&inner, "worktree.before_archive", Some(worktree_id));
            (target, event)
        };
        let result = self.archive_steps(worktree_id, &target.path, &target.repo_path, &target.branch, event, checkpoint).await;
        let mut inner = self.lock();
        inner.archiving.remove(worktree_id);
        match result {
            Ok(result) => {
                let ev = events::envelope(&inner, "worktree.archived", Some(worktree_id));
                inner.hook_queue.push(ev);
                let title = format!("{} archived", Self::worktree_name(&inner, worktree_id));
                let mut ev = activity::event(CoreActivity::Archived, Some(worktree_id), title);
                ev.detail = result.checkpoint_commit.as_ref().map(|c| format!("checkpoint {}", &c[..c.len().min(7)]));
                ev.payload = json!({ "branch": result.branch, "checkpoint_commit": result.checkpoint_commit, "head": target.head });
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

    async fn archive_steps(
        self: &Arc<Self>,
        worktree_id: &str,
        path: &Path,
        repo_path: &Path,
        branch: &str,
        event: HookEvent,
        checkpoint: CheckpointMode,
    ) -> Result<ArchiveResult, RpcError> {
        if let Err(run) = self.gate(event).await {
            return Err(err(ErrorCode::Aborted, format!("before_archive hook refused ({}): {}", run.command, run.output_tail.lines().last().unwrap_or(""))));
        }
        let checkpoint_commit = Self::archive_checkpoint(path, checkpoint).await?;
        {
            let mut inner = self.lock();
            Self::close_worktree_panes(&mut inner, worktree_id);
        }
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
        Ok(ArchiveResult { worktree_id: worktree_id.to_string(), branch: (!branch.is_empty()).then(|| branch.to_string()), checkpoint_commit })
    }

    async fn restore_worktree(self: &Arc<Self>, worktree_id: &str) -> Result<Value, RpcError> {
        let (target, row) = {
            let inner = self.lock();
            let w = inner.worktrees.get(worktree_id).ok_or_else(|| err(ErrorCode::NotFound, "worktree not found"))?;
            let row = Self::meta_row_of(&inner, w, w.metadata.clone());
            (restore_target(w, &inner.repos, &row)?, row)
        };
        let RestoreTarget { path, repo_path, branch } = target;
        if !git::branch_exists(&repo_path, &branch).await {
            return Err(err(ErrorCode::Git, format!("branch {branch} no longer exists; create the worktree again from another ref")));
        }
        let path = if path.parent().is_some_and(|p| p.is_dir()) {
            path
        } else {
            let parent = config::worktree_parent(self.lock().config.worktree_parent_dir.as_deref(), &repo_path);
            let _ = std::fs::create_dir_all(&parent);
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
        let mut ev = activity::event(CoreActivity::Restored, Some(&id), title);
        ev.payload = json!({ "branch": branch });
        Self::record(&mut inner, ev);
        let view = inner.worktrees.get(&id).map(|w| Self::worktree_view(&inner, w));
        drop(inner);
        self.flush_hooks();
        view.ok_or_else(|| err(ErrorCode::Internal, "restored worktree not discovered")).and_then(ok)
    }

    // ------------------------------------------------------------ dispatch

    /// Marks the client subscribed and builds the Core part of the snapshot. `dispatch.rs` adds the addon fields.
    pub fn subscribe(&self, client_id: u64) -> Result<CoreSnapshot, RpcError> {
        tracing::info!("client {client_id} subscribed");
        let mut inner = self.lock();
        if let Some(c) = inner.clients.get_mut(&client_id) {
            c.subscribed = true;
        }
        let attention = inner.store.attention_list().map_err(internal)?;
        let ui_state = inner.store.kv_get("ui_state").map_err(internal)?.and_then(|s| serde_json::from_str::<Value>(&s).ok()).unwrap_or(Value::Null);
        Ok(CoreSnapshot {
            status: self.status(&inner),
            config: inner.config.clone(),
            repos: Self::repo_views(&inner),
            worktrees: Self::worktree_views(&inner),
            tabs: Self::all_tabs(&inner),
            panes: Self::pane_views(&inner, None),
            agents: inner.agents.values().cloned().collect(),
            attention,
            resources: inner.resources.clone(),
            ui_state,
        })
    }

    async fn checkpoint_resolve(self: &Arc<Self>, id: Id) -> Result<Value, RpcError> {
        let mut inner = self.lock();
        let item = inner.store.attention_get(&id).map_err(internal)?.ok_or_else(|| err(ErrorCode::NotFound, "attention item not found"))?;
        if item.resolved_at_ms.is_some() {
            return ok(item);
        }
        let now = now_ms();
        inner.store.attention_resolve(&id, now).map_err(internal)?;
        let item = AttentionItem { resolved_at_ms: Some(now), ..item };
        Self::emit(&mut inner, Event::AttentionResolved { id: id.clone() });
        let mut ev = activity::event(CoreActivity::CheckpointResolved, Some(&item.worktree_id), format!("{} resolved", item.message));
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

    async fn checkpoint_create(self: &Arc<Self>, spec: CheckpointSpec) -> Result<Value, RpcError> {
        let message = spec.message.trim().to_string();
        if message.is_empty() {
            return Err(err(ErrorCode::BadRequest, "message is empty"));
        }
        let mut inner = self.lock();
        let pane = spec.pane_id.as_deref().and_then(|p| inner.panes.get(p)).map(|p| (p.row.id.clone(), p.row.worktree_id.clone()));
        let worktree_id = spec
            .worktree_id
            .clone()
            .or_else(|| pane.as_ref().map(|(_, w)| w.clone()))
            .ok_or_else(|| err(ErrorCode::BadRequest, "pane_id or worktree_id required"))?;
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
        let mut ev = activity::event(CoreActivity::CheckpointCreated, Some(&worktree_id), item.message.clone());
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

    async fn open_location(self: &Arc<Self>, path: PathBuf, line: Option<u32>, col: Option<u32>) -> Result<Value, RpcError> {
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

    async fn open_external(self: &Arc<Self>, worktree_id: Id, rel_path: String, target: ExternalTarget) -> Result<Value, RpcError> {
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
                Self::emit(
                    &mut inner,
                    Event::Notice { level: NoticeLevel::Warning, message: format!("{} not found ({e}); opened with the default app instead", argv[0]) },
                );
                Ok(Value::Null)
            }
            Err(e) => Err(err(ErrorCode::Io, format!("{}: {e}", argv[0]))),
        }
    }

    async fn fs_list(self: &Arc<Self>, worktree_id: Id, rel_path: String) -> Result<Value, RpcError> {
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
                let modified_ms = meta
                    .as_ref()
                    .and_then(|m| m.modified().ok())
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map_or(0, |d| d.as_millis() as u64);
                FsEntry { is_dir: meta.as_ref().is_some_and(|m| m.is_dir()), size: meta.map_or(0, |m| m.len()), modified_ms, name, rel_path: rel }
            })
            .collect();
        entries.sort_by_key(|a| (!a.is_dir, a.name.to_lowercase()));
        ok(entries)
    }

    async fn fs_recent(self: &Arc<Self>, worktree_id: Id, limit: Option<usize>) -> Result<Value, RpcError> {
        let root = self.lock().worktrees.get(&worktree_id).ok_or_else(|| err(ErrorCode::NotFound, "worktree not found"))?.path.clone();
        let files = git::files(&root).await.map_err(|e| err(ErrorCode::Io, e.to_string()))?;
        let limit = limit.unwrap_or(50);
        let entries = tokio::task::spawn_blocking(move || {
            let mut entries: Vec<FsEntry> = files
                .into_iter()
                .filter_map(|rel| {
                    let meta = std::fs::metadata(root.join(&rel)).ok().filter(|m| m.is_file())?;
                    let modified_ms = meta.modified().ok()?.duration_since(std::time::UNIX_EPOCH).ok()?.as_millis() as u64;
                    let name = rel.rsplit('/').next().unwrap_or(&rel).to_owned();
                    Some(FsEntry { is_dir: false, size: meta.len(), modified_ms, name, rel_path: rel })
                })
                .collect();
            entries.sort_by_key(|e| std::cmp::Reverse(e.modified_ms));
            entries.truncate(limit);
            entries
        })
        .await
        .map_err(|e| err(ErrorCode::Io, e.to_string()))?;
        ok(entries)
    }

    async fn notify(self: &Arc<Self>, pane_id: Option<Id>, worktree_id: Option<Id>, level: AttentionLevel, message: String) -> Result<Value, RpcError> {
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

    async fn process_kill_tree(self: &Arc<Self>, pid: u32) -> Result<Value, RpcError> {
        let inner = self.lock();
        let owned = crate::monitor::classify_all(&inner).into_iter().any(|p| p.pid == pid && p.ownership == Ownership::Owned);
        if !owned {
            return Err(err(ErrorCode::Unsupported, format!("pid {pid} is not owned by a Tomo pane; refusing to kill it")));
        }
        procs::kill_tree(&inner.proc_rows, pid);
        Ok(Value::Null)
    }

    async fn agent_spawn(self: &Arc<Self>, spec: AgentSpawn) -> Result<Value, RpcError> {
        let mut inner = self.lock();
        let (worktree_id, cwd) = match (&spec.worktree_id, &spec.cwd, &spec.split_from) {
            (None, None, Some(from)) => {
                let p = inner.panes.get(from).ok_or_else(|| err(ErrorCode::NotFound, "pane not found"))?;
                (p.row.worktree_id.clone(), p.row.cwd.clone())
            }
            _ => Self::worktree_for_spawn(&inner.worktrees, spec.worktree_id.as_deref(), spec.cwd.as_deref())?,
        };
        let plan = providers::launch(&inner.config, spec.kind, spec.resume.as_deref(), &self.paths.integrations_dir, &spec.extra_args);
        let line = agents::shell_line(&plan.argv);
        let tab_id = if spec.new_tab { Some(Self::create_tab(&mut inner, &worktree_id, Some(spec.kind.label().to_string())).id) } else { spec.tab_id.clone() };
        let (tab_id, pane_id) = self.spawn_in_worktree(
            &mut inner,
            &worktree_id,
            cwd,
            SpawnSpec {
                tab_id: tab_id.as_deref(),
                split_from: spec.split_from.as_deref(),
                agent: Some((spec.kind, plan.session_ref, line)),
                ..SpawnSpec::default()
            },
        )?;
        ok(SpawnResult {
            pane: Self::pane_of(&inner, &pane_id)?,
            tab: Self::tab_view(&inner, &inner.tabs[&tab_id]),
            agent: inner.agents.get(&pane_id).cloned(),
        })
    }

    async fn pane_kill_tree(self: &Arc<Self>, pane_id: Id) -> Result<Value, RpcError> {
        let mut inner = self.lock();
        let pid = inner.panes.get(&pane_id).and_then(|p| p.pty.as_ref()).map(|p| p.pid).ok_or_else(|| err(ErrorCode::NotFound, "pane not live"))?;
        Self::set_stop_intent(&mut inner, &pane_id);
        for child in procs::descendants(&inner.proc_rows, pid) {
            procs::kill_tree(&inner.proc_rows, child);
        }
        Ok(Value::Null)
    }

    async fn pane_attach(self: &Arc<Self>, client_id: u64, pane_id: Id) -> Result<Value, RpcError> {
        let mut inner = self.lock();
        Self::terminal_only(&inner, &pane_id)?;
        let snapshot =
            crate::pty::strip_terminal_queries(&inner.panes.get(&pane_id).ok_or_else(|| err(ErrorCode::NotFound, "pane not found"))?.scrollback.snapshot());
        let view = Self::pane_view(&inner, &pane_id);
        if let Some(c) = inner.clients.get_mut(&client_id) {
            c.attached.insert(pane_id.clone());
            let frame = Frame::Event { seq: 0, event: Event::PaneOutput { pane_id, data_base64: B64.encode(snapshot) } };
            let _ = c.tx.send(serde_json::to_string(&frame).unwrap_or_default());
        }
        ok(view)
    }

    async fn pane_resize(self: &Arc<Self>, pane_id: Id, cols: u16, rows: u16) -> Result<Value, RpcError> {
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

    async fn pane_focus(self: &Arc<Self>, pane_id: Id) -> Result<Value, RpcError> {
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

    async fn pane_close(self: &Arc<Self>, pane_id: Id, force: bool) -> Result<Value, RpcError> {
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

    async fn layout_resize(self: &Arc<Self>, tab_id: Id, split_id: Id, ratio: f64) -> Result<Value, RpcError> {
        let mut inner = self.lock();
        let tab = inner.tabs.get_mut(&tab_id).ok_or_else(|| err(ErrorCode::NotFound, "tab not found"))?;
        tab.layout = layout::resize(&tab.layout, &split_id, ratio);
        let tab = tab.clone();
        inner.store.tab_upsert(&tab).map_err(internal)?;
        Self::emit_tabs(&mut inner, &tab.worktree_id);
        Ok(Value::Null)
    }

    async fn tab_activate(self: &Arc<Self>, tab_id: Id) -> Result<Value, RpcError> {
        Self::activate_tab(&mut self.lock(), &tab_id)?;
        Ok(Value::Null)
    }

    pub(crate) fn activate_tab(inner: &mut Inner, tab_id: &str) -> Result<(), RpcError> {
        let worktree_id = inner.tabs.get(tab_id).ok_or_else(|| err(ErrorCode::NotFound, "tab not found"))?.worktree_id.clone();
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
            Self::emit_tabs(inner, &worktree_id);
        }
        Ok(())
    }

    async fn tab_close(self: &Arc<Self>, tab_id: Id, force: bool) -> Result<Value, RpcError> {
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

    async fn tab_create(self: &Arc<Self>, worktree_id: Id, title: Option<String>) -> Result<Value, RpcError> {
        let mut inner = self.lock();
        let cwd = inner.worktrees.get(&worktree_id).ok_or_else(|| err(ErrorCode::NotFound, "worktree not found"))?.path.clone();
        let tab = Self::create_tab(&mut inner, &worktree_id, title);
        for t in inner.tabs.values().filter(|t| t.worktree_id == worktree_id && t.id != tab.id).cloned().collect::<Vec<_>>() {
            let _ = inner.store.tab_upsert(&t);
        }
        self.spawn_in_worktree(&mut inner, &worktree_id, cwd, SpawnSpec { tab_id: Some(&tab.id), ..SpawnSpec::default() })?;
        ok(Self::tab_view(&inner, &inner.tabs[&tab.id]))
    }

    async fn metadata_set(self: &Arc<Self>, worktree_id: Id, patch: MetadataPatch) -> Result<Value, RpcError> {
        let mut inner = self.lock();
        let w = inner.worktrees.get(&worktree_id).ok_or_else(|| err(ErrorCode::NotFound, "worktree not found"))?;
        let next = checked_metadata(&inner.config.states, patch.apply(&w.metadata))?;
        let previous_state = w.metadata.state.clone();
        let row = Self::meta_row_of(&inner, w, next.clone());
        inner.store.meta_upsert(&row).map_err(internal)?;
        inner.worktrees.get_mut(&worktree_id).unwrap().metadata = next.clone();
        if previous_state != next.state {
            let mut ev = events::envelope(&inner, "worktree.state_changed", Some(&worktree_id));
            ev.previous_state = previous_state.clone();
            inner.hook_queue.push(ev);
            let mut ev = activity::event(CoreActivity::StateChanged, Some(&worktree_id), format!("state → {}", next.state.as_deref().unwrap_or("none")));
            ev.detail = Some(Self::worktree_name(&inner, &worktree_id));
            ev.payload = json!({ "state": next.state, "previous_state": previous_state });
            Self::record(&mut inner, ev);
        }
        Self::emit(&mut inner, Event::MetadataChanged { worktree_id: worktree_id.clone(), metadata: next.clone() });
        let worktrees = Self::worktree_views(&inner);
        Self::emit(&mut inner, Event::WorktreesChanged { worktrees });
        ok(next)
    }

    async fn worktree_open(self: &Arc<Self>, worktree_id: Id) -> Result<Value, RpcError> {
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
            self.spawn_in_worktree(&mut inner, &worktree_id, cwd, SpawnSpec::default())?;
        }
        Self::touch(&mut inner, &worktree_id);
        let w = Self::worktree_view(&inner, &inner.worktrees[&worktree_id]);
        let tabs = Self::tabs_of(&inner, &worktree_id);
        let handle = self.clone();
        let id = worktree_id.clone();
        tokio::spawn(async move {
            handle.refresh_git(&id).await;
        });
        ok(WorktreeOpened { worktree: w, tabs })
    }

    async fn worktree_create(self: &Arc<Self>, spec: WorktreeCreate) -> Result<Value, RpcError> {
        let (repo_path, parent_dir, branch_prefix, name) = {
            let inner = self.lock();
            let repo = inner.repos.iter().find(|r| r.id == spec.repo_id).ok_or_else(|| err(ErrorCode::NotFound, "repo not found"))?;
            if let Some(patch) = &spec.metadata {
                checked_metadata(&inner.config.states, patch.apply(&WorktreeMetadata::default()))?;
            }
            let name = match (&spec.path, self.seams.worktree_namer) {
                (None, Some(namer)) => namer(&inner.store, &spec)?,
                _ => None,
            };
            (repo.path.clone(), inner.config.worktree_parent_dir.clone(), inner.config.branch_prefix.clone(), name)
        };
        let parent = config::worktree_parent(parent_dir.as_deref(), &repo_path);
        let path = match (&spec.path, &name) {
            (Some(p), _) => config::expand_tilde(p),
            (None, Some(name)) => parent.join(name),
            (None, None) => parent.join(spec.branch.replace('/', "-")),
        };
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).map_err(|e| err(ErrorCode::Io, format!("{}: {e}", dir.display())))?;
        }
        let wanted = spec.branch.trim();
        let dir_name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        let branch = match wanted.is_empty() {
            true => config::default_branch(&branch_prefix, &dir_name),
            false => wanted.to_string(),
        };
        git::worktree_add(&repo_path, &path, &branch, spec.new_branch || wanted.is_empty(), spec.start_ref.as_deref())
            .await
            .map_err(|e| err(ErrorCode::Git, e.to_string()))?;
        self.discover(Summaries::All).await.map_err(internal)?;
        let id = path_id(&canonical(&path));
        let mut inner = self.lock();
        let created = CreatedWorktree { id: id.clone(), repo_id: spec.repo_id.clone(), name };
        for seam in &self.seams.worktree_created {
            seam(&mut inner, &created)?;
        }
        if let (Some(patch), Some(w)) = (&spec.metadata, inner.worktrees.get(&id)) {
            let metadata = checked_metadata(&inner.config.states, patch.apply(&w.metadata))?;
            let row = Self::meta_row_of(&inner, w, metadata.clone());
            inner.store.meta_upsert(&row).map_err(internal)?;
            if let Some(w) = inner.worktrees.get_mut(&id) {
                w.metadata = metadata;
            }
        }
        let ev = events::envelope(&inner, "worktree.created", Some(&id));
        inner.hook_queue.push(ev);
        inner
            .worktrees
            .get(&id)
            .map(|w| Self::worktree_view(&inner, w))
            .ok_or_else(|| err(ErrorCode::Internal, "worktree created but not discovered"))
            .and_then(ok)
    }

    async fn repo_remove(self: &Arc<Self>, repo_id: Id) -> Result<Value, RpcError> {
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

    async fn pane_zoom(self: &Arc<Self>, pane_id: Option<Id>, tab_id: Option<Id>) -> Result<Value, RpcError> {
        let mut inner = self.lock();
        let tab_id = match (&pane_id, tab_id) {
            (Some(p), _) => inner.panes.get(p).map(|x| x.row.tab_id.clone()).ok_or_else(|| err(ErrorCode::NotFound, "pane not found"))?,
            (None, Some(t)) => t,
            (None, None) => return Err(err(ErrorCode::BadRequest, "pane_id or tab_id required")),
        };
        Self::emit(&mut inner, Event::ZoomRequest { tab_id, pane_id });
        Ok(Value::Null)
    }

    async fn pane_swap(self: &Arc<Self>, pane_a: Id, pane_b: Id) -> Result<Value, RpcError> {
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

    async fn layout_rotate(self: &Arc<Self>, tab_id: Id, split_id: Option<Id>) -> Result<Value, RpcError> {
        let mut inner = self.lock();
        let tab = inner.tabs.get_mut(&tab_id).ok_or_else(|| err(ErrorCode::NotFound, "tab not found"))?;
        let target = split_id
            .or_else(|| tab.active_pane_id.as_deref().and_then(|p| layout::split_of(&tab.layout, p)))
            .ok_or_else(|| err(ErrorCode::BadRequest, "tab has no split to rotate"))?;
        tab.layout = layout::rotate(&tab.layout, &target);
        let tab = tab.clone();
        inner.store.tab_upsert(&tab).map_err(internal)?;
        Self::emit_tabs(&mut inner, &tab.worktree_id);
        ok(Self::tab_view(&inner, &tab))
    }

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
            Call::Subscribe => ok(self.subscribe(client_id)?),
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
                providers::install(&self.tomo_bin).map_err(internal)?;
                ok(providers::installed())
            }
            Call::IntegrationsStatus => {
                let mut inner = self.lock();
                let list = providers::status(&inner.config);
                providers::record_health(&mut inner, &list);
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
            Call::LayoutRotate { tab_id, split_id } => self.layout_rotate(tab_id, split_id).await,
            Call::PaneSwap { pane_a, pane_b } => self.pane_swap(pane_a, pane_b).await,
            Call::PaneZoom { pane_id, tab_id } => self.pane_zoom(pane_id, tab_id).await,
            Call::RepoList => ok(Self::repo_views(&self.lock())),
            Call::RepoAdd { path } => {
                let top = git::toplevel(&config::expand_tilde(&path)).await.map_err(|e| err(ErrorCode::Git, e.to_string()))?;
                let top = canonical(&top);
                let id = path_id(&top);
                self.lock().store.repo_add(&id, &top, now_ms()).map_err(internal)?;
                self.discover(Summaries::All).await.map_err(internal)?;
                ok(repo_view(id, top).await)
            }
            Call::RepoRemove { repo_id } => self.repo_remove(repo_id).await,
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
            Call::WorktreeCreate(spec) => self.worktree_create(spec).await,
            Call::WorktreeArchive { worktree_id, checkpoint } => self.archive_worktree(&worktree_id, checkpoint).await,
            Call::WorktreeRestore { worktree_id } => self.restore_worktree(&worktree_id).await,
            Call::WorktreeOpen { worktree_id } => self.worktree_open(worktree_id).await,
            Call::WorktreeResolve { path } => {
                let inner = self.lock();
                let id = Self::resolve_worktree(&inner.worktrees, &path)
                    .ok_or_else(|| err(ErrorCode::NotFound, format!("{} is not inside a known worktree", path.display())))?;
                ok(Self::worktree_view(&inner, &inner.worktrees[&id]))
            }
            Call::MetadataGet { worktree_id } => {
                let inner = self.lock();
                inner.worktrees.get(&worktree_id).map(|w| w.metadata.clone()).ok_or_else(|| err(ErrorCode::NotFound, "worktree not found")).and_then(ok)
            }
            Call::MetadataSet { worktree_id, patch } => self.metadata_set(worktree_id, patch).await,
            Call::TabCreate { worktree_id, title } => self.tab_create(worktree_id, title).await,
            Call::TabClose { tab_id, force } => self.tab_close(tab_id, force).await,
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
            Call::PaneScreen { pane_id } => {
                let inner = self.lock();
                let pane = inner.panes.get(&pane_id).ok_or_else(|| err(ErrorCode::NotFound, "pane not found"))?;
                ok(pane.screen.as_ref().map(|s| s.rows()).unwrap_or_default())
            }
            Call::PaneTail { pane_id, lines } => {
                let inner = self.lock();
                let pane = inner.panes.get(&pane_id).ok_or_else(|| err(ErrorCode::NotFound, "pane not found"))?;
                ok(pane.scrollback.plain_tail(lines.unwrap_or(8).clamp(1, 200) as usize))
            }
            Call::TabActivate { tab_id } => self.tab_activate(tab_id).await,
            Call::LayoutResize { tab_id, split_id, ratio } => self.layout_resize(tab_id, split_id, ratio).await,
            Call::PaneList { worktree_id } => ok(Self::pane_views(&self.lock(), worktree_id.as_deref())),
            Call::PaneCreate(spec) => {
                let mut inner = self.lock();
                let (worktree_id, cwd) = Self::worktree_for_spawn(&inner.worktrees, spec.worktree_id.as_deref(), spec.cwd.as_deref())?;
                let (tab_id, pane_id) = self.spawn_in_worktree(
                    &mut inner,
                    &worktree_id,
                    cwd,
                    SpawnSpec { command: spec.command.as_deref(), title: spec.title, ..SpawnSpec::default() },
                )?;
                ok(Self::pane_result(&inner, &pane_id, &tab_id)?)
            }
            Call::PaneSplit { pane_id, direction, command } => {
                let mut inner = self.lock();
                let (worktree_id, cwd) = {
                    let p = inner.panes.get(&pane_id).ok_or_else(|| err(ErrorCode::NotFound, "pane not found"))?;
                    (p.row.worktree_id.clone(), p.row.cwd.clone())
                };
                let (tab_id, new_id) = self.spawn_in_worktree(
                    &mut inner,
                    &worktree_id,
                    cwd,
                    SpawnSpec { split_from: Some(&pane_id), direction, command: command.as_deref(), ..SpawnSpec::default() },
                )?;
                ok(Self::pane_result(&inner, &new_id, &tab_id)?)
            }
            Call::PaneClose { pane_id, force } => self.pane_close(pane_id, force).await,
            Call::PaneFocus { pane_id } => self.pane_focus(pane_id).await,
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
            Call::PaneResize { pane_id, cols, rows } => self.pane_resize(pane_id, cols, rows).await,
            Call::PaneAttach { pane_id } => self.pane_attach(client_id, pane_id).await,
            Call::PaneDetach { pane_id } => {
                if let Some(c) = self.lock().clients.get_mut(&client_id) {
                    c.attached.remove(&pane_id);
                }
                Ok(Value::Null)
            }
            Call::PaneKillTree { pane_id } => self.pane_kill_tree(pane_id).await,
            Call::AgentList { worktree_id } => {
                let inner = self.lock();
                let mut agents: Vec<AgentPresence> =
                    inner.agents.values().filter(|a| worktree_id.as_deref().is_none_or(|w| a.worktree_id == w)).cloned().collect();
                agents.sort_by(|a, b| (&a.worktree_id, &a.pane_id).cmp(&(&b.worktree_id, &b.pane_id)));
                ok(agents)
            }
            Call::AgentSpawn(spec) => self.agent_spawn(spec).await,
            Call::AgentHook { kind, pane_id, payload, at_ms } => {
                let outcome = providers::hook_outcome(kind, &payload);
                let mut inner = self.lock();
                if !inner.panes.contains_key(&pane_id) {
                    return Ok(Value::Null);
                }
                Self::apply_report(
                    &mut inner,
                    &AgentReport { pane_id, kind, state: outcome.state, session_ref: outcome.session_ref, authority: Authority::Lifecycle, at_ms },
                    None,
                );
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
                ok(infos.into_iter().filter(|p| worktree_id.as_deref().is_none_or(|w| p.worktree_id.as_deref() == Some(w))).collect::<Vec<_>>())
            }
            Call::ProcessKillTree { pid } => self.process_kill_tree(pid).await,
            Call::Notify { pane_id, worktree_id, level, message } => self.notify(pane_id, worktree_id, level, message).await,
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
            Call::BranchList { repo_id, limit } => {
                let repo_path = {
                    let inner = self.lock();
                    inner.repos.iter().find(|r| r.id == repo_id).ok_or_else(|| err(ErrorCode::NotFound, "repo not found"))?.path.clone()
                };
                ok(git::list_branches(&repo_path, limit.unwrap_or(git::BRANCH_LIMIT)).await.map_err(|e| err(ErrorCode::Git, e.to_string()))?)
            }
            Call::FsList { worktree_id, rel_path } => self.fs_list(worktree_id, rel_path).await,
            Call::FsRecent { worktree_id, limit } => self.fs_recent(worktree_id, limit).await,
            Call::OpenExternal { worktree_id, rel_path, target } => self.open_external(worktree_id, rel_path, target).await,
            Call::OpenLocation { path, line, col } => self.open_location(path, line, col).await,
            Call::SessionList { worktree_id, limit } => {
                let cwd = self.lock().worktrees.get(&worktree_id).map(|w| w.path.clone()).ok_or_else(|| err(ErrorCode::NotFound, "worktree not found"))?;
                let home = dirs::home_dir().ok_or_else(|| err(ErrorCode::Internal, "no home directory"))?;
                let list = tokio::task::spawn_blocking(move || providers::sessions(&home, &cwd, limit.unwrap_or(20)))
                    .await
                    .map_err(|e| err(ErrorCode::Internal, e.to_string()))?;
                ok(list)
            }
            Call::DiagnosticsList { limit } => {
                let inner = self.lock();
                ok(inner.diagnostics.iter().rev().take(limit.map_or(DIAGNOSTICS_KEPT, |n| n as usize)).cloned().collect::<Vec<_>>())
            }
            Call::SystemStats => ok(crate::system::fresh(self).await),
            Call::ActivityList(query) => {
                let inner = self.lock();
                let waiting: Vec<Id> = inner.agents.values().filter(|a| a.state == AgentState::Waiting).map(|a| a.pane_id.clone()).collect();
                ok(inner.store.activity_list(&query, &waiting).map_err(internal)?)
            }
            Call::CheckpointCreate(spec) => self.checkpoint_create(spec).await,
            Call::CheckpointResolve { id } => self.checkpoint_resolve(id).await,
            Call::BrowserOpen { worktree_id, url, tab_id } => self.browser_open(worktree_id, url, tab_id),
            Call::BrowserNavigate { pane_id, url } => self.browser_navigate(pane_id, url),
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

// Bracketed paste keeps a multi-line block as one input in Claude, Codex, and Pi;
// a bare newline would submit the first line alone. The final CR submits.
fn pasted(text: &str) -> String {
    format!("\x1b[200~{text}\x1b[201~\r")
}

pub async fn repo_view(id: Id, path: PathBuf) -> Repo {
    let exists = path.exists();
    let remote_url = if exists { git::remote_url(&path).await } else { None };
    Repo { id, name: repo_name(&path), exists, path, remote_url, worktree_parent: None, branch_prefix: None }
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

pub struct ArchiveTarget {
    pub path: PathBuf,
    pub repo_path: PathBuf,
    pub branch: String,
    pub head: String,
}

pub struct RestoreTarget {
    pub path: PathBuf,
    pub repo_path: PathBuf,
    pub branch: String,
}

pub fn restore_target(w: &WorktreeState, repos: &[Repo], row: &MetaRow) -> Result<RestoreTarget, RpcError> {
    let branch = row.archived_branch.clone().ok_or_else(|| err(ErrorCode::BadRequest, "worktree is not archived or has no branch to restore"))?;
    let repo_path = repos.iter().find(|r| r.id == w.repo_id).map(|r| r.path.clone()).ok_or_else(|| err(ErrorCode::NotFound, "repo not found"))?;
    Ok(RestoreTarget { path: w.path.clone(), repo_path, branch })
}

pub fn checked_metadata(states: &[StateDef], m: WorktreeMetadata) -> Result<WorktreeMetadata, RpcError> {
    let text = |v: Option<String>| v.map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
    let next = WorktreeMetadata {
        display_name: text(m.display_name),
        project: text(m.project),
        state: text(m.state),
        tags: m.tags.into_iter().map(|t| t.trim().trim_start_matches('#').to_string()).filter(|t| !t.is_empty()).collect(),
    };
    match &next.state {
        Some(st) if !states.iter().any(|d| &d.id == st) => {
            let known: Vec<&str> = states.iter().map(|d| d.id.as_str()).collect();
            Err(err(ErrorCode::BadRequest, format!("unknown state {st:?}; known states: {}", known.join(", "))))
        }
        _ => Ok(next),
    }
}

pub fn archive_target(w: &WorktreeState, repos: &[Repo], archiving: &HashSet<Id>) -> Result<ArchiveTarget, RpcError> {
    if w.is_main {
        return Err(err(ErrorCode::BadRequest, "the main worktree cannot be archived"));
    }
    if w.archived_at_ms.is_some() {
        return Err(err(ErrorCode::Conflict, "worktree is already archived"));
    }
    if archiving.contains(&w.id) {
        return Err(err(ErrorCode::Conflict, "worktree is already being archived"));
    }
    let repo_path = repos.iter().find(|r| r.id == w.repo_id).map(|r| r.path.clone()).ok_or_else(|| err(ErrorCode::NotFound, "repo not found"))?;
    Ok(ArchiveTarget { path: w.path.clone(), repo_path, branch: w.branch.clone().unwrap_or_default(), head: w.head.clone() })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn a_repo() -> Repo {
        Repo { id: "r1".into(), path: PathBuf::from("/repo"), name: "repo".into(), exists: true, remote_url: None, worktree_parent: None, branch_prefix: None }
    }

    fn a_worktree() -> WorktreeState {
        WorktreeState {
            id: "w1".into(),
            repo_id: "r1".into(),
            path: PathBuf::from("/repo/wt"),
            branch: Some("feat/x".into()),
            head: "abc1234".into(),
            detached: false,
            is_main: false,
            exists: true,
            gitdir: None,
            git: None,
            metadata: WorktreeMetadata::default(),
            last_active_ms: None,
            first_seen_ms: None,
            archived_at_ms: None,
            infra_name: "tomo-test-0000".into(),
        }
    }

    fn wt(patch: fn(&mut WorktreeState)) -> WorktreeState {
        let mut w = a_worktree();
        patch(&mut w);
        w
    }

    fn a_row(branch: Option<&str>) -> MetaRow {
        MetaRow {
            id: "w1".into(),
            repo_id: "r1".into(),
            path: PathBuf::from("/repo/wt"),
            gitdir: None,
            metadata: WorktreeMetadata::default(),
            last_active_ms: None,
            first_seen_ms: None,
            archived_at_ms: Some(1),
            archived_branch: branch.map(str::to_string),
            infra_name: None,
        }
    }

    fn worktrees(list: Vec<WorktreeState>) -> HashMap<Id, WorktreeState> {
        list.into_iter().map(|w| (w.id.clone(), w)).collect()
    }

    #[test]
    fn a_restore_decides_every_rule_before_it_asks_git() {
        let code = |r: Result<RestoreTarget, RpcError>| r.err().map(|e| e.code);
        let target = restore_target(&a_worktree(), &[a_repo()], &a_row(Some("feat/x"))).expect("an archived worktree restores");
        assert_eq!(target.branch, "feat/x");
        assert_eq!(target.repo_path, PathBuf::from("/repo"));
        assert_eq!(code(restore_target(&a_worktree(), &[a_repo()], &a_row(None))), Some(ErrorCode::BadRequest), "nothing to restore without a branch");
        assert_eq!(code(restore_target(&a_worktree(), &[], &a_row(Some("feat/x")))), Some(ErrorCode::NotFound), "a missing repo refuses");
    }

    #[test]
    fn a_spawn_finds_its_worktree_by_id_or_by_the_directory_it_starts_in() {
        let deep = wt(|w| {
            w.id = "w2".into();
            w.path = PathBuf::from("/repo/wt/sub");
        });
        let all = worktrees(vec![a_worktree(), deep]);

        let (id, cwd) = Daemon::worktree_for_spawn(&all, Some("w1"), None).unwrap();
        assert_eq!((id.as_str(), cwd), ("w1", PathBuf::from("/repo/wt")));

        let (_, cwd) = Daemon::worktree_for_spawn(&all, Some("w1"), Some(Path::new("/elsewhere"))).unwrap();
        assert_eq!(cwd, PathBuf::from("/elsewhere"), "a named worktree keeps the directory it was given");

        let (id, _) = Daemon::worktree_for_spawn(&all, None, Some(Path::new("/repo/wt/sub/deeper"))).unwrap();
        assert_eq!(id, "w2", "the longest matching path wins, not the first");

        assert_eq!(Daemon::worktree_for_spawn(&all, Some("gone"), None).err().map(|e| e.code), Some(ErrorCode::NotFound));
        assert_eq!(Daemon::worktree_for_spawn(&all, None, None).err().map(|e| e.code), Some(ErrorCode::BadRequest));
        assert_eq!(Daemon::worktree_for_spawn(&all, None, Some(Path::new("/tmp"))).err().map(|e| e.code), Some(ErrorCode::NotFound));
        assert_eq!(Daemon::resolve_worktree(&all, Path::new("/tmp")), None);
    }

    #[test]
    fn an_archive_refuses_before_it_marks_the_worktree_in_flight() {
        let repo = a_repo();
        let none = HashSet::new();

        let target = archive_target(&wt(|_| {}), std::slice::from_ref(&repo), &none).expect("a plain worktree archives");
        assert_eq!(target.repo_path, PathBuf::from("/repo"));
        assert_eq!(target.branch, "feat/x");
        assert_eq!(target.head, "abc1234");

        assert_eq!(
            archive_target(&wt(|w| w.branch = None), std::slice::from_ref(&repo), &none).unwrap().branch,
            "",
            "a detached worktree archives with no branch"
        );

        let code = |r: Result<ArchiveTarget, RpcError>| r.err().map(|e| e.code);
        assert_eq!(code(archive_target(&wt(|w| w.is_main = true), std::slice::from_ref(&repo), &none)), Some(ErrorCode::BadRequest));
        assert_eq!(code(archive_target(&wt(|w| w.archived_at_ms = Some(1)), std::slice::from_ref(&repo), &none)), Some(ErrorCode::Conflict));
        assert_eq!(code(archive_target(&wt(|_| {}), std::slice::from_ref(&repo), &HashSet::from(["w1".to_string()]))), Some(ErrorCode::Conflict));
        assert_eq!(code(archive_target(&wt(|_| {}), &[], &none)), Some(ErrorCode::NotFound), "a missing repo refuses, and marks nothing");
    }

    #[test]
    fn problem_change_records_only_appear_change_and_clear() {
        assert_eq!(problem_change("port scan", None, None), None);
        assert_eq!(problem_change("port scan", Some("no token"), Some("no token")), None);
        assert_eq!(problem_change("port scan", None, Some("no token")), Some((DiagnosticLevel::Warning, "port scan: no token".into())));
        assert_eq!(problem_change("port scan", Some("no token"), Some("timeout")), Some((DiagnosticLevel::Warning, "port scan: timeout".into())));
        assert_eq!(problem_change("port scan", Some("timeout"), None), Some((DiagnosticLevel::Info, "port scan: ok again".into())));
    }

    #[test]
    fn a_pending_line_waits_for_a_quiet_tty_and_goes_when_output_never_stops() {
        assert_eq!(pending_action(0, 1_000, 0), Pending::Wait, "no output yet, inside the silent window");
        assert_eq!(pending_action(0, PENDING_SILENT_MS, 0), Pending::Type, "a silent shell profile still gets the line");
        assert_eq!(pending_action(700, 1_000, 0), Pending::Type, "quiet for 300 ms: the prompt is back");
        assert_eq!(pending_action(900, 1_000, 0), Pending::Wait, "output 100 ms ago: a program can hold the tty");
        assert_eq!(pending_action(9_950, 10_000, 0), Pending::Wait, "still busy after 10 s: wait, do not type");
        assert_eq!(pending_action(PENDING_BUSY_MS, PENDING_BUSY_MS, 0), Pending::Drop, "busy at the give-up time");
    }

    #[test]
    fn pasted_wraps_the_text_in_one_bracketed_paste_and_submits() {
        assert_eq!(pasted("a\nb"), "\x1b[200~a\nb\x1b[201~\r");
    }

    fn no_seams() -> Seams {
        Seams { worktree_namer: None, worktree_created: vec![], worktree_rebound: vec![], worktree_files: vec![], pane_exited: vec![], process_polled: vec![] }
    }

    fn repo_fixture(name: &str) -> (PathBuf, PathBuf) {
        let dir = PathBuf::from(format!("/tmp/tomo-daemon-test-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let repo = dir.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        std::fs::create_dir_all(dir.join("data")).unwrap();
        git_in(&repo, &["init", "-q"]);
        git_in(&repo, &["commit", "-q", "--allow-empty", "-m", "init"]);
        (dir, repo)
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_setup_hook_runs_in_its_own_tab_behind_a_plain_terminal() {
        let (dir, repo) = repo_fixture("setup-tab");
        std::fs::write(dir.join("data/config.toml"), "[[hooks]]\nevent = \"worktree.created\"\nmode = \"pane\"\ncommand = \"sleep 30\"\n").unwrap();
        let daemon = Daemon::new(Paths::new(dir.join("data")), no_seams(), Box::new(())).unwrap();
        daemon.lock().config.shell = "/bin/sh".into();
        daemon.handle(0, Call::RepoAdd { path: repo.clone() }).await.unwrap();
        let repo_id = daemon.lock().repos[0].id.clone();
        let spec =
            WorktreeCreate { repo_id, branch: "feat".into(), new_branch: true, start_ref: None, path: Some(dir.join("wt")), name_hint: None, metadata: None };
        let created = daemon.handle(0, Call::WorktreeCreate(spec)).await.unwrap();
        let id = created["id"].as_str().unwrap().to_string();

        let inner = daemon.lock();
        let mut tabs: Vec<&TabRow> = inner.tabs.values().filter(|t| t.worktree_id == id).collect();
        tabs.sort_by_key(|t| t.position);
        assert_eq!(tabs.iter().map(|t| (t.title.as_str(), t.is_active)).collect::<Vec<_>>(), vec![("Tab 1", true), ("Setup", false)]);
        let setup_pane = layout::pane_ids(&tabs[1].layout)[0].clone();
        assert!(inner.panes[&setup_pane].pending_line.is_none(), "the hook runs as the pane command, not as typed input");
        drop(inner);
        daemon.shutdown();
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_worktree_is_created_with_its_metadata_before_the_created_hook_sees_it() {
        let (dir, repo) = repo_fixture("create-metadata");
        let daemon = Daemon::new(Paths::new(dir.join("data")), no_seams(), Box::new(())).unwrap();
        daemon.handle_inner(0, Call::RepoAdd { path: repo.clone() }).await.unwrap();
        let repo_id = daemon.lock().repos[0].id.clone();
        let spec = |name: &str, state: Option<&str>| WorktreeCreate {
            repo_id: repo_id.clone(),
            branch: name.into(),
            new_branch: true,
            start_ref: None,
            path: Some(dir.join(name)),
            name_hint: None,
            metadata: Some(MetadataPatch {
                project: Some(Some(" Holly ".into())),
                tags: Some(vec!["#labor-relations".into()]),
                state: state.map(|s| Some(s.to_string())),
                ..MetadataPatch::default()
            }),
        };

        let refused = daemon.handle_inner(0, Call::WorktreeCreate(spec("bad", Some("no-such-state")))).await;
        assert_eq!(refused.err().map(|e| e.code), Some(ErrorCode::BadRequest));
        assert!(!dir.join("bad").exists(), "a refused create makes no worktree");

        let created = daemon.handle_inner(0, Call::WorktreeCreate(spec("good", None))).await.unwrap();
        let id = created["id"].as_str().unwrap().to_string();
        let inner = daemon.lock();
        let expected = WorktreeMetadata { project: Some("Holly".into()), tags: vec!["labor-relations".into()], ..WorktreeMetadata::default() };
        assert_eq!(inner.worktrees[&id].metadata, expected);
        assert_eq!(inner.store.meta_one(&id).unwrap().map(|m| m.metadata), Some(expected));
        let hook = inner.hook_queue.iter().find(|e| e.event == "worktree.created").and_then(|e| e.worktree.clone()).unwrap();
        assert_eq!((hook.project.as_deref(), hook.tags), (Some("Holly"), vec!["labor-relations".to_string()]));
        drop(inner);
        let _ = std::fs::remove_dir_all(&dir);
    }

    fn git_in(dir: &Path, args: &[&str]) {
        let out = std::process::Command::new("git").args(["-c", "user.email=t@t", "-c", "user.name=t"]).args(args).current_dir(dir).output().unwrap();
        assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_row_copied_from_another_machine_joins_the_worktree_at_its_path() {
        let dir = PathBuf::from(format!("/tmp/tomo-daemon-test-stale-id-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let repo = dir.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        std::fs::create_dir_all(dir.join("data")).unwrap();
        git_in(&repo, &["init", "-q"]);
        git_in(&repo, &["commit", "-q", "--allow-empty", "-m", "init"]);
        git_in(&repo, &["worktree", "add", "-q", "-b", "feat", "../moriya"]);
        let linked = canonical(&dir.join("moriya"));

        let daemon = Daemon::new(Paths::new(dir.join("data")), no_seams(), Box::new(())).unwrap();
        daemon.handle_inner(0, Call::RepoAdd { path: repo.clone() }).await.unwrap();
        let repo_id = daemon.lock().repos[0].id.clone();

        let stale = path_id(Path::new("/Users/someone-else/Projects/moriya"));
        {
            let mut inner = daemon.lock();
            let row = MetaRow {
                id: stale.clone(),
                repo_id,
                path: linked.clone(),
                gitdir: Some("moriya".into()),
                metadata: WorktreeMetadata { display_name: Some("Moriya".into()), ..Default::default() },
                last_active_ms: None,
                first_seen_ms: Some(1),
                archived_at_ms: None,
                archived_branch: None,
                infra_name: None,
            };
            inner.store.meta_upsert(&row).unwrap();
            let tab = TabRow {
                id: "t1".into(),
                worktree_id: stale.clone(),
                title: "t".into(),
                position: 0,
                layout: LayoutNode::Leaf { pane_id: "p1".into() },
                active_pane_id: None,
                is_active: true,
            };
            inner.store.tab_upsert(&tab).unwrap();
            inner.tabs.insert(tab.id.clone(), tab);
        }
        daemon.discover(Summaries::Cached).await.unwrap();

        let inner = daemon.lock();
        let at_path: Vec<&WorktreeState> = inner.worktrees.values().filter(|w| w.path == linked).collect();
        assert_eq!(at_path.len(), 1, "one record per path, not a live one and a ghost: {:?}", at_path.iter().map(|w| &w.id).collect::<Vec<_>>());
        let w = at_path[0];
        assert_eq!(w.id, path_id(&linked));
        assert!(w.exists);
        assert_eq!(w.metadata.display_name.as_deref(), Some("Moriya"), "the name follows the row");
        assert_eq!(inner.tabs["t1"].worktree_id, w.id, "the tab follows the row");
        assert!(inner.store.meta_all().unwrap().iter().all(|m| m.id != stale), "the stale row is gone from the store");
        drop(inner);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
