//! SQLite persistence.
//!
//! Every table falls into one of three categories (PRD §25):
//! - authoritative Tomo metadata: `repos`, the user-set columns of `worktree_meta`
//! - cached external observation: `worktree_meta.path`, `worktree_meta.gitdir`
//! - recoverable runtime state: `tabs`, `panes`, `attention`, `kv`
//!
//! Git remains the authority for branches and worktree existence; nothing here
//! stores a branch name.

use anyhow::{Context, Result};
use rusqlite::{params, Connection, OptionalExtension};
use std::path::{Path, PathBuf};
use tomo_proto::{AgentKind, AttentionItem, AttentionLevel, Id, LayoutNode, WorktreeMetadata};

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
"#;

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
        Ok(Store { conn })
    }

    #[cfg(test)]
    pub fn open_in_memory() -> Result<Self> {
        let conn = Connection::open_in_memory()?;
        conn.execute_batch(SCHEMA)?;
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
            "SELECT id, repo_id, path, gitdir, display_name, project, priority, tags, last_active_ms FROM worktree_meta",
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
                    priority: r.get::<_, Option<i64>>(6)?.map(|p| p.clamp(1, 4) as u8),
                    tags: serde_json::from_str(&tags).unwrap_or_default(),
                },
                last_active_ms: r.get::<_, Option<i64>>(8)?.map(|v| v as u64),
            })
        })?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }

    pub fn meta_upsert(&self, row: &MetaRow) -> Result<()> {
        self.conn.execute(
            "INSERT INTO worktree_meta (id, repo_id, path, gitdir, display_name, project, priority, tags, last_active_ms)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
             ON CONFLICT(id) DO UPDATE SET repo_id=excluded.repo_id, path=excluded.path, gitdir=excluded.gitdir,
               display_name=excluded.display_name, project=excluded.project, priority=excluded.priority,
               tags=excluded.tags, last_active_ms=excluded.last_active_ms",
            params![
                row.id,
                row.repo_id,
                row.path.to_string_lossy(),
                row.gitdir,
                row.metadata.display_name,
                row.metadata.project,
                row.metadata.priority.map(|p| p as i64),
                serde_json::to_string(&row.metadata.tags)?,
                row.last_active_ms.map(|v| v as i64),
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
            "SELECT id, tab_id, worktree_id, user_title, cwd, cols, rows, agent_kind, session_ref, created_at_ms FROM panes",
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
            })
        })?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }

    pub fn pane_upsert(&self, p: &PaneRow) -> Result<()> {
        self.conn.execute(
            "INSERT INTO panes (id, tab_id, worktree_id, user_title, cwd, cols, rows, agent_kind, session_ref, created_at_ms)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
             ON CONFLICT(id) DO UPDATE SET tab_id=excluded.tab_id, worktree_id=excluded.worktree_id, user_title=excluded.user_title,
               cwd=excluded.cwd, cols=excluded.cols, rows=excluded.rows, agent_kind=excluded.agent_kind,
               session_ref=excluded.session_ref",
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
                p.created_at_ms as i64
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
            "INSERT INTO attention (id, worktree_id, pane_id, level, message, created_at_ms, viewed_at_ms) VALUES (?1,?2,?3,?4,?5,?6,?7)",
            params![
                item.id,
                item.worktree_id,
                item.pane_id,
                level_str(item.level),
                item.message,
                item.created_at_ms as i64,
                item.viewed_at_ms.map(|v| v as i64)
            ],
        )?;
        Ok(())
    }

    pub fn attention_list(&self) -> Result<Vec<AttentionItem>> {
        let mut st = self.conn.prepare(
            "SELECT id, worktree_id, pane_id, level, message, created_at_ms, viewed_at_ms FROM attention ORDER BY created_at_ms",
        )?;
        let rows = st.query_map([], |r| {
            Ok(AttentionItem {
                id: r.get(0)?,
                worktree_id: r.get(1)?,
                pane_id: r.get(2)?,
                level: parse_level(&r.get::<_, String>(3)?),
                message: r.get(4)?,
                created_at_ms: r.get::<_, i64>(5)? as u64,
                viewed_at_ms: r.get::<_, Option<i64>>(6)?.map(|v| v as u64),
            })
        })?;
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
            metadata: WorktreeMetadata { display_name: Some("Labor".into()), project: Some("Holly".into()), priority: Some(1), tags: vec!["lr".into()] },
            last_active_ms: None,
        };
        s.meta_upsert(&row).unwrap();
        s.conn.execute("UPDATE worktree_meta SET tags = 'not json', priority = 99", []).unwrap();
        let all = s.meta_all().unwrap();
        assert_eq!(all.len(), 1);
        assert!(all[0].metadata.tags.is_empty());
        assert_eq!(all[0].metadata.priority, Some(4));
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
