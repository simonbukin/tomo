//! SQLite persistence.
//!
//! Every table falls into one of three categories (PRD §25):
//! - authoritative Tomo metadata: `repos`, `towns`, the user-set columns of `worktree_meta`
//! - cached external observation: `worktree_meta.path`, `.gitdir`, `.first_seen_ms`, `.archived_at_ms`, `.archived_branch`
//! - recoverable runtime state: `tabs`, `panes`, `attention`, `activity`, `kv`
//!
//! `worktree_meta.town_slug` is unused since Phase 2; the `towns` table owns
//! the worktree→town mapping. The column stays because SQLite cannot drop it cheaply.
//!
//! Git remains the authority for branches and worktree existence; nothing here
//! stores a branch name.

use anyhow::{Context, Result};
use rusqlite::{params, Connection, OptionalExtension};
use std::path::{Path, PathBuf};
use tomo_proto::{ActivityEvent, ActivityKind, ActivityQuery, AgentKind, AttentionItem, AttentionKind, AttentionLevel, Id, LayoutNode, TownUnlock, WorktreeMetadata};

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
    pub action_id: Option<String>,
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
CREATE TABLE IF NOT EXISTS towns (
  slug TEXT PRIMARY KEY,
  worktree_id TEXT NOT NULL,
  repo_id TEXT NOT NULL,
  unlocked_at_ms INTEGER NOT NULL
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

const META_COLUMNS: [(&str, &str); 5] = [
    ("first_seen_ms", "INTEGER"),
    ("archived_at_ms", "INTEGER"),
    ("archived_branch", "TEXT"),
    ("town_slug", "TEXT"),
    ("state", "TEXT"),
];

const PANE_COLUMNS: [(&str, &str); 1] = [("action_id", "TEXT")];

const ATTENTION_COLUMNS: [(&str, &str); 4] = [("kind", "TEXT"), ("url", "TEXT"), ("agent_kind", "TEXT"), ("resolved_at_ms", "INTEGER")];

fn add_missing_columns(conn: &Connection, table: &str, columns: &[(&str, &str)]) -> Result<()> {
    let existing: Vec<String> = conn.prepare(&format!("PRAGMA table_info({table})"))?.query_map([], |r| r.get::<_, String>(1))?.filter_map(|r| r.ok()).collect();
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

fn level_str(l: AttentionLevel) -> &'static str {
    match l {
        AttentionLevel::Attention => "attention",
        AttentionLevel::Info => "info",
    }
}

fn parse_level(s: &str) -> AttentionLevel {
    if s == "info" { AttentionLevel::Info } else { AttentionLevel::Attention }
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

    pub fn repos(&self) -> Result<Vec<RepoRow>> {
        let mut st = self.conn.prepare("SELECT id, path FROM repos ORDER BY added_at_ms")?;
        let rows = st.query_map([], |r| Ok(RepoRow { id: r.get(0)?, path: PathBuf::from(r.get::<_, String>(1)?) }))?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }

    pub fn repo_add(&self, id: &str, path: &Path, now_ms: u64) -> Result<()> {
        self.conn.execute(
            "INSERT OR IGNORE INTO repos (id, path, added_at_ms) VALUES (?1, ?2, ?3)",
            params![id, path.to_string_lossy(), now_ms as i64],
        )?;
        Ok(())
    }

    pub fn repo_remove(&self, id: &str) -> Result<()> {
        self.conn.execute("DELETE FROM repos WHERE id = ?1", params![id])?;
        Ok(())
    }

    pub fn meta_all(&self) -> Result<Vec<MetaRow>> {
        let mut st = self.conn.prepare(
            "SELECT id, repo_id, path, gitdir, display_name, project, priority, tags, last_active_ms, first_seen_ms, archived_at_ms, archived_branch, state FROM worktree_meta",
        )?;
        let rows = st.query_map([], |r| {
            let tags: String = r.get(7)?;
            Ok(MetaRow {
                id: r.get(0)?,
                repo_id: r.get(1)?,
                path: PathBuf::from(r.get::<_, String>(2)?),
                gitdir: r.get(3)?,
                metadata: WorktreeMetadata {
                    display_name: r.get(4)?,
                    project: r.get(5)?,
                    state: r.get(12)?,
                    tags: serde_json::from_str(&tags).unwrap_or_default(),
                },
                last_active_ms: r.get::<_, Option<i64>>(8)?.map(|v| v as u64),
                first_seen_ms: r.get::<_, Option<i64>>(9)?.map(|v| v as u64),
                archived_at_ms: r.get::<_, Option<i64>>(10)?.map(|v| v as u64),
                archived_branch: r.get(11)?,
            })
        })?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }

    pub fn meta_upsert(&self, row: &MetaRow) -> Result<()> {
        self.conn.execute(
            "INSERT INTO worktree_meta (id, repo_id, path, gitdir, display_name, project, priority, tags, last_active_ms, first_seen_ms, archived_at_ms, archived_branch, state)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
             ON CONFLICT(id) DO UPDATE SET repo_id=excluded.repo_id, path=excluded.path, gitdir=excluded.gitdir,
               display_name=excluded.display_name, project=excluded.project, priority=excluded.priority,
               tags=excluded.tags, last_active_ms=excluded.last_active_ms, first_seen_ms=excluded.first_seen_ms,
               archived_at_ms=excluded.archived_at_ms, archived_branch=excluded.archived_branch, state=excluded.state",
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
            ],
        )?;
        Ok(())
    }

    pub fn rebind_worktree(&self, old_id: &str, new_id: &str, new_path: &Path) -> Result<()> {
        let path = new_path.to_string_lossy();
        self.conn.execute("UPDATE worktree_meta SET id = ?2, path = ?3 WHERE id = ?1", params![old_id, new_id, path])?;
        self.conn.execute("UPDATE tabs SET worktree_id = ?2 WHERE worktree_id = ?1", params![old_id, new_id])?;
        self.conn.execute("UPDATE panes SET worktree_id = ?2 WHERE worktree_id = ?1", params![old_id, new_id])?;
        self.conn.execute("UPDATE attention SET worktree_id = ?2 WHERE worktree_id = ?1", params![old_id, new_id])?;
        Ok(())
    }

    pub fn meta_touch(&self, id: &str, now_ms: u64) -> Result<()> {
        self.conn.execute("UPDATE worktree_meta SET last_active_ms = ?2 WHERE id = ?1", params![id, now_ms as i64])?;
        Ok(())
    }

    pub fn tabs(&self) -> Result<Vec<TabRow>> {
        let mut st = self.conn.prepare(
            "SELECT id, worktree_id, title, position, layout, active_pane_id, is_active FROM tabs ORDER BY position",
        )?;
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
            params![
                t.id,
                t.worktree_id,
                t.title,
                t.position,
                serde_json::to_string(&t.layout)?,
                t.active_pane_id,
                t.is_active as i64
            ],
        )?;
        Ok(())
    }

    pub fn tab_delete(&self, id: &str) -> Result<()> {
        self.conn.execute("DELETE FROM tabs WHERE id = ?1", params![id])?;
        Ok(())
    }

    pub fn panes(&self) -> Result<Vec<PaneRow>> {
        let mut st = self.conn.prepare(
            "SELECT id, tab_id, worktree_id, user_title, cwd, cols, rows, agent_kind, session_ref, created_at_ms, action_id FROM panes",
        )?;
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
                action_id: r.get(10)?,
            })
        })?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }

    pub fn pane_upsert(&self, p: &PaneRow) -> Result<()> {
        self.conn.execute(
            "INSERT INTO panes (id, tab_id, worktree_id, user_title, cwd, cols, rows, agent_kind, session_ref, created_at_ms, action_id)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
             ON CONFLICT(id) DO UPDATE SET tab_id=excluded.tab_id, worktree_id=excluded.worktree_id, user_title=excluded.user_title,
               cwd=excluded.cwd, cols=excluded.cols, rows=excluded.rows, agent_kind=excluded.agent_kind,
               session_ref=excluded.session_ref, action_id=excluded.action_id",
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
                p.action_id
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

    const ATTENTION_SELECT: &'static str = "SELECT id, worktree_id, pane_id, level, message, created_at_ms, viewed_at_ms, kind, url, agent_kind, resolved_at_ms FROM attention";

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
                enum_str(e.kind),
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
        self.conn.execute("DELETE FROM activity WHERE rowid NOT IN (SELECT rowid FROM activity ORDER BY occurred_at_ms DESC, rowid DESC LIMIT ?1)", params![keep as i64])?;
        Ok(())
    }

    fn activity_row(r: &rusqlite::Row) -> rusqlite::Result<ActivityEvent> {
        let payload: String = r.get(8)?;
        Ok(ActivityEvent {
            id: r.get(0)?,
            kind: parse_enum::<ActivityKind>(r.get(1)?).unwrap_or(ActivityKind::HookFailed),
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

    /// Newest first. `needs_me` keeps only events whose attention item is still open:
    /// unresolved, and for a `waiting` item also not yet viewed.
    pub fn activity_list(&self, q: &ActivityQuery) -> Result<Vec<ActivityEvent>> {
        let mut st = self.conn.prepare(
            "SELECT id, kind, occurred_at_ms, worktree_id, pane_id, agent_kind, title, detail, payload, attention_id FROM activity
             WHERE (?1 IS NULL OR occurred_at_ms < ?1) AND (?2 IS NULL OR worktree_id = ?2)
               AND (?3 = 0 OR attention_id IN (SELECT id FROM attention WHERE resolved_at_ms IS NULL AND (COALESCE(kind, 'waiting') != 'waiting' OR viewed_at_ms IS NULL)))
             ORDER BY occurred_at_ms DESC, rowid DESC LIMIT ?4",
        )?;
        let rows = st.query_map(params![q.before_ms.map(|v| v as i64), q.worktree_id, q.needs_me as i64, q.limit.unwrap_or(100) as i64], Self::activity_row)?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }

    pub fn activity_since(&self, kind: ActivityKind, since_ms: u64) -> Result<Vec<ActivityEvent>> {
        let mut st = self.conn.prepare("SELECT id, kind, occurred_at_ms, worktree_id, pane_id, agent_kind, title, detail, payload, attention_id FROM activity WHERE kind = ?1 AND occurred_at_ms >= ?2")?;
        let rows = st.query_map(params![enum_str(kind), since_ms as i64], Self::activity_row)?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }

    pub fn attention_view(&self, id: &str, now_ms: u64) -> Result<()> {
        self.conn.execute("UPDATE attention SET viewed_at_ms = ?2 WHERE id = ?1 AND viewed_at_ms IS NULL", params![id, now_ms as i64])?;
        Ok(())
    }

    pub fn attention_view_pane(&self, pane_id: &str, now_ms: u64) -> Result<()> {
        self.conn.execute(
            "UPDATE attention SET viewed_at_ms = ?2 WHERE pane_id = ?1 AND viewed_at_ms IS NULL",
            params![pane_id, now_ms as i64],
        )?;
        Ok(())
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

    pub fn town_unlocks(&self) -> Result<Vec<TownUnlock>> {
        let mut st = self.conn.prepare("SELECT slug, worktree_id, repo_id, unlocked_at_ms FROM towns ORDER BY unlocked_at_ms")?;
        let rows = st.query_map([], |r| {
            Ok(TownUnlock { slug: r.get(0)?, worktree_id: r.get(1)?, repo_id: r.get(2)?, unlocked_at_ms: r.get::<_, i64>(3)? as u64 })
        })?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }

    pub fn town_unlock(&self, u: &TownUnlock) -> Result<()> {
        self.conn.execute(
            "INSERT OR IGNORE INTO towns (slug, worktree_id, repo_id, unlocked_at_ms) VALUES (?1, ?2, ?3, ?4)",
            params![u.slug, u.worktree_id, u.repo_id, u.unlocked_at_ms as i64],
        )?;
        Ok(())
    }

    pub fn kv_get(&self, key: &str) -> Result<Option<String>> {
        Ok(self.conn.query_row("SELECT value FROM kv WHERE key = ?1", params![key], |r| r.get(0)).optional()?)
    }

    pub fn kv_set(&self, key: &str, value: &str) -> Result<()> {
        self.conn.execute(
            "INSERT INTO kv (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            params![key, value],
        )?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
        s.town_unlock(&TownUnlock { slug: "x".into(), worktree_id: "w".into(), repo_id: "r".into(), unlocked_at_ms: 1 }).unwrap();
        assert_eq!(s.town_unlocks().unwrap().len(), 1);
        assert!(s.meta_all().unwrap().is_empty());
    }

    fn item(id: &str, kind: AttentionKind) -> AttentionItem {
        AttentionItem { id: id.into(), worktree_id: "w".into(), pane_id: None, level: AttentionLevel::Attention, message: id.into(), created_at_ms: 1, viewed_at_ms: None, kind, url: None, agent_kind: None, resolved_at_ms: None }
    }

    fn activity(id: &str, at: u64, kind: ActivityKind, attention_id: Option<&str>) -> ActivityEvent {
        ActivityEvent { id: id.into(), kind, occurred_at_ms: at, worktree_id: Some("w".into()), pane_id: None, agent_kind: None, title: id.into(), detail: None, payload: serde_json::json!({ "port": 3000 }), attention_id: attention_id.map(String::from) }
    }

    #[test]
    fn activity_lists_newest_first_and_needs_me_follows_attention_state() {
        let s = Store::open_in_memory().unwrap();
        s.attention_insert(&item("chk", AttentionKind::Checkpoint)).unwrap();
        s.attention_insert(&item("wait", AttentionKind::Waiting)).unwrap();
        s.activity_insert(&activity("a", 10, ActivityKind::ActionStarted, None)).unwrap();
        s.activity_insert(&activity("b", 20, ActivityKind::CheckpointCreated, Some("chk"))).unwrap();
        s.activity_insert(&activity("c", 20, ActivityKind::AgentWaiting, Some("wait"))).unwrap();
        let ids = |q: ActivityQuery| s.activity_list(&q).unwrap().iter().map(|e| e.id.clone()).collect::<Vec<_>>();
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
        assert_eq!(s.activity_list(&ActivityQuery::default()).unwrap()[0].payload["port"], 3000);
        assert_eq!(s.activity_since(ActivityKind::CheckpointCreated, 15).unwrap().len(), 1);
        s.activity_trim(2).unwrap();
        assert_eq!(ids(ActivityQuery::default()), vec!["c", "b"]);
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
