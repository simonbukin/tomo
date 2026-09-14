use crate::agents;
use crate::config::{self, Paths};
use crate::git;
use crate::layout;
use crate::procs::{self, ProcMonitor, ProcRow};
use crate::pty::{PtySession, Scrollback, Spawn};
use crate::events;
use crate::features::towns;
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
    pub pending_line: Option<String>,
    pub last_output_ms: u64,
    pub scrollback: Scrollback,
}

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
    pub town_by_worktree: HashMap<Id, String>,
    pub discovered_once: bool,
    pub last_full_poll_ms: u64,
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
}

pub fn err(code: ErrorCode, msg: impl Into<String>) -> RpcError {
    RpcError { code, message: msg.into() }
}

fn internal(e: anyhow::Error) -> RpcError {
    err(ErrorCode::Internal, e.to_string())
}

fn new_id() -> Id {
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

fn ok<T: serde::Serialize>(v: T) -> Result<Value, RpcError> {
    serde_json::to_value(v).map_err(|e| err(ErrorCode::Internal, e.to_string()))
}

impl Daemon {
    pub fn new(paths: Paths) -> Result<Arc<Self>> {
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
                town_by_worktree: HashMap::new(),
                discovered_once: false,
                last_full_poll_ms: 0,
            }),
            stop: tokio::sync::Notify::new(),
            refresh: tokio::sync::Notify::new(),
            repos_changed: tokio::sync::Notify::new(),
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

    fn emit_tabs(inner: &mut Inner, worktree_id: &str) {
        for t in inner.tabs.values().filter(|t| t.worktree_id == worktree_id && !layout::is_valid(&t.layout)) {
            tracing::warn!("tab {} has an invalid layout: {:?}", t.id, t.layout);
        }
        let tabs = Self::tabs_of(inner, worktree_id);
        Self::emit(inner, Event::TabsChanged { worktree_id: worktree_id.to_string(), tabs });
    }

    fn emit_pane(inner: &mut Inner, pane_id: &str) {
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
            town_slug: inner.town_by_worktree.get(&w.id).cloned(),
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
            live: p.pty.is_some() && p.exit_code.is_none(),
            origin: p.origin,
            exit_code: p.exit_code,
            agent,
            created_at_ms: p.row.created_at_ms,
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
                    inner.store.rebind_worktree(&moved.id, &id, &path).ok()?;
                    Self::rebind_runtime(&mut inner, &moved.id, &id);
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
        inner.town_by_worktree = inner.store.town_unlocks().unwrap_or_default().into_iter().map(|u| (u.worktree_id, u.slug)).collect();
        for id in fresh {
            let ev = events::envelope(&inner, "worktree.discovered", Some(&id));
            inner.hook_queue.push(ev);
        }
        let repos = Self::repo_views(&inner);
        Self::emit(&mut inner, Event::ReposChanged { repos });
        let worktrees = Self::worktree_views(&inner);
        Self::emit(&mut inner, Event::WorktreesChanged { worktrees });
        drop(inner);
        self.flush_hooks();
        Ok(())
    }

    /// Dispatches hook events queued while the state lock was held.
    pub fn flush_hooks(self: &Arc<Self>) {
        let queued: Vec<HookEvent> = std::mem::take(&mut self.lock().hook_queue);
        for ev in queued {
            self.dispatch(ev);
        }
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

    fn touch(inner: &mut Inner, worktree_id: &str) {
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
        Self::emit(&mut inner, Event::PaneExited { pane_id: pane_id.to_string(), exit_code: code });
        if let Some(agent) = inner.agents.get_mut(pane_id) {
            agent.state = AgentState::Exited;
            agent.authority = Authority::Lifecycle;
            agent.updated_at_ms = now_ms();
            let agent = agent.clone();
            Self::emit(&mut inner, Event::AgentChanged { agent });
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
        inner.agents.remove(pane_id);
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

    fn create_tab(inner: &mut Inner, worktree_id: &str, title: Option<String>) -> TabRow {
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
    fn create_pane(
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
        };
        inner.store.pane_upsert(&row)?;
        inner.panes.insert(
            id.clone(),
            PaneState { row, pty: None, origin, exit_code: None, process_title: None, pending_line, last_output_ms: 0, scrollback: Scrollback::default() },
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
            Self::emit(inner, Event::AgentChanged { agent: presence });
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
        for row in panes {
            if !referenced.contains(&row.id) {
                let _ = inner.store.pane_delete(&row.id);
                continue;
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
                PaneState { row: row.clone(), pty: None, origin, exit_code: None, process_title: None, pending_line: pending, last_output_ms: 0, scrollback },
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

    pub fn shutdown(&self) {
        let inner = self.lock();
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
        if previous != Some(next.state) && next.state != AgentState::Unknown {
            let name = if previous.is_none() { "agent.started".to_string() } else { format!("agent.{}", next.state.name()) };
            let mut ev = events::envelope(inner, &name, Some(&worktree_id));
            ev.pane = inner.panes.get(&report.pane_id).map(|p| HookPane { id: p.row.id.clone(), tab_id: p.row.tab_id.clone(), cwd: p.row.cwd.clone() });
            ev.agent = Some(HookAgent { kind: next.kind, state: next.state, session_ref: next.session_ref.clone() });
            inner.hook_queue.push(ev);
        }
        if next.state == AgentState::Waiting && previous != Some(AgentState::Waiting) {
            Self::add_attention(inner, &worktree_id, Some(&report.pane_id), AttentionLevel::Attention, format!("{} is waiting for you", next.kind.label()));
        }
        if next.state != AgentState::Waiting && previous == Some(AgentState::Waiting) {
            let _ = inner.store.attention_view_pane(&report.pane_id, now_ms());
        }
    }

    fn add_attention(inner: &mut Inner, worktree_id: &str, pane_id: Option<&str>, level: AttentionLevel, message: String) {
        let duplicate = inner
            .store
            .attention_list()
            .unwrap_or_default()
            .iter()
            .any(|a| a.viewed_at_ms.is_none() && a.pane_id.as_deref() == pane_id && pane_id.is_some() && a.message == message);
        if duplicate {
            return;
        }
        let item = AttentionItem {
            id: new_id(),
            worktree_id: worktree_id.to_string(),
            pane_id: pane_id.map(str::to_string),
            level,
            message,
            created_at_ms: now_ms(),
            viewed_at_ms: None,
        };
        let _ = inner.store.attention_insert(&item);
        let mut ev = events::envelope(inner, "attention.created", Some(worktree_id));
        ev.attention = Some(item.clone());
        ev.pane = pane_id.and_then(|p| inner.panes.get(p)).map(|p| HookPane { id: p.row.id.clone(), tab_id: p.row.tab_id.clone(), cwd: p.row.cwd.clone() });
        inner.hook_queue.push(ev);
        Self::emit(inner, Event::AttentionAdded { item });
    }

    fn meta_row_of(inner: &Inner, w: &WorktreeState, metadata: WorktreeMetadata) -> MetaRow {
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

    fn remove_cleanup_dirs(path: &Path, names: &[String]) -> usize {
        names.iter().map(|n| path.join(n)).filter(|p| p.is_dir()).filter(|p| std::fs::remove_dir_all(p).is_ok()).count()
    }

    async fn archive_worktree(self: &Arc<Self>, worktree_id: &str) -> Result<Value, RpcError> {
        let (path, repo_path, branch, name, event) = {
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
            (w.path.clone(), repo_path, w.branch.clone().unwrap_or_default(), Self::worktree_view(&inner, &w).name, event)
        };
        let result = self.archive_steps(worktree_id, &path, &repo_path, &branch, &name, event).await;
        let mut inner = self.lock();
        inner.archiving.remove(worktree_id);
        match result {
            Ok(()) => {
                let view = inner.worktrees.get(worktree_id).map(|w| Self::worktree_view(&inner, w));
                let ev = events::envelope(&inner, "worktree.archived", Some(worktree_id));
                inner.hook_queue.push(ev);
                let worktrees = Self::worktree_views(&inner);
                Self::emit(&mut inner, Event::WorktreesChanged { worktrees });
                drop(inner);
                self.flush_hooks();
                view.ok_or_else(|| err(ErrorCode::Internal, "archived worktree vanished")).and_then(ok)
            }
            Err(e) => {
                let worktrees = Self::worktree_views(&inner);
                Self::emit(&mut inner, Event::WorktreesChanged { worktrees });
                Err(e)
            }
        }
    }

    async fn archive_steps(self: &Arc<Self>, worktree_id: &str, path: &Path, repo_path: &Path, branch: &str, name: &str, event: HookEvent) -> Result<(), RpcError> {
        if let Err(run) = self.gate(event).await {
            return Err(err(ErrorCode::Aborted, format!("before_archive hook refused ({}): {}", run.command, run.output_tail.lines().last().unwrap_or(""))));
        }
        {
            let mut inner = self.lock();
            Self::close_worktree_panes(&mut inner, worktree_id);
        }
        let cleanup = self.lock().config.archive_cleanup.clone();
        let dir = path.to_path_buf();
        let removed = tokio::task::spawn_blocking(move || Self::remove_cleanup_dirs(&dir, &cleanup)).await.unwrap_or(0);
        git::worktree_remove(repo_path, path).await.map_err(|e| err(ErrorCode::Git, e.to_string()))?;
        {
            let mut inner = self.lock();
            let Some(w) = inner.worktrees.get(worktree_id).cloned() else { return Err(err(ErrorCode::NotFound, "worktree not found")) };
            let mut row = Self::meta_row_of(&inner, &w, w.metadata.clone());
            row.archived_at_ms = Some(now_ms());
            row.archived_branch = (!branch.is_empty()).then(|| branch.to_string());
            inner.store.meta_upsert(&row).map_err(internal)?;
            Self::emit(&mut inner, Event::Notice { level: NoticeLevel::Info, message: format!("archived {name} ({removed} build dirs removed)") });
        }
        self.discover(Summaries::Cached).await.map_err(internal)?;
        Ok(())
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
        {
            let inner = self.lock();
            inner.store.meta_upsert(&MetaRow { archived_at_ms: None, archived_branch: None, path: path.clone(), ..row }).map_err(internal)?;
        }
        self.discover(Summaries::Cached).await.map_err(internal)?;
        let id = path_id(&canonical(&path));
        let mut inner = self.lock();
        if id != worktree_id {
            let unlock = inner.store.town_unlocks().unwrap_or_default().into_iter().find(|u| u.worktree_id == worktree_id);
            if let Some(mut u) = unlock {
                u.worktree_id = id.clone();
                let _ = inner.store.town_unlock(&u);
                inner.town_by_worktree.insert(id.clone(), u.slug);
            }
        }
        let ev = events::envelope(&inner, "worktree.restored", Some(&id));
        inner.hook_queue.push(ev);
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
            Call::IntegrationsStatus => ok(crate::integrations::status(&self.lock().config)),
            Call::ConfigCheck => {
                let cfg = config::load(&self.paths.config).map_err(internal)?;
                ok(config::check(&cfg))
            }
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
                let (repo_path, parent_dir, unlocked) = {
                    let inner = self.lock();
                    let repo = inner.repos.iter().find(|r| r.id == spec.repo_id).ok_or_else(|| err(ErrorCode::NotFound, "repo not found"))?;
                    let unlocked: HashSet<String> = inner.store.town_unlocks().map_err(internal)?.into_iter().map(|u| u.slug).collect();
                    (repo.path.clone(), inner.config.worktree_parent_dir.clone(), unlocked)
                };
                let parent = parent_dir.unwrap_or_else(|| repo_path.parent().unwrap_or(&repo_path).to_path_buf());
                let town = match (&spec.path, &spec.town_slug) {
                    (Some(_), _) => None,
                    (None, Some(slug)) => Some(towns::find(slug).filter(|t| !unlocked.contains(&t.slug)).ok_or_else(|| err(ErrorCode::BadRequest, format!("town {slug} is unknown or already unlocked")))?),
                    (None, None) => Some(towns::pick(&unlocked).ok_or_else(|| err(ErrorCode::Conflict, "every town is unlocked; pass a path"))?),
                };
                let path = match (&spec.path, town) {
                    (Some(p), _) => config::expand_tilde(p),
                    (None, Some(t)) => parent.join(&t.slug),
                    (None, None) => unreachable!(),
                };
                git::worktree_add(&repo_path, &path, &spec.branch, spec.new_branch, spec.start_ref.as_deref())
                    .await
                    .map_err(|e| err(ErrorCode::Git, e.to_string()))?;
                self.discover(Summaries::All).await.map_err(internal)?;
                let id = path_id(&canonical(&path));
                if let Some(t) = town {
                    let mut inner = self.lock();
                    let unlock = TownUnlock { slug: t.slug.clone(), worktree_id: id.clone(), repo_id: spec.repo_id.clone(), unlocked_at_ms: now_ms() };
                    inner.store.town_unlock(&unlock).map_err(internal)?;
                    inner.town_by_worktree.insert(id.clone(), t.slug.clone());
                    if let Some(w) = inner.worktrees.get_mut(&id) {
                        if w.metadata.display_name.is_none() {
                            w.metadata.display_name = Some(t.name.clone());
                        }
                        let w = w.clone();
                        let row = Self::meta_row_of(&inner, &w, w.metadata.clone());
                        inner.store.meta_upsert(&row).map_err(internal)?;
                    }
                    Self::emit(&mut inner, Event::TownUnlocked { unlock });
                    let worktrees = Self::worktree_views(&inner);
                    Self::emit(&mut inner, Event::WorktreesChanged { worktrees });
                }
                let mut inner = self.lock();
                let ev = events::envelope(&inner, "worktree.created", Some(&id));
                inner.hook_queue.push(ev);
                inner.worktrees.get(&id).map(|w| Self::worktree_view(&inner, w)).ok_or_else(|| err(ErrorCode::Internal, "worktree created but not discovered")).and_then(ok)
            }
            Call::WorktreeArchive { worktree_id } => self.archive_worktree(&worktree_id).await,
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
                next.priority = next.priority.map(|p| p.clamp(1, 4));
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
                    ev.previous_state = previous_state;
                    inner.hook_queue.push(ev);
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
                for p in &panes {
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
                let _ = inner.store.attention_view_pane(&pane_id, now_ms());
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
                let pty = self.lock().panes.get(&pane_id).and_then(|p| p.pty.clone()).ok_or_else(|| err(ErrorCode::NotFound, "pane not live"))?;
                pty.write(&data).map_err(internal)?;
                Ok(Value::Null)
            }
            Call::PaneResize { pane_id, cols, rows } => {
                let mut inner = self.lock();
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
                let inner = self.lock();
                let pid = inner.panes.get(&pane_id).and_then(|p| p.pty.as_ref()).map(|p| p.pid).ok_or_else(|| err(ErrorCode::NotFound, "pane not live"))?;
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
                let (tab_id, pane_id) = self.spawn_in_worktree(
                    &mut inner,
                    &worktree_id,
                    cwd,
                    spec.tab_id.as_deref(),
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
                inner.store.attention_view(&id, now_ms()).map_err(internal)?;
                Self::emit(&mut inner, Event::AttentionViewed { id });
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
                inner.prs.insert(worktree_id.clone(), result.clone());
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

            Call::TownList => {
                let unlocks = self.lock().store.town_unlocks().map_err(internal)?;
                Ok(json!({ "towns": towns::all(), "unlocks": unlocks }))
            }
            Call::TownPick => {
                let unlocked: HashSet<String> = self.lock().store.town_unlocks().map_err(internal)?.into_iter().map(|u| u.slug).collect();
                ok(towns::pick(&unlocked).ok_or_else(|| err(ErrorCode::Conflict, "every town is unlocked"))?)
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
        }
    }
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
