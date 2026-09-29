//! Search across every live worktree: file names, terminal scrollback, agent sessions, and activity.
//!
//! `search` returns at once. Each source runs in its own task and sends `search_results` frames to the
//! calling client only. A newer search of the same client cancels the older one at its next check.
//! File lists, session lists, and session message text stay in memory; see docs/search.md.

use crate::daemon::{err, ok, Daemon};
use crate::{git, providers, pty};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::io::{BufRead, Seek};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use tokio::sync::mpsc::UnboundedSender;
use tomo_proto::*;

pub const DEFAULT_LIMIT: usize = 8;
/// Content scans (terminal and session text) start at this many characters. Shorter queries match nearly every line.
pub const CONTENT_MIN_CHARS: usize = 3;
/// A cached file or session list older than this is used once more and read again in the background.
const STALE_MS: u64 = 30_000;
const ACTIVITY_ROWS: usize = 2_000;
const SESSIONS_PER_WORKTREE: usize = 200;
/// A long content scan sends what it has at this interval.
const STREAM_EVERY_MS: u64 = 50;
/// A scan copies each pane three times (snapshot, plain text, lowercase), so few threads keep the peak memory low.
const SCAN_THREADS: usize = 4;
const SNIPPET_BEFORE: usize = 40;
const SNIPPET_AFTER: usize = 100;

/// The in-memory search state of one daemon. It has its own locks, so a scan never holds the Core lock.
#[derive(Default)]
pub struct Index {
    latest: Mutex<HashMap<u64, u64>>,
    files_gen: AtomicU64,
    files: Mutex<HashMap<Id, Cached<Vec<Name>>>>,
    sessions: Mutex<HashMap<Id, Cached<Vec<AgentSession>>>>,
    transcripts: Mutex<HashMap<PathBuf, Arc<Mutex<Transcript>>>>,
    warming: AtomicBool,
}

struct Cached<T> {
    gen: u64,
    at_ms: u64,
    value: Arc<T>,
}

pub struct Name {
    text: String,
    lower: String,
}

impl Name {
    fn new(text: String) -> Self {
        Name { lower: text.to_lowercase(), text }
    }
}

/// The message text of one session file, read up to `offset`. The file only grows, so a refresh reads the new lines only.
#[derive(Default)]
pub struct Transcript {
    offset: u64,
    messages: Vec<Message>,
}

pub struct Message {
    text: String,
    /// ASCII lowercase, so a byte offset in it is the same offset in `text`.
    lower: String,
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|p| p.into_inner())
}

impl Index {
    /// The watcher saw a Git change: every file list is read again at its next use.
    pub fn files_changed(&self) {
        self.files_gen.fetch_add(1, Ordering::Relaxed);
    }

    #[cfg(test)]
    pub fn stats(&self) -> IndexStats {
        let files = lock(&self.files);
        let transcripts = lock(&self.transcripts);
        let (messages, text_bytes) = transcripts.values().map(|t| {
            let t = lock(t);
            (t.messages.len(), t.messages.iter().map(|m| m.text.len() + m.lower.len()).sum::<usize>())
        }).fold((0, 0), |(a, b), (c, d)| (a + c, b + d));
        IndexStats {
            file_paths: files.values().map(|c| c.value.len()).sum(),
            file_bytes: files.values().flat_map(|c| c.value.iter()).map(|n| n.text.len() + n.lower.len()).sum(),
            sessions: lock(&self.sessions).values().map(|c| c.value.len()).sum(),
            transcripts: transcripts.len(),
            messages,
            text_bytes,
        }
    }
}

#[cfg(test)]
#[derive(Debug)]
pub struct IndexStats {
    pub file_paths: usize,
    pub file_bytes: usize,
    pub sessions: usize,
    pub transcripts: usize,
    pub messages: usize,
    pub text_bytes: usize,
}

// ---------------------------------------------------------------- ranking

/// How well a name matches: the same tiers as `matchText` in `app/src/paletteModel.ts`, so the palette has one ranking model.
/// `app/src/matchCases.json` holds the cases that both implementations must agree on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Grade {
    pub tier: i8,
    pub gaps: u32,
}

pub const FUZZY: i8 = 0;
pub const SUBSTRING: i8 = 1;
pub const PREFIX: i8 = 2;
pub const EXACT: i8 = 3;

impl Grade {
    /// Sorts the better grade first.
    pub fn key(self) -> (std::cmp::Reverse<i8>, u32) {
        (std::cmp::Reverse(self.tier), self.gaps)
    }
}

fn is_word_break(c: char) -> bool {
    c.is_whitespace() || matches!(c, '·' | ':' | '/' | '_' | '-' | '.' | '>')
}

fn fuzzy_gaps(query: &str, text: &str) -> Option<u32> {
    let mut rest = text.chars();
    query.chars().filter(|c| !c.is_whitespace()).try_fold(0u32, |gaps, q| {
        let skipped = rest.by_ref().position(|c| c == q)?;
        Some(gaps + skipped as u32)
    })
}

/// Grades a lowercase `text` against a trimmed, lowercase `query`. `None` when it does not match.
pub fn grade(query: &str, text: &str) -> Option<Grade> {
    let tier = if query.is_empty() || text == query {
        EXACT
    } else if text.starts_with(query) || text.split(is_word_break).any(|w| w.starts_with(query)) {
        PREFIX
    } else if text.contains(query) {
        SUBSTRING
    } else {
        return fuzzy_gaps(query, text).map(|gaps| Grade { tier: FUZZY, gaps });
    };
    Some(Grade { tier, gaps: 0 })
}

/// The best `limit` items by `key`, best first. A short query matches most names, so only the top is sorted.
fn top<T, K: Ord>(mut items: Vec<T>, limit: usize, key: impl Fn(&T) -> K) -> Vec<T> {
    if items.len() > limit && limit > 0 {
        items.select_nth_unstable_by(limit - 1, |a, b| key(a).cmp(&key(b)));
        items.truncate(limit);
    }
    items.sort_by(|a, b| key(a).cmp(&key(b)));
    items.truncate(limit);
    items
}

/// `path:12` searches for `path` and opens line 12.
pub fn split_line(query: &str) -> (&str, Option<u32>) {
    match query.rsplit_once(':') {
        Some((name, line)) if !name.is_empty() && !line.is_empty() && line.bytes().all(|b| b.is_ascii_digit()) => (name, line.parse().ok()),
        _ => (query, None),
    }
}

// ---------------------------------------------------------------- content

/// The start of an ASCII case-insensitive match of the lowercase `needle` in `line`.
fn find_ci(line: &[u8], needle: &str) -> Option<usize> {
    if needle.is_empty() || needle.len() > line.len() {
        return None;
    }
    line.windows(needle.len()).position(|w| w.eq_ignore_ascii_case(needle.as_bytes()))
}

fn floor_boundary(text: &str, mut at: usize) -> usize {
    while !text.is_char_boundary(at) {
        at -= 1;
    }
    at
}

/// The text around `at..at + len` on one line, cut at char boundaries, with `…` where it was cut.
pub fn snippet(text: &str, at: usize, len: usize) -> String {
    let start = floor_boundary(text, at.saturating_sub(SNIPPET_BEFORE));
    let end = floor_boundary(text, (at + len + SNIPPET_AFTER).min(text.len()));
    let body = text[start..end].split_whitespace().collect::<Vec<_>>().join(" ");
    format!("{}{body}{}", if start > 0 { "…" } else { "" }, if end < text.len() { "…" } else { "" })
}

impl Transcript {
    /// Reads the lines that were added since the last refresh. A file that got shorter is read again from the start.
    pub fn refresh(&mut self, path: &Path, text_of: fn(&str) -> Option<String>) -> std::io::Result<()> {
        let len = std::fs::metadata(path)?.len();
        if len < self.offset {
            *self = Transcript::default();
        }
        if len == self.offset {
            return Ok(());
        }
        let mut file = std::fs::File::open(path)?;
        file.seek(std::io::SeekFrom::Start(self.offset))?;
        let mut reader = std::io::BufReader::with_capacity(1 << 20, file);
        let mut line = Vec::new();
        loop {
            line.clear();
            let n = reader.read_until(b'\n', &mut line)?;
            if n == 0 || line.last() != Some(&b'\n') {
                return Ok(());
            }
            self.offset += n as u64;
            if let Some(text) = std::str::from_utf8(&line).ok().and_then(|l| text_of(l.trim_end())) {
                self.messages.push(Message { lower: text.to_ascii_lowercase(), text });
            }
        }
    }

    /// A snippet of the newest message that holds the lowercase `needle`.
    pub fn newest_match(&self, needle: &str) -> Option<String> {
        self.messages.iter().rev().find_map(|m| m.lower.find(needle).map(|at| snippet(&m.text, at, needle.len())))
    }
}

// ---------------------------------------------------------------- one search

struct Search {
    client: u64,
    id: u64,
    query: String,
    limit: usize,
    here: Option<Id>,
    tx: UnboundedSender<String>,
}

impl Search {
    fn live(&self, index: &Index) -> bool {
        lock(&index.latest).get(&self.client) == Some(&self.id)
    }

    fn send(&self, index: &Index, source: SearchSource, hits: Vec<SearchHit>, total: usize, done: bool) -> bool {
        if !self.live(index) {
            return false;
        }
        let event = Event::SearchResults { query_id: self.id, source, hits, total: total as u32, done };
        if let Ok(text) = serde_json::to_string(&Frame::Event { seq: 0, event }) {
            let _ = self.tx.send(text);
        }
        true
    }
}

pub struct Request {
    pub query_id: u64,
    pub query: String,
    pub sources: Option<Vec<SearchSource>>,
    pub limit: Option<usize>,
    pub worktree_id: Option<Id>,
}

/// Starts the sources of one search and returns. An empty query cancels the search before it and fills the caches.
pub fn start(daemon: &Arc<Daemon>, client_id: u64, req: Request) -> Result<Value, RpcError> {
    lock(&daemon.search.latest).insert(client_id, req.query_id);
    let tx = daemon.lock().clients.get(&client_id).map(|c| c.tx.clone()).ok_or_else(|| err(ErrorCode::NotFound, "client not found"))?;
    let query = req.query.trim().to_string();
    if query.is_empty() {
        warm(daemon);
        return ok(Value::Null);
    }
    let wants = |source: SearchSource| req.sources.as_ref().is_none_or(|list| list.contains(&source));
    let content = query.chars().count() >= CONTENT_MIN_CHARS;
    let s = Arc::new(Search { client: client_id, id: req.query_id, query, limit: req.limit.unwrap_or(DEFAULT_LIMIT).clamp(1, 200), here: req.worktree_id, tx });
    if wants(SearchSource::Activity) {
        let (d, s) = (daemon.clone(), s.clone());
        tokio::task::spawn_blocking(move || activity(&d, &s));
    }
    if wants(SearchSource::File) {
        tokio::spawn(files(daemon.clone(), s.clone()));
    }
    if wants(SearchSource::Terminal) {
        if content {
            tokio::spawn(terminal(daemon.clone(), s.clone()));
        } else {
            s.send(&daemon.search, SearchSource::Terminal, Vec::new(), 0, true);
        }
    }
    if wants(SearchSource::Session) {
        tokio::spawn(sessions(daemon.clone(), s, content));
    }
    ok(Value::Null)
}

struct LiveWorktree {
    id: Id,
    path: PathBuf,
}

fn live_worktrees(daemon: &Daemon) -> Vec<LiveWorktree> {
    let inner = daemon.lock();
    inner.worktrees.values().filter(|w| w.exists && w.archived_at_ms.is_none()).map(|w| LiveWorktree { id: w.id.clone(), path: w.path.clone() }).collect()
}

/// The cached value of each worktree. A missing value is loaded now, all of them at once. A stale value is used
/// and loaded again in the background; it is marked fresh first, so that the next search does not load it twice.
async fn per_worktree<T, F, Fut>(daemon: &Arc<Daemon>, map: fn(&Index) -> &Mutex<HashMap<Id, Cached<T>>>, gen: u64, worktrees: &[LiveWorktree], load: F) -> HashMap<Id, Arc<T>>
where
    T: Send + Sync + 'static,
    F: Fn(PathBuf) -> Fut + Send + Sync + Clone + 'static,
    Fut: Future<Output = T> + Send + 'static,
{
    let now = now_ms();
    let (mut found, missing, stale) = {
        let mut cache = lock(map(&daemon.search));
        let mut found = HashMap::new();
        let (mut missing, mut stale) = (Vec::new(), Vec::new());
        for w in worktrees {
            match cache.get_mut(&w.id) {
                Some(c) => {
                    if c.gen != gen || now.saturating_sub(c.at_ms) > STALE_MS {
                        (c.gen, c.at_ms) = (gen, now);
                        stale.push((w.id.clone(), w.path.clone()));
                    }
                    found.insert(w.id.clone(), c.value.clone());
                }
                None => missing.push((w.id.clone(), w.path.clone())),
            }
        }
        (found, missing, stale)
    };
    for (id, path) in stale {
        let (d, load) = (daemon.clone(), load.clone());
        tokio::spawn(async move {
            let value = Arc::new(load(path).await);
            lock(map(&d.search)).insert(id, Cached { gen, at_ms: now_ms(), value });
        });
    }
    let mut set = tokio::task::JoinSet::new();
    for (id, path) in missing {
        let load = load.clone();
        set.spawn(async move { (id, Arc::new(load(path).await)) });
    }
    while let Some(Ok((id, value))) = set.join_next().await {
        lock(map(&daemon.search)).insert(id.clone(), Cached { gen, at_ms: now_ms(), value: value.clone() });
        found.insert(id, value);
    }
    found
}

async fn load_files(path: PathBuf) -> Vec<Name> {
    git::files(&path).await.unwrap_or_default().into_iter().map(Name::new).collect()
}

async fn file_lists(daemon: &Arc<Daemon>, worktrees: &[LiveWorktree]) -> HashMap<Id, Arc<Vec<Name>>> {
    let gen = daemon.search.files_gen.load(Ordering::Relaxed);
    per_worktree(daemon, |i| &i.files, gen, worktrees, load_files).await
}

async fn session_lists(daemon: &Arc<Daemon>, worktrees: &[LiveWorktree]) -> HashMap<Id, Arc<Vec<AgentSession>>> {
    let Some(home) = dirs::home_dir() else { return HashMap::new() };
    per_worktree(daemon, |i| &i.sessions, 0, worktrees, move |path| {
        let home = home.clone();
        async move { tokio::task::spawn_blocking(move || providers::sessions(&home, &path, SESSIONS_PER_WORKTREE)).await.unwrap_or_default() }
    })
    .await
}

fn transcript(index: &Index, path: &Path) -> Arc<Mutex<Transcript>> {
    lock(&index.transcripts).entry(path.to_path_buf()).or_default().clone()
}

/// Loads the file lists, the session lists, and every session text, so that the first real query finds them in memory.
fn warm(daemon: &Arc<Daemon>) {
    if daemon.search.warming.swap(true, Ordering::AcqRel) {
        return;
    }
    let d = daemon.clone();
    tokio::spawn(async move {
        let worktrees = live_worktrees(&d);
        file_lists(&d, &worktrees).await;
        let lists = session_lists(&d, &worktrees).await;
        let all: Vec<AgentSession> = lists.values().flat_map(|l| l.iter().cloned()).collect();
        let d2 = d.clone();
        let _ = tokio::task::spawn_blocking(move || {
            for s in all {
                let _ = lock(&transcript(&d2.search, &s.path)).refresh(&s.path, providers::provider(s.kind).transcript_text);
            }
        })
        .await;
        d.search.warming.store(false, Ordering::Release);
    });
}

// ---------------------------------------------------------------- sources

fn activity(daemon: &Arc<Daemon>, s: &Search) {
    let (rows, panes) = {
        let inner = daemon.lock();
        let rows = inner.store.activity_list(&ActivityQuery { limit: Some(ACTIVITY_ROWS), ..Default::default() }, &[]).unwrap_or_default();
        let panes: HashSet<Id> = inner.panes.keys().cloned().collect();
        (rows, panes)
    };
    let q = s.query.to_lowercase();
    let matched: Vec<(Grade, usize)> = rows
        .iter()
        .enumerate()
        .filter_map(|(i, e)| {
            let title = grade(&q, &e.title.to_lowercase());
            let detail = e.detail.as_deref().and_then(|d| grade(&q, &d.to_lowercase())).map(|g| Grade { tier: FUZZY, gaps: g.gaps });
            title.filter(|t| t.tier > FUZZY).or(detail).or(title).map(|g| (g, i))
        })
        .collect();
    let total = matched.len();
    let hits = top(matched, s.limit, |(g, i)| (g.key(), *i))
        .into_iter()
        .map(|(_, i)| {
            let e = &rows[i];
            SearchHit {
                key: format!("activity:{}", e.id),
                label: e.title.clone(),
                snippet: e.detail.clone(),
                worktree_id: e.worktree_id.clone(),
                at_ms: Some(e.occurred_at_ms),
                target: SearchTarget::Activity { worktree_id: e.worktree_id.clone(), pane_id: e.pane_id.clone().filter(|p| panes.contains(p)) },
            }
        })
        .collect();
    s.send(&daemon.search, SearchSource::Activity, hits, total, true);
}

pub fn rank_files(lists: &[(Id, Arc<Vec<Name>>)], query: &str, here: Option<&str>, limit: usize) -> (Vec<(Id, String)>, usize) {
    let q = query.to_lowercase();
    let matched: Vec<(Grade, bool, usize, usize, usize)> = lists
        .iter()
        .enumerate()
        .flat_map(|(li, (id, names))| {
            let away = Some(id.as_str()) != here;
            let q = &q;
            names.iter().enumerate().filter_map(move |(ni, n)| grade(q, &n.lower).map(|g| (g, away, n.text.len(), li, ni)))
        })
        .collect();
    let total = matched.len();
    let best = top(matched, limit, |&(g, away, len, li, ni)| (g.key(), away, len, li, ni));
    (best.into_iter().map(|(_, _, _, li, ni)| (lists[li].0.clone(), lists[li].1[ni].text.clone())).collect(), total)
}

async fn files(daemon: Arc<Daemon>, s: Arc<Search>) {
    let worktrees = live_worktrees(&daemon);
    let roots: HashMap<Id, PathBuf> = worktrees.iter().map(|w| (w.id.clone(), w.path.clone())).collect();
    let lists: Vec<(Id, Arc<Vec<Name>>)> = file_lists(&daemon, &worktrees).await.into_iter().collect();
    if !s.live(&daemon.search) {
        return;
    }
    let d = daemon.clone();
    let _ = tokio::task::spawn_blocking(move || {
        let (name, line) = split_line(&s.query);
        let (best, total) = rank_files(&lists, name, s.here.as_deref(), s.limit);
        let hits = best
            .into_iter()
            .map(|(worktree_id, path)| {
                let at_ms = roots.get(&worktree_id).and_then(|r| std::fs::metadata(r.join(&path)).ok()).and_then(|m| m.modified().ok()).and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_millis() as u64);
                SearchHit {
                    key: format!("file:{worktree_id}:{path}"),
                    label: path.clone(),
                    snippet: None,
                    worktree_id: Some(worktree_id.clone()),
                    at_ms,
                    target: SearchTarget::File { worktree_id, path, line },
                }
            })
            .collect();
        s.send(&d.search, SearchSource::File, hits, total, true);
    })
    .await;
}

struct PaneText {
    id: Id,
    worktree_id: Id,
    title: String,
    last_output_ms: u64,
    bytes: Vec<u8>,
}

/// The first `limit` matching lines of one pane, newest first, each line text once, and the count of every
/// matching line. Only the lines that it returns are rendered, because rendering is most of the cost of a scan.
/// Each hit is the byte offset of its line in the plain text, which keys it, and the snippet.
pub fn pane_matches(bytes: &[u8], needle: &str, limit: usize) -> (Vec<(usize, String)>, usize) {
    if needle.is_empty() {
        return (Vec::new(), 0);
    }
    let plain = pty::strip_escapes(bytes);
    let lower = plain.to_ascii_lowercase();
    let finder = memchr::memmem::FinderRev::new(needle.as_bytes());
    let mut seen = HashSet::new();
    let (mut total, mut found, mut end) = (0, Vec::new(), lower.len());
    while let Some(at) = finder.rfind(&lower[..end]) {
        let start = memchr::memrchr(b'\n', &lower[..at]).map_or(0, |p| p + 1);
        let stop = memchr::memchr(b'\n', &lower[at..]).map_or(lower.len(), |p| at + p);
        total += 1;
        end = start;
        let raw = &plain[start..stop];
        if found.len() < limit && seen.insert(raw) {
            let line = pty::render_line(&String::from_utf8_lossy(raw));
            if let Some(at) = find_ci(line.as_bytes(), needle) {
                found.push((start, snippet(&line, at, needle.len())));
            }
        }
    }
    (found, total)
}

async fn terminal(daemon: Arc<Daemon>, s: Arc<Search>) {
    let mut panes: Vec<PaneText> = {
        let inner = daemon.lock();
        inner
            .panes
            .values()
            .filter(|p| p.row.kind.has_pty())
            .filter_map(|p| {
                let title = Daemon::pane_view(&inner, &p.row.id)?.title;
                Some(PaneText { id: p.row.id.clone(), worktree_id: p.row.worktree_id.clone(), title, last_output_ms: p.last_output_ms, bytes: p.scrollback.snapshot() })
            })
            .collect()
    };
    panes.sort_by_key(|p| std::cmp::Reverse(p.last_output_ms));
    let d = daemon.clone();
    let _ = tokio::task::spawn_blocking(move || {
        let needle = s.query.to_ascii_lowercase();
        let chunk = panes.len().div_ceil(SCAN_THREADS).max(1);
        let per_pane: Vec<(Vec<(usize, String)>, usize)> = std::thread::scope(|scope| {
            let running: Vec<_> = panes.chunks(chunk).map(|group| scope.spawn(|| group.iter().map(|p| pane_matches(&p.bytes, &needle, s.limit)).collect::<Vec<_>>())).collect();
            running.into_iter().flat_map(|h| h.join().unwrap_or_default()).collect()
        });
        let total = per_pane.iter().map(|(_, count)| count).sum();
        let hits = panes
            .iter()
            .zip(per_pane)
            .flat_map(|(p, (found, _))| {
                found.into_iter().map(move |(offset, line)| SearchHit {
                    key: format!("term:{}:{offset}", p.id),
                    label: p.title.clone(),
                    snippet: Some(line),
                    worktree_id: Some(p.worktree_id.clone()),
                    at_ms: (p.last_output_ms > 0).then_some(p.last_output_ms),
                    target: SearchTarget::Pane { pane_id: p.id.clone() },
                })
            })
            .take(s.limit)
            .collect();
        s.send(&d.search, SearchSource::Terminal, hits, total, true);
    })
    .await;
}

struct SessionFound {
    session: AgentSession,
    worktree_id: Id,
    title: Option<Grade>,
    snippet: Option<String>,
}

fn session_hits(found: &[SessionFound], live: &HashMap<(AgentKind, String), Id>, limit: usize) -> Vec<SearchHit> {
    let mut order: Vec<&SessionFound> = found.iter().collect();
    order.sort_by_key(|f| (f.title.map_or((std::cmp::Reverse(-1), 0), Grade::key), std::cmp::Reverse(f.session.updated_at_ms)));
    order
        .into_iter()
        .take(limit)
        .map(|f| {
            let s = &f.session;
            SearchHit {
                key: format!("session:{}:{}", s.kind.label().to_lowercase(), s.id),
                label: s.title.clone().unwrap_or_else(|| s.id.chars().take(8).collect()),
                snippet: f.snippet.clone(),
                worktree_id: Some(f.worktree_id.clone()),
                at_ms: Some(s.updated_at_ms),
                target: SearchTarget::Session { agent: s.kind, session_id: s.id.clone(), worktree_id: f.worktree_id.clone(), pane_id: live.get(&(s.kind, s.id.clone())).cloned() },
            }
        })
        .collect()
}

async fn sessions(daemon: Arc<Daemon>, s: Arc<Search>, content: bool) {
    let worktrees = live_worktrees(&daemon);
    let live: HashMap<(AgentKind, String), Id> = {
        let inner = daemon.lock();
        inner.agents.values().filter(|a| a.state != AgentState::Exited).filter_map(|a| Some(((a.kind, a.session_ref.clone()?), a.pane_id.clone()))).collect()
    };
    let lists = session_lists(&daemon, &worktrees).await;
    let mut all: Vec<(Id, AgentSession)> = lists.iter().flat_map(|(id, l)| l.iter().map(move |s| (id.clone(), s.clone()))).collect();
    all.sort_by_key(|(_, s)| std::cmp::Reverse(s.updated_at_ms));
    let q = s.query.to_lowercase();
    let mut found: Vec<SessionFound> = Vec::new();
    let mut rest: Vec<(Id, AgentSession)> = Vec::new();
    for (worktree_id, session) in all {
        match session.title.as_deref().and_then(|t| grade(&q, &t.to_lowercase())) {
            Some(g) => found.push(SessionFound { session, worktree_id, title: Some(g), snippet: None }),
            None => rest.push((worktree_id, session)),
        }
    }
    if !s.send(&daemon.search, SearchSource::Session, session_hits(&found, &live, s.limit), found.len(), !content) || !content {
        return;
    }
    let d = daemon.clone();
    let _ = tokio::task::spawn_blocking(move || {
        let needle = s.query.to_ascii_lowercase();
        let mut last_sent = std::time::Instant::now();
        let titled = found.len();
        let scan: Vec<(Option<usize>, Id, AgentSession)> = (0..titled).map(|i| (Some(i), found[i].worktree_id.clone(), found[i].session.clone())).chain(rest.into_iter().map(|(w, s)| (None, w, s))).collect();
        for (slot, worktree_id, session) in scan {
            if !s.live(&d.search) {
                return;
            }
            let t = transcript(&d.search, &session.path);
            let mut t = lock(&t);
            let _ = t.refresh(&session.path, providers::provider(session.kind).transcript_text);
            let Some(snippet) = t.newest_match(&needle) else { continue };
            drop(t);
            match slot {
                Some(i) => found[i].snippet = Some(snippet),
                None => found.push(SessionFound { session, worktree_id, title: None, snippet: Some(snippet) }),
            }
            if last_sent.elapsed().as_millis() as u64 >= STREAM_EVERY_MS {
                last_sent = std::time::Instant::now();
                s.send(&d.search, SearchSource::Session, session_hits(&found, &live, s.limit), found.len(), false);
            }
        }
        s.send(&d.search, SearchSource::Session, session_hits(&found, &live, s.limit), found.len(), true);
    })
    .await;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(serde::Deserialize)]
    struct Case {
        query: String,
        text: String,
        tier: i8,
        gaps: u32,
    }

    #[test]
    fn grades_agree_with_the_palette_matcher() {
        let cases: Vec<Case> = serde_json::from_str(include_str!("../../../../app/src/matchCases.json")).unwrap();
        for c in cases {
            let got = grade(&c.query.trim().to_lowercase(), &c.text.to_lowercase());
            match got {
                None => assert_eq!(c.tier, -1, "{} in {}", c.query, c.text),
                Some(g) => assert_eq!((g.tier, g.gaps), (c.tier, c.gaps), "{} in {}", c.query, c.text),
            }
        }
    }

    fn names(paths: &[&str]) -> Arc<Vec<Name>> {
        Arc::new(paths.iter().map(|p| Name::new(p.to_string())).collect())
    }

    #[test]
    fn files_rank_by_tier_then_the_worktree_on_screen_then_length() {
        let lists = vec![
            ("a".to_string(), names(&["src/palette.ts", "docs/pal.md", "x/p/a/l.rs"])),
            ("b".to_string(), names(&["src/palette.ts", "src/app/Palette.tsx"])),
        ];
        let (best, total) = rank_files(&lists, "palette", Some("b"), 3);
        assert_eq!(total, 3);
        assert_eq!(best, [("b".to_string(), "src/palette.ts".to_string()), ("b".to_string(), "src/app/Palette.tsx".to_string()), ("a".to_string(), "src/palette.ts".to_string())]);
        let (best, total) = rank_files(&lists, "pal", None, 1);
        assert_eq!((best[0].1.as_str(), total), ("docs/pal.md", 5));
    }

    #[test]
    fn a_line_suffix_is_split_off_only_when_it_is_a_number() {
        assert_eq!(split_line("src/main.rs:42"), ("src/main.rs", Some(42)));
        assert_eq!(split_line("a:b"), ("a:b", None));
        assert_eq!(split_line(":12"), (":12", None));
        assert_eq!(split_line("main.rs:"), ("main.rs:", None));
    }

    #[test]
    fn snippets_cut_at_char_boundaries_and_stay_on_one_line() {
        let text = format!("{}needle\n\tin   the {}", "é".repeat(40), "hay ".repeat(40));
        let at = text.find("needle").unwrap();
        let s = snippet(&text, at, 6);
        assert!(s.starts_with('…') && s.ends_with('…'), "{s}");
        assert!(s.contains("needle in the hay"), "{s}");
        assert_eq!(snippet("short needle", 6, 6), "short needle");
    }

    #[test]
    fn pane_matches_strip_escapes_and_list_each_line_once_newest_first() {
        let out = b"\x1b[32mcargo test\x1b[0m\r\nok\r\ncargo test\r\nerror: Cargo failed\r\n";
        let (found, total) = pane_matches(out, "cargo", 8);
        assert_eq!(found.iter().map(|(_, l)| l.as_str()).collect::<Vec<_>>(), ["error: Cargo failed", "cargo test"]);
        assert_eq!((found[1].0, total), (16, 3));
        assert_eq!(pane_matches(out, "cargo", 1), (vec![(28, "error: Cargo failed".to_string())], 3), "the count goes past the limit");
        assert_eq!(pane_matches(out, "", 8), (vec![], 0));
        assert_eq!(pane_matches(b"abx\rcd\r\n", "abx", 8).0, [], "a line that the terminal overwrote does not match what is gone");
    }

    fn scratch(name: &str) -> PathBuf {
        let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let dir = std::env::temp_dir().join(format!("tomo-search-{name}-{}-{nanos}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn a_transcript_keeps_message_text_only_and_reads_only_new_lines() {
        use std::io::Write;
        let path = scratch("transcript").join("s.jsonl");
        let claude = providers::provider(AgentKind::Claude).transcript_text;
        std::fs::write(
            &path,
            concat!(
                r#"{"type":"user","message":{"role":"user","content":"fix the login redirect"}}"#, "\n",
                r#"{"type":"assistant","message":{"content":[{"type":"thinking","thinking":"secret login plan"},{"type":"text","text":"The login fix is ready."},{"type":"tool_use","input":{"cmd":"grep login"}}]}}"#, "\n",
                r#"{"type":"user","message":{"content":[{"type":"tool_result","content":"login.rs:1: fn login()"}]}}"#, "\n",
                r#"{"type":"user","message":{"content":"<command-name>login</command-name>"}}"#, "\n",
                r#"{"type":"ai-title","aiTitle":"Login fix"}"#, "\n",
                r#"{"type":"user","message":{"content":"half a li"#,
            ),
        )
        .unwrap();
        let mut t = Transcript::default();
        t.refresh(&path, claude).unwrap();
        assert_eq!(t.messages.iter().map(|m| m.text.as_str()).collect::<Vec<_>>(), ["fix the login redirect", "The login fix is ready."]);
        assert_eq!(t.newest_match("login"), Some("The login fix is ready.".to_string()));
        assert_eq!(t.newest_match("fn login"), None, "tool output is not message text");

        let mut f = std::fs::OpenOptions::new().append(true).open(&path).unwrap();
        writeln!(f, r#"ne about LOGOUT"}}}}"#).unwrap();
        t.refresh(&path, claude).unwrap();
        assert_eq!(t.messages.len(), 3, "the finished line is read once, after it ends");
        assert_eq!(t.newest_match("logout"), Some("half a line about LOGOUT".to_string()));

        std::fs::write(&path, concat!(r#"{"type":"user","message":{"content":"new file"}}"#, "\n")).unwrap();
        t.refresh(&path, claude).unwrap();
        assert_eq!(t.messages.iter().map(|m| m.text.as_str()).collect::<Vec<_>>(), ["new file"], "a shorter file is read again");
    }

    #[test]
    fn codex_transcripts_read_each_message_once() {
        let codex = providers::provider(AgentKind::Codex).transcript_text;
        assert_eq!(codex(r#"{"type":"event_msg","payload":{"type":"user_message","message":"add tests"}}"#).as_deref(), Some("add tests"));
        assert_eq!(codex(r#"{"type":"event_msg","payload":{"type":"agent_message","message":"Tests added."}}"#).as_deref(), Some("Tests added."));
        assert_eq!(codex(r#"{"type":"response_item","payload":{"role":"user","content":[{"type":"input_text","text":"add tests"}]}}"#), None);
        assert_eq!(codex(r#"{"type":"event_msg","payload":{"type":"exec_command_end","stdout":"event_msg"}}"#), None);
    }

    fn frames(rx: &mut tokio::sync::mpsc::UnboundedReceiver<String>) -> Vec<Value> {
        std::iter::from_fn(|| rx.try_recv().ok()).map(|t| serde_json::from_str(&t).unwrap()).collect()
    }

    #[test]
    fn only_the_newest_search_of_a_client_sends() {
        let index = Index::default();
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let search = |id| Search { client: 7, id, query: "x".into(), limit: 8, here: None, tx: tx.clone() };
        let (first, second) = (search(1), search(2));
        lock(&index.latest).insert(7, 1);
        assert!(first.send(&index, SearchSource::File, Vec::new(), 0, true));
        lock(&index.latest).insert(7, 2);
        assert!(!first.send(&index, SearchSource::File, Vec::new(), 0, true), "a newer search cancels the older one");
        assert!(second.send(&index, SearchSource::Terminal, Vec::new(), 3, false));
        lock(&index.latest).insert(8, 9);
        assert!(second.live(&index), "another client's search does not cancel it");
        let sent = frames(&mut rx);
        assert_eq!(sent.iter().map(|f| (f["data"]["query_id"].as_u64().unwrap(), f["data"]["source"].as_str().unwrap())).collect::<Vec<_>>(), [(1, "file"), (2, "terminal")]);
        assert_eq!((sent[1]["event"].as_str(), sent[1]["seq"].as_u64()), (Some("search_results"), Some(0)));
    }

    fn run(dir: &Path, args: &[&str]) {
        assert!(std::process::Command::new("git").current_dir(dir).args(args).output().unwrap().status.success(), "{args:?}");
    }

    async fn file_hits(daemon: &Arc<Daemon>, rx: &mut tokio::sync::mpsc::UnboundedReceiver<String>, id: u64, query: &str) -> Vec<String> {
        start(daemon, 1, Request { query_id: id, query: query.into(), sources: Some(vec![SearchSource::File]), limit: None, worktree_id: None }).unwrap();
        for _ in 0..200 {
            if let Some(f) = frames(rx).into_iter().find(|f| f["data"]["query_id"] == id) {
                return f["data"]["hits"].as_array().unwrap().iter().map(|h| h["label"].as_str().unwrap().to_string()).collect();
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        panic!("no file results for {query}");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_git_change_reads_the_file_list_again_and_the_old_list_answers_meanwhile() {
        let dir = scratch("files");
        let repo = dir.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        run(&repo, &["init", "-q"]);
        std::fs::write(repo.join("alpha.txt"), "a").unwrap();
        std::fs::write(repo.join(".gitignore"), "ignored.txt\n").unwrap();
        std::fs::write(repo.join("ignored.txt"), "i").unwrap();
        let daemon = Daemon::new(crate::config::Paths::new(dir.join("data")), crate::daemon::tests::no_seams(), Box::new(())).unwrap();
        daemon.handle(0, Call::RepoAdd { path: repo.clone() }).await.unwrap();
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        daemon.lock().clients.insert(1, crate::daemon::Client { tx, subscribed: false, attached: HashSet::new() });

        assert_eq!(file_hits(&daemon, &mut rx, 1, "alpha").await, ["alpha.txt"], "an untracked file that is not ignored is listed");
        assert!(file_hits(&daemon, &mut rx, 2, "ignored").await.is_empty(), "an ignored file is not");
        std::fs::write(repo.join("beta.txt"), "b").unwrap();
        assert!(file_hits(&daemon, &mut rx, 3, "beta").await.is_empty(), "the cached list answers until something says it changed");
        daemon.search.files_changed();
        assert!(file_hits(&daemon, &mut rx, 4, "beta").await.is_empty(), "the old list answers once, while the new one loads");
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        assert_eq!(file_hits(&daemon, &mut rx, 5, "beta:3").await, ["beta.txt"]);
        daemon.shutdown();
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Measures the index over the Claude transcripts in the real `~/.claude/projects` (read only) and synthetic
    /// file lists and panes. Run: `cargo test --release -p tomod measure_search -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn measure_search() {
        use std::time::Instant;
        let ms = |t: Instant| t.elapsed().as_secs_f64() * 1000.0;
        let root = dirs::home_dir().unwrap().join(".claude/projects");
        let paths: Vec<PathBuf> = std::fs::read_dir(&root).unwrap().flatten().flat_map(|d| providers::jsonl_files(&d.path(), 0)).collect();
        let bytes: u64 = paths.iter().map(|p| std::fs::metadata(p).unwrap().len()).sum();
        let index = Index::default();
        let claude = providers::provider(AgentKind::Claude).transcript_text;
        let t = Instant::now();
        for p in &paths {
            lock(&transcript(&index, p)).refresh(p, claude).unwrap();
        }
        println!("transcripts: {} files, {:.0} MB, first build {:.0} ms", paths.len(), bytes as f64 / 1e6, ms(t));
        let t = Instant::now();
        for p in &paths {
            lock(&transcript(&index, p)).refresh(p, claude).unwrap();
        }
        println!("transcripts: refresh with no change {:.1} ms", ms(t));
        let st = index.stats();
        println!("transcripts: {} messages, {:.1} MB of text in memory (text and lowercase copy)", st.messages, st.text_bytes as f64 / 1e6);
        for q in ["pty", "scrollback", "zzqqxx"] {
            let t = Instant::now();
            let found = paths.iter().filter(|p| lock(&transcript(&index, p)).newest_match(q).is_some()).count();
            println!("transcripts: {q:?} ({} chars) in {found} sessions, scan {:.2} ms", q.len(), ms(t));
        }

        let own: Vec<String> = std::process::Command::new("git").args(["ls-files", "--cached", "--others", "--exclude-standard"]).current_dir(concat!(env!("CARGO_MANIFEST_DIR"), "/../..")).output().map(|o| String::from_utf8_lossy(&o.stdout).lines().map(str::to_string).collect()).unwrap();
        let lists: Vec<(Id, Arc<Vec<Name>>)> = (0..12).map(|i| (format!("w{i}"), Arc::new((0..(96_000 / own.len() / 12).max(1)).flat_map(|k| own.iter().map(move |p| Name::new(format!("pkg{k}/{p}")))).collect::<Vec<_>>()))).collect();
        let n: usize = lists.iter().map(|(_, l)| l.len()).sum();
        let fbytes: usize = lists.iter().flat_map(|(_, l)| l.iter()).map(|n| n.text.len() + n.lower.len()).sum();
        println!("files: {n} paths in 12 worktrees, {:.1} MB", fbytes as f64 / 1e6);
        for q in ["p", "pal", "palettemod", "search.rs"] {
            let t = Instant::now();
            let (best, total) = rank_files(&lists, q, Some("w0"), 8);
            println!("files: {q:?} {total} matches, top {:?}, {:.1} ms", best.first().map(|b| &b.1), ms(t));
        }

        let line = |i: usize| format!("\x1b[32m   Compiling\x1b[0m crate-{i} v0.1.{i} (/Users/you/Projects/tomo/crates/c{i})\r\ntest features::m{i}::works ... \x1b[32mok\x1b[0m\r\n$ ls -la src\r\n-rw-r--r--  1 simon staff  {i} Sep 29 10:00 file{i}.rs\r\n");
        let pane: Vec<u8> = (0..).map(line).take_while({ let mut size = 0; move |l| { size += l.len(); size < pty::SCROLLBACK_CAP } }).collect::<String>().into_bytes();
        for q in ["com", "works ...", "zzqqxx"] {
            let t = Instant::now();
            let needle = q.to_ascii_lowercase();
            let found: usize = std::thread::scope(|sc| (0..20).map(|_| sc.spawn(|| pane_matches(&pane, &needle, 8).1)).collect::<Vec<_>>().into_iter().map(|h| h.join().unwrap()).sum());
            println!("terminal: {q:?} 20 panes x {:.1} MB, {found} lines, {:.1} ms", pane.len() as f64 / 1e6, ms(t));
        }
    }

    #[test]
    fn top_keeps_the_best_in_order() {
        assert_eq!(top(vec![5, 1, 4, 2, 3], 3, |x| *x), [1, 2, 3]);
        assert_eq!(top(vec![2, 1], 5, |x| *x), [1, 2]);
    }
}
