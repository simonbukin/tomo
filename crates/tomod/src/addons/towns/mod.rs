//! Japan Towns: names a new worktree after a Japanese municipality and keeps the collection of unlocks.
//! It owns the `towns` table. See docs/features/towns.md.

mod model;

use crate::daemon::{err, internal, ok, CreatedWorktree, Daemon, Inner};
use crate::store::Store;
use rusqlite::params;
use serde_json::{json, Value};
use std::collections::HashSet;
use tomo_proto::*;

const SCHEMA: &str = "CREATE TABLE IF NOT EXISTS towns (
  slug TEXT PRIMARY KEY,
  worktree_id TEXT NOT NULL,
  repo_id TEXT NOT NULL,
  unlocked_at_ms INTEGER NOT NULL
);";

pub fn migrate(store: &Store) -> anyhow::Result<()> {
    Ok(store.conn().execute_batch(SCHEMA)?)
}

fn unlocks(store: &Store) -> anyhow::Result<Vec<TownUnlock>> {
    let mut st = store.conn().prepare("SELECT slug, worktree_id, repo_id, unlocked_at_ms FROM towns ORDER BY unlocked_at_ms")?;
    let rows =
        st.query_map([], |r| Ok(TownUnlock { slug: r.get(0)?, worktree_id: r.get(1)?, repo_id: r.get(2)?, unlocked_at_ms: r.get::<_, i64>(3)? as u64 }))?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

fn unlocked_slugs(store: &Store) -> Result<HashSet<String>, RpcError> {
    Ok(unlocks(store).map_err(internal)?.into_iter().map(|u| u.slug).collect())
}

fn insert(store: &Store, u: &TownUnlock) -> anyhow::Result<()> {
    store.conn().execute(
        "INSERT OR IGNORE INTO towns (slug, worktree_id, repo_id, unlocked_at_ms) VALUES (?1, ?2, ?3, ?4)",
        params![u.slug, u.worktree_id, u.repo_id, u.unlocked_at_ms as i64],
    )?;
    Ok(())
}

/// The `worktree_namer` seam. `name_hint` asks for one locked town; without it, a weighted random pick.
pub fn name_worktree(store: &Store, spec: &WorktreeCreate) -> Result<Option<String>, RpcError> {
    let unlocked = unlocked_slugs(store)?;
    let town = match &spec.name_hint {
        Some(slug) => model::find(slug)
            .filter(|t| !unlocked.contains(&t.slug))
            .ok_or_else(|| err(ErrorCode::BadRequest, format!("town {slug} is unknown or already unlocked")))?,
        None => model::pick(&unlocked).ok_or_else(|| err(ErrorCode::Conflict, "every town is unlocked; pass a path"))?,
    };
    Ok(Some(town.slug.clone()))
}

/// The `worktree_created` seam. It writes the unlock one time and gives the worktree the town name.
pub fn unlock(inner: &mut Inner, created: &CreatedWorktree) -> Result<(), RpcError> {
    let Some(town) = created.name.as_deref().and_then(model::find) else { return Ok(()) };
    let unlock = TownUnlock { slug: town.slug.clone(), worktree_id: created.id.clone(), repo_id: created.repo_id.clone(), unlocked_at_ms: now_ms() };
    insert(&inner.store, &unlock).map_err(internal)?;
    if let Some(w) = inner.worktrees.get_mut(&created.id) {
        if w.metadata.display_name.is_none() {
            w.metadata.display_name = Some(town.name.clone());
        }
        let w = w.clone();
        let row = Daemon::meta_row_of(inner, &w, w.metadata.clone());
        inner.store.meta_upsert(&row).map_err(internal)?;
    }
    Daemon::emit(inner, Event::TownUnlocked { unlock });
    let worktrees = Daemon::worktree_views(inner);
    Daemon::emit(inner, Event::WorktreesChanged { worktrees });
    Ok(())
}

/// The `worktree_rebound` seam. The unlock follows the worktree to its new id.
pub fn rebind(store: &Store, old: &str, new: &str) -> anyhow::Result<()> {
    store.conn().execute("UPDATE towns SET worktree_id = ?2 WHERE worktree_id = ?1", params![old, new])?;
    Ok(())
}

pub fn list(daemon: &Daemon) -> Result<Value, RpcError> {
    let unlocks = unlocks(&daemon.lock().store).map_err(internal)?;
    Ok(json!({ "towns": model::all(), "unlocks": unlocks }))
}

pub fn pick(daemon: &Daemon) -> Result<Value, RpcError> {
    let unlocked = unlocked_slugs(&daemon.lock().store)?;
    ok(model::pick(&unlocked).ok_or_else(|| err(ErrorCode::Conflict, "every town is unlocked"))?)
}

/// `pr` finds the pull request of the unlocking worktree from its id and its activity. The composition root supplies it.
pub fn history(daemon: &Daemon, slug: &str, pr: fn(&Inner, &str, &[ActivityEvent]) -> Option<TownPr>) -> Result<Value, RpcError> {
    let inner = daemon.lock();
    let unlock = unlocks(&inner.store)
        .map_err(internal)?
        .into_iter()
        .find(|u| u.slug == slug)
        .ok_or_else(|| err(ErrorCode::NotFound, format!("town {slug} is not unlocked")))?;
    let events = inner
        .store
        .activity_list(&ActivityQuery { limit: Some(1000), worktree_id: Some(unlock.worktree_id.clone()), ..Default::default() }, &[])
        .map_err(internal)?;
    let repo_name = inner.repos.iter().find(|r| r.id == unlock.repo_id).map(|r| r.name.clone());
    let worktree = inner.worktrees.get(&unlock.worktree_id).map(|w| model::WorktreeFacts {
        name: Daemon::worktree_view(&inner, w).name,
        branch: w.branch.clone(),
        head: w.head.clone(),
        exists: w.exists,
        archived_at_ms: w.archived_at_ms,
    });
    let pr = pr(&inner, &unlock.worktree_id, &events);
    ok(model::history(unlock, repo_name, worktree, &events, pr))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> Store {
        let s = Store::open_in_memory().unwrap();
        migrate(&s).unwrap();
        s
    }

    fn unlock_row(slug: &str, worktree_id: &str) -> TownUnlock {
        TownUnlock { slug: slug.into(), worktree_id: worktree_id.into(), repo_id: "r".into(), unlocked_at_ms: 1 }
    }

    fn spec(name_hint: Option<&str>) -> WorktreeCreate {
        WorktreeCreate {
            repo_id: "r".into(),
            branch: "b".into(),
            new_branch: true,
            start_ref: None,
            path: None,
            name_hint: name_hint.map(String::from),
            metadata: None,
        }
    }

    #[test]
    fn rebind_moves_the_unlock() {
        let s = store();
        insert(&s, &unlock_row("x", "w")).unwrap();
        rebind(&s, "w", "w2").unwrap();
        assert_eq!(unlocks(&s).unwrap()[0].worktree_id, "w2");
    }

    #[test]
    fn a_town_unlocks_only_once() {
        let s = store();
        insert(&s, &unlock_row("aogashima", "w1")).unwrap();
        insert(&s, &unlock_row("aogashima", "w2")).unwrap();
        assert_eq!(unlocks(&s).unwrap().iter().map(|u| (u.slug.as_str(), u.worktree_id.as_str())).collect::<Vec<_>>(), vec![("aogashima", "w1")]);
    }

    #[test]
    fn the_namer_refuses_a_taken_or_unknown_town_and_picks_a_free_one() {
        let s = store();
        insert(&s, &unlock_row("aogashima", "w1")).unwrap();
        assert_eq!(name_worktree(&s, &spec(Some("aogashima"))).unwrap_err().code, ErrorCode::BadRequest);
        assert_eq!(name_worktree(&s, &spec(Some("no-such-town"))).unwrap_err().code, ErrorCode::BadRequest);
        let picked = name_worktree(&s, &spec(None)).unwrap().unwrap();
        assert!(model::find(&picked).is_some() && picked != "aogashima");
    }
}
