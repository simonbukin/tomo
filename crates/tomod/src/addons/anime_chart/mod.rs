//! Anime chart: the worktrees that Tomo archived, and the moment of each archive.
//! It owns one table, joins the `worktree_archived` seam, and does no background work.

use crate::daemon::{internal, ok, ArchivedWorktree, Daemon};
use crate::store::Store;
use anyhow::Result;
use rusqlite::params;
use serde_json::Value;
use std::sync::Arc;
use tomo_proto::{ArchivedShow, RpcError};

pub fn migrate(store: &Store) -> Result<()> {
    store.conn().execute(
        "CREATE TABLE IF NOT EXISTS anime_chart (worktree_id TEXT PRIMARY KEY, name TEXT NOT NULL, archived_at_ms INTEGER NOT NULL)",
        [],
    )?;
    Ok(())
}

/// The `worktree_archived` seam. A second archive of the same worktree keeps the newest moment.
pub fn archived(store: &Store, worktree: &ArchivedWorktree) {
    let written = store.conn().execute(
        "INSERT OR REPLACE INTO anime_chart (worktree_id, name, archived_at_ms) VALUES (?1, ?2, ?3)",
        params![worktree.id, worktree.name, worktree.at_ms as i64],
    );
    if let Err(e) = written {
        tracing::warn!("anime chart: {}: {e}", worktree.id);
    }
}

pub fn shows(store: &Store) -> Result<Vec<ArchivedShow>> {
    let mut statement = store.conn().prepare("SELECT worktree_id, name, archived_at_ms FROM anime_chart ORDER BY archived_at_ms DESC")?;
    let rows = statement.query_map([], |r| {
        Ok(ArchivedShow {
            worktree_id: r.get(0)?,
            name: r.get(1)?,
            archived_at_ms: r.get::<_, i64>(2)? as u64,
        })
    })?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

pub fn list(daemon: &Arc<Daemon>) -> Result<Value, RpcError> {
    let inner = daemon.lock();
    let shows = shows(&inner.store).map_err(internal)?;
    drop(inner);
    ok(shows)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn archive(store: &Store, id: &str, name: &str, at_ms: u64) {
        archived(store, &ArchivedWorktree { id: id.to_string(), name: name.to_string(), at_ms });
    }

    #[test]
    fn the_chart_lists_the_newest_archive_of_each_worktree_first() {
        let store = Store::open_in_memory().unwrap();
        migrate(&store).unwrap();
        archive(&store, "w1", "alpha", 100);
        archive(&store, "w2", "beta", 300);
        archive(&store, "w1", "alpha", 500);

        let listed: Vec<(String, u64)> = shows(&store).unwrap().into_iter().map(|s| (s.name, s.archived_at_ms)).collect();
        assert_eq!(listed, vec![("alpha".to_string(), 500), ("beta".to_string(), 300)]);
    }

    #[test]
    fn a_second_migrate_keeps_the_rows() {
        let store = Store::open_in_memory().unwrap();
        migrate(&store).unwrap();
        archive(&store, "w1", "alpha", 100);
        migrate(&store).unwrap();
        assert_eq!(shows(&store).unwrap().len(), 1);
    }
}
