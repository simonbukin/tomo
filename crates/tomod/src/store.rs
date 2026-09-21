//! SQLite persistence.
//!
//! Every table falls into one of three categories (PRD §25):
//! - authoritative Tomo metadata: `repos`, the user-set columns of `worktree_meta`
//! - cached external observation: `worktree_meta.path`, `.gitdir`, `.first_seen_ms`, `.archived_at_ms`, `.archived_branch`
//! - recoverable runtime state: `tabs`, `panes`, `attention`, `activity`, `kv`
//!
//! An addon creates and queries its own tables through `conn`. This module never reads them.
//!
//! Git remains the authority for branches and worktree existence; nothing here
//! stores a branch name.

use anyhow::{Context, Result};
use rusqlite::{params, Connection, OptionalExtension};
use std::path::{Path, PathBuf};
use tomo_proto::{
    ActivityEvent, ActivityKind, ActivityQuery, AgentKind, AttentionItem, AttentionKind, AttentionLevel, Id, LayoutNode, PaneKind, WorktreeMetadata,
};

pub struct Store {
    conn: Connection,
}

#[derive(Debug, Clone)]
pub struct RepoRow {
    pub id: Id,
    pub path: PathBuf,
}

#[derive(Debug, Clone)]
pub struct MetaRow {
    pub id: Id,
    pub repo_id: Id,
    pub path: PathBuf,
    pub gitdir: Option<String>,
    pub metadata: WorktreeMetadata,
    pub last_active_ms: Option<u64>,
    pub first_seen_ms: Option<u64>,
    pub archived_at_ms: Option<u64>,
    pub archived_branch: Option<String>,
    pub infra_name: Option<String>,
}

#[derive(Debug, Clone)]
pub struct TabRow {
    pub id: Id,
    pub worktree_id: Id,
    pub title: String,
    pub position: i64,
    pub layout: LayoutNode,
    pub active_pane_id: Option<Id>,
    pub is_active: bool,
}

#[derive(Debug, Clone)]
pub struct PaneRow {
    pub id: Id,
    pub tab_id: Id,
    pub worktree_id: Id,
    pub user_title: Option<String>,
    pub cwd: PathBuf,
    pub cols: u16,
    pub rows: u16,
    pub agent_kind: Option<AgentKind>,
    pub session_ref: Option<String>,
    pub created_at_ms: u64,
    pub kind: PaneKind,
    pub url: Option<String>,
}

const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS repos (
  id TEXT PRIMARY KEY,
  path TEXT UNIQUE NOT NULL,
  added_at_ms INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS worktree_meta (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL,
  path TEXT NOT NULL,
  gitdir TEXT,
  display_name TEXT,
  project TEXT,
  priority INTEGER,
  tags TEXT NOT NULL DEFAULT '[]',
  last_active_ms INTEGER
);
CREATE TABLE IF NOT EXISTS tabs (
  id TEXT PRIMARY KEY,
  worktree_id TEXT NOT NULL,
  title TEXT NOT NULL,
  position INTEGER NOT NULL,
  layout TEXT NOT NULL,
  active_pane_id TEXT,
  is_active INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS panes (
  id TEXT PRIMARY KEY,
  tab_id TEXT NOT NULL,
  worktree_id TEXT NOT NULL,
  user_title TEXT,
  cwd TEXT NOT NULL,
  cols INTEGER NOT NULL,
  rows INTEGER NOT NULL,
  agent_kind TEXT,
  session_ref TEXT,
  created_at_ms INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS attention (
  id TEXT PRIMARY KEY,
  worktree_id TEXT NOT NULL,
  pane_id TEXT,
  level TEXT NOT NULL,
  message TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  viewed_at_ms INTEGER
);
CREATE TABLE IF NOT EXISTS kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS activity (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  occurred_at_ms INTEGER NOT NULL,
  worktree_id TEXT,
  pane_id TEXT,
  agent_kind TEXT,
  title TEXT NOT NULL,
  detail TEXT,
  payload TEXT NOT NULL DEFAULT 'null',
  attention_id TEXT
);
CREATE INDEX IF NOT EXISTS activity_occurred_at ON activity(occurred_at_ms);
"#;

const META_SELECT: &str =
    "SELECT id, repo_id, path, gitdir, display_name, project, priority, tags, last_active_ms, first_seen_ms, archived_at_ms, archived_branch, state, infra_name FROM worktree_meta";

fn meta_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<MetaRow> {
    let tags: String = r.get(7)?;
    Ok(MetaRow {
        id: r.get(0)?,
        repo_id: r.get(1)?,
        path: PathBuf::from(r.get::<_, String>(2)?),
        gitdir: r.get(3)?,
        metadata: WorktreeMetadata { display_name: r.get(4)?, project: r.get(5)?, state: r.get(12)?, tags: serde_json::from_str(&tags).unwrap_or_default() },
        last_active_ms: r.get::<_, Option<i64>>(8)?.map(|v| v as u64),
        first_seen_ms: r.get::<_, Option<i64>>(9)?.map(|v| v as u64),
        archived_at_ms: r.get::<_, Option<i64>>(10)?.map(|v| v as u64),
        archived_branch: r.get(11)?,
        infra_name: r.get(13)?,
    })
}

const META_COLUMNS: [(&str, &str); 5] =
    [("first_seen_ms", "INTEGER"), ("archived_at_ms", "INTEGER"), ("archived_branch", "TEXT"), ("state", "TEXT"), ("infra_name", "TEXT")];

const PANE_COLUMNS: [(&str, &str); 2] = [("kind", "TEXT"), ("url", "TEXT")];

const ATTENTION_COLUMNS: [(&str, &str); 4] = [("kind", "TEXT"), ("url", "TEXT"), ("agent_kind", "TEXT"), ("resolved_at_ms", "INTEGER")];

fn add_missing_columns(conn: &Connection, table: &str, columns: &[(&str, &str)]) -> Result<()> {
    let existing: Vec<String> =
        conn.prepare(&format!("PRAGMA table_info({table})"))?.query_map([], |r| r.get::<_, String>(1))?.filter_map(|r| r.ok()).collect();
    for (name, ty) in columns.iter().filter(|(n, _)| !existing.iter().any(|e| e == n)) {
        conn.execute(&format!("ALTER TABLE {table} ADD COLUMN {name} {ty}"), [])?;
    }
    Ok(())
}

fn migrate(conn: &Connection) -> Result<()> {
    add_missing_columns(conn, "worktree_meta", &META_COLUMNS)?;
    add_missing_columns(conn, "panes", &PANE_COLUMNS)?;
    add_missing_columns(conn, "attention", &ATTENTION_COLUMNS)
}

fn enum_str<T: serde::Serialize>(v: T) -> String {
    serde_json::to_value(v).ok().and_then(|v| v.as_str().map(str::to_string)).unwrap_or_default()
}

fn parse_enum<T: serde::de::DeserializeOwned>(s: Option<String>) -> Option<T> {
    s.and_then(|s| serde_json::from_value(serde_json::Value::String(s)).ok())
}

fn agent_kind_str(k: AgentKind) -> &'static str {
    match k {
        AgentKind::Claude => "claude",
        AgentKind::Codex => "codex",
        AgentKind::Pi => "pi",
    }
}

fn pane_kind_str(k: PaneKind) -> &'static str {
    match k {
        PaneKind::Terminal => "terminal",
        PaneKind::Browser => "browser",
    }
}

fn parse_pane_kind(s: Option<String>) -> PaneKind {
    if s.as_deref() == Some("browser") {
        PaneKind::Browser
    } else {
        PaneKind::Terminal
    }
}

fn level_str(l: AttentionLevel) -> &'static str {
    match l {
        AttentionLevel::Attention => "attention",
        AttentionLevel::Info => "info",
    }
}

fn parse_level(s: &str) -> AttentionLevel {
    if s == "info" {
        AttentionLevel::Info
    } else {
        AttentionLevel::Attention
    }
}

impl Store {
    pub fn open(path: &Path) -> Result<Self> {
        let conn = Connection::open(path).with_context(|| format!("open {}", path.display()))?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "synchronous", "NORMAL")?;
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        conn.execute_batch(SCHEMA)?;
        migrate(&conn)?;
        Ok(Store { conn })
    }

    #[cfg(test)]
    pub fn open_in_memory() -> Result<Self> {
        let conn = Connection::open_in_memory()?;
        conn.execute_batch(SCHEMA)?;
        migrate(&conn)?;
        Ok(Store { conn })
    }

    pub fn conn(&self) -> &Connection {
        &self.conn
    }

    pub fn repos(&self) -> Result<Vec<RepoRow>> {
        let mut st = self.conn.prepare("SELECT id, path FROM repos ORDER BY added_at_ms")?;
        let rows = st.query_map([], |r| Ok(RepoRow { id: r.get(0)?, path: PathBuf::from(r.get::<_, String>(1)?) }))?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }

    pub fn repo_add(&self, id: &str, path: &Path, now_ms: u64) -> Result<()> {
        self.conn.execute("INSERT OR IGNORE INTO repos (id, path, added_at_ms) VALUES (?1, ?2, ?3)", params![id, path.to_string_lossy(), now_ms as i64])?;
        Ok(())
    }

    pub fn repo_remove(&self, id: &str) -> Result<()> {
        self.conn.execute("DELETE FROM repos WHERE id = ?1", params![id])?;
        Ok(())
    }

    pub fn meta_all(&self) -> Result<Vec<MetaRow>> {
        let mut st = self.conn.prepare(META_SELECT)?;
        let rows = st.query_map([], meta_row)?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }

    pub fn meta_one(&self, id: &str) -> Result<Option<MetaRow>> {
        let mut st = self.conn.prepare(&format!("{META_SELECT} WHERE id = ?1"))?;
        let mut rows = st.query_map(params![id], meta_row)?;
        Ok(rows.next().transpose()?)
    }

    pub fn meta_upsert(&self, row: &MetaRow) -> Result<()> {
        self.conn.execute(
            "INSERT INTO worktree_meta (id, repo_id, path, gitdir, display_name, project, priority, tags, last_active_ms, first_seen_ms, archived_at_ms, archived_branch, state, infra_name)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
             ON CONFLICT(id) DO UPDATE SET repo_id=excluded.repo_id, path=excluded.path, gitdir=excluded.gitdir,
               display_name=excluded.display_name, project=excluded.project, priority=excluded.priority,
               tags=excluded.tags, last_active_ms=excluded.last_active_ms, first_seen_ms=excluded.first_seen_ms,
               archived_at_ms=excluded.archived_at_ms, archived_branch=excluded.archived_branch, state=excluded.state,
               infra_name=excluded.infra_name",
            params![
                row.id,
                row.repo_id,
                row.path.to_string_lossy(),
                row.gitdir,
                row.metadata.display_name,
                row.metadata.project,
                Option::<i64>::None,
                serde_json::to_string(&row.metadata.tags)?,
                row.last_active_ms.map(|v| v as i64),
                row.first_seen_ms.map(|v| v as i64),
                row.archived_at_ms.map(|v| v as i64),
                row.archived_branch,
                row.metadata.state,
                row.infra_name,
            ],
        )?;
        Ok(())
    }

    pub fn rebind_worktree(&self, old_id: &str, new_id: &str, new_path: &Path) -> Result<()> {
        let path = new_path.to_string_lossy();
        let tx = self.conn.unchecked_transaction()?;
        tx.execute(
            "UPDATE worktree_meta AS n SET
               display_name = COALESCE(n.display_name, o.display_name),
               project = COALESCE(n.project, o.project),
               priority = COALESCE(n.priority, o.priority),
               tags = CASE WHEN n.tags = '[]' THEN o.tags ELSE n.tags END,
               state = COALESCE(n.state, o.state),
               infra_name = COALESCE(n.infra_name, o.infra_name),
               first_seen_ms = MIN(COALESCE(n.first_seen_ms, o.first_seen_ms), COALESCE(o.first_seen_ms, n.first_seen_ms)),
               last_active_ms = MAX(COALESCE(n.last_active_ms, o.last_active_ms), COALESCE(o.last_active_ms, n.last_active_ms))
             FROM worktree_meta AS o WHERE n.id = ?2 AND o.id = ?1",
            params![old_id, new_id],
        )?;
        tx.execute("DELETE FROM worktree_meta WHERE id = ?1 AND EXISTS (SELECT 1 FROM worktree_meta WHERE id = ?2)", params![old_id, new_id])?;
        tx.execute("UPDATE worktree_meta SET id = ?2, path = ?3 WHERE id = ?1", params![old_id, new_id, path])?;
        tx.execute("UPDATE tabs SET worktree_id = ?2 WHERE worktree_id = ?1", params![old_id, new_id])?;
        tx.execute("UPDATE panes SET worktree_id = ?2 WHERE worktree_id = ?1", params![old_id, new_id])?;
        tx.execute("UPDATE attention SET worktree_id = ?2 WHERE worktree_id = ?1", params![old_id, new_id])?;
        tx.execute("UPDATE activity SET worktree_id = ?2 WHERE worktree_id = ?1", params![old_id, new_id])?;
        tx.commit()?;
        Ok(())
    }

    pub fn meta_touch(&self, id: &str, now_ms: u64) -> Result<()> {
        self.conn.execute("UPDATE worktree_meta SET last_active_ms = ?2 WHERE id = ?1", params![id, now_ms as i64])?;
        Ok(())
    }

    pub fn tabs(&self) -> Result<Vec<TabRow>> {
        let mut st = self.conn.prepare("SELECT id, worktree_id, title, position, layout, active_pane_id, is_active FROM tabs ORDER BY position")?;
        let rows = st.query_map([], |r| {
            let layout: String = r.get(4)?;
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, i64>(3)?,
                layout,
                r.get::<_, Option<String>>(5)?,
                r.get::<_, i64>(6)?,
            ))
        })?;
        Ok(rows
            .filter_map(|r| r.ok())
            .filter_map(|(id, worktree_id, title, position, layout, active_pane_id, is_active)| {
                let layout = serde_json::from_str(&layout).ok()?;
                Some(TabRow { id, worktree_id, title, position, layout, active_pane_id, is_active: is_active != 0 })
            })
            .collect())
    }

    pub fn tab_upsert(&self, t: &TabRow) -> Result<()> {
        self.conn.execute(
            "INSERT INTO tabs (id, worktree_id, title, position, layout, active_pane_id, is_active)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
             ON CONFLICT(id) DO UPDATE SET worktree_id=excluded.worktree_id, title=excluded.title, position=excluded.position,
               layout=excluded.layout, active_pane_id=excluded.active_pane_id, is_active=excluded.is_active",
            params![t.id, t.worktree_id, t.title, t.position, serde_json::to_string(&t.layout)?, t.active_pane_id, t.is_active as i64],
        )?;
        Ok(())
    }

    pub fn tab_delete(&self, id: &str) -> Result<()> {
        self.conn.execute("DELETE FROM tabs WHERE id = ?1", params![id])?;
        Ok(())
    }

    pub fn panes(&self) -> Result<Vec<PaneRow>> {
        let mut st =
            self.conn.prepare("SELECT id, tab_id, worktree_id, user_title, cwd, cols, rows, agent_kind, session_ref, created_at_ms, kind, url FROM panes")?;
        let rows = st.query_map([], |r| {
            Ok(PaneRow {
                id: r.get(0)?,
                tab_id: r.get(1)?,
                worktree_id: r.get(2)?,
                user_title: r.get(3)?,
                cwd: PathBuf::from(r.get::<_, String>(4)?),
                cols: r.get::<_, i64>(5)? as u16,
                rows: r.get::<_, i64>(6)? as u16,
                agent_kind: r.get::<_, Option<String>>(7)?.and_then(|s| s.parse().ok()),
                session_ref: r.get(8)?,
                created_at_ms: r.get::<_, i64>(9)? as u64,
                kind: parse_pane_kind(r.get(10)?),
                url: r.get(11)?,
            })
        })?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }

    pub fn pane_upsert(&self, p: &PaneRow) -> Result<()> {
        self.conn.execute(
            "INSERT INTO panes (id, tab_id, worktree_id, user_title, cwd, cols, rows, agent_kind, session_ref, created_at_ms, kind, url)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
             ON CONFLICT(id) DO UPDATE SET tab_id=excluded.tab_id, worktree_id=excluded.worktree_id, user_title=excluded.user_title,
               cwd=excluded.cwd, cols=excluded.cols, rows=excluded.rows, agent_kind=excluded.agent_kind,
               session_ref=excluded.session_ref, kind=excluded.kind, url=excluded.url",
            params![
                p.id,
                p.tab_id,
                p.worktree_id,
                p.user_title,
                p.cwd.to_string_lossy(),
                p.cols as i64,
                p.rows as i64,
                p.agent_kind.map(agent_kind_str),
                p.session_ref,
                p.created_at_ms as i64,
                pane_kind_str(p.kind),
                p.url
            ],
        )?;
        Ok(())
    }

    pub fn pane_delete(&self, id: &str) -> Result<()> {
        self.conn.execute("DELETE FROM panes WHERE id = ?1", params![id])?;
        Ok(())
    }

    pub fn attention_insert(&self, item: &AttentionItem) -> Result<()> {
        self.conn.execute(
            "INSERT INTO attention (id, worktree_id, pane_id, level, message, created_at_ms, viewed_at_ms, kind, url, agent_kind, resolved_at_ms) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)",
            params![
                item.id,
                item.worktree_id,
                item.pane_id,
                level_str(item.level),
                item.message,
                item.created_at_ms as i64,
                item.viewed_at_ms.map(|v| v as i64),
                enum_str(item.kind),
                item.url,
                item.agent_kind.map(agent_kind_str),
                item.resolved_at_ms.map(|v| v as i64)
            ],
        )?;
        Ok(())
    }

    const ATTENTION_SELECT: &'static str =
        "SELECT id, worktree_id, pane_id, level, message, created_at_ms, viewed_at_ms, kind, url, agent_kind, resolved_at_ms FROM attention";

    fn attention_row(r: &rusqlite::Row) -> rusqlite::Result<AttentionItem> {
        Ok(AttentionItem {
            id: r.get(0)?,
            worktree_id: r.get(1)?,
            pane_id: r.get(2)?,
            level: parse_level(&r.get::<_, String>(3)?),
            message: r.get(4)?,
            created_at_ms: r.get::<_, i64>(5)? as u64,
            viewed_at_ms: r.get::<_, Option<i64>>(6)?.map(|v| v as u64),
            kind: parse_enum::<AttentionKind>(r.get(7)?).unwrap_or_default(),
            url: r.get(8)?,
            agent_kind: r.get::<_, Option<String>>(9)?.and_then(|s| s.parse().ok()),
            resolved_at_ms: r.get::<_, Option<i64>>(10)?.map(|v| v as u64),
        })
    }

    /// Unresolved items only. A resolved item is history; `activity` keeps it.
    pub fn attention_list(&self) -> Result<Vec<AttentionItem>> {
        let mut st = self.conn.prepare(&format!("{} WHERE resolved_at_ms IS NULL ORDER BY created_at_ms", Self::ATTENTION_SELECT))?;
        let rows = st.query_map([], Self::attention_row)?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }

    pub fn attention_get(&self, id: &str) -> Result<Option<AttentionItem>> {
        Ok(self.conn.query_row(&format!("{} WHERE id = ?1", Self::ATTENTION_SELECT), params![id], Self::attention_row).optional()?)
    }

    pub fn attention_resolve(&self, id: &str, now_ms: u64) -> Result<bool> {
        let n = self.conn.execute("UPDATE attention SET resolved_at_ms = ?2 WHERE id = ?1 AND resolved_at_ms IS NULL", params![id, now_ms as i64])?;
        Ok(n > 0)
    }

    pub fn activity_insert(&self, e: &ActivityEvent) -> Result<()> {
        self.conn.execute(
            "INSERT INTO activity (id, kind, occurred_at_ms, worktree_id, pane_id, agent_kind, title, detail, payload, attention_id) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)",
            params![
                e.id,
                e.kind.as_str(),
                e.occurred_at_ms as i64,
                e.worktree_id,
                e.pane_id,
                e.agent_kind.map(agent_kind_str),
                e.title,
                e.detail,
                e.payload.to_string(),
                e.attention_id
            ],
        )?;
        Ok(())
    }

    pub fn activity_trim(&self, keep: usize) -> Result<()> {
        self.conn.execute(
            "DELETE FROM activity WHERE rowid NOT IN (SELECT rowid FROM activity ORDER BY occurred_at_ms DESC, rowid DESC LIMIT ?1)",
            params![keep as i64],
        )?;
        Ok(())
    }

    fn activity_row(r: &rusqlite::Row) -> rusqlite::Result<ActivityEvent> {
        let payload: String = r.get(8)?;
        Ok(ActivityEvent {
            id: r.get(0)?,
            kind: ActivityKind(r.get(1)?),
            occurred_at_ms: r.get::<_, i64>(2)? as u64,
            worktree_id: r.get(3)?,
            pane_id: r.get(4)?,
            agent_kind: r.get::<_, Option<String>>(5)?.and_then(|s| s.parse().ok()),
            title: r.get(6)?,
            detail: r.get(7)?,
            payload: serde_json::from_str(&payload).unwrap_or(serde_json::Value::Null),
            attention_id: r.get(9)?,
        })
    }

    /// Newest first. `needs_me` keeps only events whose attention item needs a person: the item is
    /// unresolved, and a `waiting` item is also unviewed and its pane is in `waiting_panes` (an agent there
    /// still waits). `needsMeItem` in `app/src/activityModel.ts` is the same rule; both test the same cases.
    pub fn activity_list(&self, q: &ActivityQuery, waiting_panes: &[Id]) -> Result<Vec<ActivityEvent>> {
        let mut st = self.conn.prepare(
            "SELECT id, kind, occurred_at_ms, worktree_id, pane_id, agent_kind, title, detail, payload, attention_id FROM activity
             WHERE (?1 IS NULL OR occurred_at_ms < ?1) AND (?2 IS NULL OR worktree_id = ?2)
               AND (?3 = 0 OR attention_id IN (SELECT id FROM attention WHERE resolved_at_ms IS NULL
                    AND (COALESCE(kind, 'waiting') != 'waiting' OR (viewed_at_ms IS NULL AND pane_id IN (SELECT value FROM json_each(?5))))))
             ORDER BY occurred_at_ms DESC, rowid DESC LIMIT ?4",
        )?;
        let waiting = serde_json::to_string(waiting_panes)?;
        let rows =
            st.query_map(params![q.before_ms.map(|v| v as i64), q.worktree_id, q.needs_me as i64, q.limit.unwrap_or(100) as i64, waiting], Self::activity_row)?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }

    pub fn activity_since(&self, kind: impl Into<ActivityKind>, since_ms: u64) -> Result<Vec<ActivityEvent>> {
        let mut st = self.conn.prepare("SELECT id, kind, occurred_at_ms, worktree_id, pane_id, agent_kind, title, detail, payload, attention_id FROM activity WHERE kind = ?1 AND occurred_at_ms >= ?2")?;
        let rows = st.query_map(params![kind.into().as_str(), since_ms as i64], Self::activity_row)?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }

    pub fn attention_view(&self, id: &str, now_ms: u64) -> Result<bool> {
        let n = self.conn.execute("UPDATE attention SET viewed_at_ms = ?2 WHERE id = ?1 AND viewed_at_ms IS NULL", params![id, now_ms as i64])?;
        Ok(n > 0)
    }

    fn changed_ids(&self, sql: &str, pane_id: &str, now_ms: u64) -> Result<Vec<Id>> {
        let mut st = self.conn.prepare(sql)?;
        let rows = st.query_map(params![pane_id, now_ms as i64], |r| r.get(0))?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// Returns the ids that were not viewed before.
    pub fn attention_view_pane(&self, pane_id: &str, now_ms: u64) -> Result<Vec<Id>> {
        self.changed_ids("UPDATE attention SET viewed_at_ms = ?2 WHERE pane_id = ?1 AND viewed_at_ms IS NULL RETURNING id", pane_id, now_ms)
    }

    /// Resolves the open `waiting` items of a pane and returns their ids. Checkpoints and crashes stay open.
    pub fn attention_resolve_waiting(&self, pane_id: &str, now_ms: u64) -> Result<Vec<Id>> {
        self.changed_ids(
            "UPDATE attention SET resolved_at_ms = ?2, viewed_at_ms = COALESCE(viewed_at_ms, ?2)
             WHERE pane_id = ?1 AND COALESCE(kind, 'waiting') = 'waiting' AND resolved_at_ms IS NULL RETURNING id",
            pane_id,
            now_ms,
        )
    }

    pub fn attention_clear(&self) -> Result<()> {
        self.conn.execute("DELETE FROM attention", [])?;
        Ok(())
    }

    pub fn attention_prune(&self, keep: usize) -> Result<()> {
        self.conn.execute(
            "DELETE FROM attention WHERE viewed_at_ms IS NOT NULL AND id NOT IN (SELECT id FROM attention ORDER BY created_at_ms DESC LIMIT ?1)",
            params![keep as i64],
        )?;
        Ok(())
    }

    pub fn kv_get(&self, key: &str) -> Result<Option<String>> {
        Ok(self.conn.query_row("SELECT value FROM kv WHERE key = ?1", params![key], |r| r.get(0)).optional()?)
    }

    pub fn kv_set(&self, key: &str, value: &str) -> Result<()> {
        self.conn.execute("INSERT INTO kv (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value", params![key, value])?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tomo_proto::CoreActivity;

    #[test]
    fn metadata_round_trip_and_malformed_tags_degrade() {
        let s = Store::open_in_memory().unwrap();
        let row = MetaRow {
            id: "w1".into(),
            repo_id: "r1".into(),
            path: PathBuf::from("/tmp/w1"),
            gitdir: Some("w1".into()),
            metadata: WorktreeMetadata { display_name: Some("Labor".into()), project: Some("Holly".into()), state: None, tags: vec!["lr".into()] },
            last_active_ms: None,
            first_seen_ms: Some(5),
            archived_at_ms: Some(9),
            archived_branch: Some("feat".into()),
            infra_name: None,
        };
        s.meta_upsert(&row).unwrap();
        let back = s.meta_all().unwrap();
        assert_eq!((back[0].first_seen_ms, back[0].archived_at_ms, back[0].archived_branch.as_deref()), (Some(5), Some(9), Some("feat")));
        s.conn.execute("UPDATE worktree_meta SET tags = 'not json'", []).unwrap();
        let all = s.meta_all().unwrap();
        assert_eq!(all.len(), 1);
        assert!(all[0].metadata.tags.is_empty());
    }

    #[test]
    fn migration_adds_columns_to_an_old_schema() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE worktree_meta (id TEXT PRIMARY KEY, repo_id TEXT NOT NULL, path TEXT NOT NULL, gitdir TEXT, display_name TEXT, project TEXT, priority INTEGER, tags TEXT NOT NULL DEFAULT '[]', last_active_ms INTEGER);").unwrap();
        conn.execute_batch(SCHEMA).unwrap();
        migrate(&conn).unwrap();
        migrate(&conn).unwrap();
        let s = Store { conn };
        assert!(s.meta_all().unwrap().is_empty());
    }

    #[test]
    fn rebind_moves_activity_rows() {
        let s = Store::open_in_memory().unwrap();
        s.activity_insert(&activity("a", 1, CoreActivity::Archived.into(), None)).unwrap();
        s.rebind_worktree("w", "w2", Path::new("/tmp/w2")).unwrap();
        let count = |w: &str| s.activity_list(&ActivityQuery { worktree_id: Some(w.into()), ..Default::default() }, &[]).unwrap().len();
        assert_eq!((count("w"), count("w2")), (0, 1));
    }

    #[test]
    fn rebind_onto_a_live_row_fills_its_blanks_and_leaves_one_row() {
        let s = Store::open_in_memory().unwrap();
        let row = |id: &str, name: Option<&str>, project: Option<&str>, first_seen: u64| MetaRow {
            id: id.into(),
            repo_id: "r1".into(),
            path: PathBuf::from("/tmp/w"),
            gitdir: Some("w".into()),
            metadata: WorktreeMetadata { display_name: name.map(Into::into), project: project.map(Into::into), state: None, tags: vec![] },
            last_active_ms: None,
            first_seen_ms: Some(first_seen),
            archived_at_ms: None,
            archived_branch: None,
            infra_name: Some(format!("tomo-w-{id}")),
        };
        s.meta_upsert(&row("stale", Some("Moriya"), Some("old"), 1)).unwrap();
        s.meta_upsert(&row("live", None, Some("new"), 9)).unwrap();
        s.rebind_worktree("stale", "live", Path::new("/tmp/w")).unwrap();
        let all = s.meta_all().unwrap();
        assert_eq!(all.len(), 1);
        let m = &all[0];
        assert_eq!(m.id, "live");
        assert_eq!(m.metadata.display_name.as_deref(), Some("Moriya"), "a blank takes the old value");
        assert_eq!(m.metadata.project.as_deref(), Some("new"), "a set value stays");
        assert_eq!(m.first_seen_ms, Some(1), "the earliest sighting stays");
        assert_eq!(m.infra_name.as_deref(), Some("tomo-w-live"));
    }

    fn item(id: &str, kind: AttentionKind) -> AttentionItem {
        AttentionItem {
            id: id.into(),
            worktree_id: "w".into(),
            pane_id: None,
            level: AttentionLevel::Attention,
            message: id.into(),
            created_at_ms: 1,
            viewed_at_ms: None,
            kind,
            url: None,
            agent_kind: None,
            resolved_at_ms: None,
        }
    }

    fn activity(id: &str, at: u64, kind: ActivityKind, attention_id: Option<&str>) -> ActivityEvent {
        ActivityEvent {
            id: id.into(),
            kind,
            occurred_at_ms: at,
            worktree_id: Some("w".into()),
            pane_id: None,
            agent_kind: None,
            title: id.into(),
            detail: None,
            payload: serde_json::json!({ "port": 3000 }),
            attention_id: attention_id.map(String::from),
        }
    }

    #[test]
    fn activity_lists_newest_first_and_needs_me_follows_attention_state() {
        let s = Store::open_in_memory().unwrap();
        s.attention_insert(&item("chk", AttentionKind::Checkpoint)).unwrap();
        s.attention_insert(&AttentionItem { pane_id: Some("p".into()), ..item("wait", AttentionKind::Waiting) }).unwrap();
        s.activity_insert(&activity("a", 10, CoreActivity::AgentStarted.into(), None)).unwrap();
        s.activity_insert(&activity("b", 20, CoreActivity::CheckpointCreated.into(), Some("chk"))).unwrap();
        s.activity_insert(&activity("c", 20, CoreActivity::AgentWaiting.into(), Some("wait"))).unwrap();
        let ids = |q: ActivityQuery| s.activity_list(&q, &["p".to_string()]).unwrap().iter().map(|e| e.id.clone()).collect::<Vec<_>>();
        assert_eq!(ids(ActivityQuery::default()), vec!["c", "b", "a"]);
        assert_eq!(ids(ActivityQuery { before_ms: Some(20), ..Default::default() }), vec!["a"]);
        assert_eq!(ids(ActivityQuery { needs_me: true, ..Default::default() }), vec!["c", "b"]);
        s.attention_view("wait", 5).unwrap();
        assert_eq!(ids(ActivityQuery { needs_me: true, ..Default::default() }), vec!["b"]);
        assert!(s.attention_resolve("chk", 6).unwrap());
        assert!(!s.attention_resolve("chk", 7).unwrap());
        assert!(ids(ActivityQuery { needs_me: true, ..Default::default() }).is_empty());
        assert_eq!(s.attention_list().unwrap().iter().map(|a| a.id.as_str()).collect::<Vec<_>>(), vec!["wait"]);
        assert_eq!(s.attention_get("chk").unwrap().unwrap().resolved_at_ms, Some(6));
        assert_eq!(s.activity_list(&ActivityQuery::default(), &[]).unwrap()[0].payload["port"], 3000);
        assert_eq!(s.activity_since(CoreActivity::CheckpointCreated, 15).unwrap().len(), 1);
        s.activity_trim(2).unwrap();
        assert_eq!(ids(ActivityQuery::default()), vec!["c", "b"]);
    }

    const STORED_KINDS: [&str; 16] = [
        "agent_started",
        "agent_waiting",
        "agent_exited",
        "checkpoint_created",
        "checkpoint_resolved",
        "action_started",
        "action_stopped",
        "action_completed",
        "action_crashed",
        "endpoint_discovered",
        "annotations_sent",
        "state_changed",
        "archived",
        "restored",
        "hook_failed",
        "pr_merged",
    ];

    fn kind_str(e: &ActivityEvent) -> String {
        serde_json::to_value(&e.kind).unwrap().as_str().unwrap().to_string()
    }

    #[test]
    fn every_stored_activity_kind_round_trips_with_the_same_string() {
        let s = Store::open_in_memory().unwrap();
        for (i, k) in STORED_KINDS.iter().enumerate() {
            let kind = serde_json::from_value(serde_json::json!(k)).unwrap();
            s.activity_insert(&activity(k, i as u64, kind, None)).unwrap();
            let column: String = s.conn.query_row("SELECT kind FROM activity WHERE id = ?1", [k], |r| r.get(0)).unwrap();
            assert_eq!(column, *k);
        }
        let back: Vec<String> = s.activity_list(&ActivityQuery { limit: Some(100), ..Default::default() }, &[]).unwrap().iter().map(kind_str).collect();
        assert_eq!(back, STORED_KINDS.iter().rev().map(|k| k.to_string()).collect::<Vec<_>>());
    }

    #[test]
    fn an_unknown_stored_kind_keeps_its_string() {
        let s = Store::open_in_memory().unwrap();
        s.conn.execute("INSERT INTO activity (id, kind, occurred_at_ms, title) VALUES ('u', 'future.thing', 1, 'from a newer build')", []).unwrap();
        let back = s.activity_list(&ActivityQuery::default(), &[]).unwrap();
        assert_eq!((back.len(), kind_str(&back[0]), back[0].title.as_str()), (1, "future.thing".to_string(), "from a newer build"));
    }

    #[test]
    fn activity_list_filters_by_worktree_and_limit() {
        let s = Store::open_in_memory().unwrap();
        let kind = || serde_json::from_value(serde_json::json!("archived")).unwrap();
        s.activity_insert(&activity("a", 1, kind(), None)).unwrap();
        s.activity_insert(&ActivityEvent { worktree_id: Some("other".into()), ..activity("b", 2, kind(), None) }).unwrap();
        s.activity_insert(&activity("c", 3, kind(), None)).unwrap();
        let ids = |q: ActivityQuery| s.activity_list(&q, &[]).unwrap().iter().map(|e| e.id.clone()).collect::<Vec<_>>();
        assert_eq!(ids(ActivityQuery { worktree_id: Some("w".into()), ..Default::default() }), vec!["c", "a"]);
        assert_eq!(ids(ActivityQuery { limit: Some(2), ..Default::default() }), vec!["c", "b"]);
        assert_eq!(ids(ActivityQuery { limit: Some(1), worktree_id: Some("other".into()), ..Default::default() }), vec!["b"]);
    }

    #[test]
    fn needs_me_follows_the_cases_that_the_client_tests() {
        let s = Store::open_in_memory().unwrap();
        let kind = || serde_json::from_value(serde_json::json!("agent_waiting")).unwrap();
        let waits = Some(true);
        let works = Some(false);
        let cases = [
            ("waiting-agent-waits", AttentionKind::Waiting, None, None, waits, true),
            ("waiting-agent-moved-on", AttentionKind::Waiting, None, None, works, false),
            ("waiting-no-agent-in-the-pane", AttentionKind::Waiting, None, None, None, false),
            ("waiting-viewed", AttentionKind::Waiting, Some(2), None, waits, false),
            ("waiting-resolved", AttentionKind::Waiting, None, Some(2), waits, false),
            ("checkpoint-viewed-agent-working", AttentionKind::Checkpoint, Some(2), None, works, true),
            ("checkpoint-resolved", AttentionKind::Checkpoint, None, Some(2), None, false),
            ("crash-viewed-no-agent", AttentionKind::Crash, Some(2), None, None, true),
            ("crash-resolved", AttentionKind::Crash, None, Some(2), None, false),
        ];
        for (i, (id, attention_kind, viewed, resolved, _, _)) in cases.iter().enumerate() {
            s.attention_insert(&AttentionItem { viewed_at_ms: *viewed, resolved_at_ms: *resolved, pane_id: Some(id.to_string()), ..item(id, *attention_kind) })
                .unwrap();
            s.activity_insert(&activity(id, i as u64, kind(), Some(id))).unwrap();
        }
        s.activity_insert(&activity("orphan", 50, kind(), Some("missing"))).unwrap();
        let waiting_panes: Vec<Id> = cases.iter().filter(|c| c.4 == waits).map(|c| c.0.to_string()).collect();
        let mut open: Vec<String> =
            s.activity_list(&ActivityQuery { needs_me: true, ..Default::default() }, &waiting_panes).unwrap().into_iter().map(|e| e.id).collect();
        open.sort();
        let mut expected: Vec<String> = cases.iter().filter(|c| c.5).map(|c| c.0.to_string()).collect();
        expected.sort();
        assert_eq!(open, expected);
    }

    #[test]
    fn pane_view_and_waiting_resolve_return_changed_ids() {
        let s = Store::open_in_memory().unwrap();
        let on_pane = |id: &str, kind| AttentionItem { pane_id: Some("p".into()), ..item(id, kind) };
        s.attention_insert(&on_pane("w1", AttentionKind::Waiting)).unwrap();
        s.attention_insert(&on_pane("w2", AttentionKind::Waiting)).unwrap();
        s.attention_insert(&on_pane("chk", AttentionKind::Checkpoint)).unwrap();
        s.attention_insert(&on_pane("crash", AttentionKind::Crash)).unwrap();
        s.attention_insert(&item("elsewhere", AttentionKind::Waiting)).unwrap();
        assert!(s.attention_view("w2", 3).unwrap());
        assert!(!s.attention_view("w2", 4).unwrap());
        let mut resolved = s.attention_resolve_waiting("p", 5).unwrap();
        resolved.sort();
        assert_eq!(resolved, vec!["w1", "w2"]);
        assert!(s.attention_resolve_waiting("p", 6).unwrap().is_empty());
        let (w1, w2) = (s.attention_get("w1").unwrap().unwrap(), s.attention_get("w2").unwrap().unwrap());
        assert_eq!((w1.resolved_at_ms, w1.viewed_at_ms, w2.viewed_at_ms), (Some(5), Some(5), Some(3)));
        assert_eq!(s.attention_list().unwrap().iter().map(|a| a.id.as_str()).collect::<Vec<_>>(), vec!["chk", "crash", "elsewhere"]);
        let mut viewed = s.attention_view_pane("p", 7).unwrap();
        viewed.sort();
        assert_eq!(viewed, vec!["chk", "crash"]);
        assert!(s.attention_view_pane("p", 8).unwrap().is_empty());
    }

    #[test]
    fn browser_pane_keeps_kind_and_url() {
        let s = Store::open_in_memory().unwrap();
        let row = PaneRow {
            id: "p1".into(),
            tab_id: "t".into(),
            worktree_id: "w".into(),
            user_title: None,
            cwd: PathBuf::from("/tmp"),
            cols: 1,
            rows: 1,
            agent_kind: None,
            session_ref: None,
            created_at_ms: 1,
            kind: PaneKind::Browser,
            url: Some("http://localhost:1420/".into()),
        };
        s.pane_upsert(&row).unwrap();
        let back = s.panes().unwrap();
        assert_eq!((back[0].kind, back[0].url.as_deref()), (PaneKind::Browser, Some("http://localhost:1420/")));
        s.conn.execute("UPDATE panes SET kind = NULL, url = NULL", []).unwrap();
        assert_eq!(s.panes().unwrap()[0].kind, PaneKind::Terminal);
    }

    #[test]
    fn tabs_with_bad_layout_are_skipped() {
        let s = Store::open_in_memory().unwrap();
        s.tab_upsert(&TabRow {
            id: "t1".into(),
            worktree_id: "w".into(),
            title: "x".into(),
            position: 0,
            layout: LayoutNode::Leaf { pane_id: "p".into() },
            active_pane_id: None,
            is_active: true,
        })
        .unwrap();
        s.conn.execute("INSERT INTO tabs VALUES ('t2','w','y',1,'{bad',NULL,0)", []).unwrap();
        let tabs = s.tabs().unwrap();
        assert_eq!(tabs.len(), 1);
        assert_eq!(tabs[0].id, "t1");
    }
}
