//! GitHub: the pull requests of a worktree's branches, read with the `gh` CLI. See docs/features/github.md.
//! No poller: `gh` runs only inside a `pr_status` call, and a young pull request comes from the cache.
//! The branches are the one that the worktree has now and the ones that its reflog shows from the last 30 days.
//! A pull request that becomes merged fires the `github.pr_merged` hook. The addon writes no tags.

mod model;

pub use model::KnownPr;

use crate::addons;
use crate::daemon::{err, ok, Daemon, Inner};
use crate::events;
use crate::store::Store;
use crate::trail;
use serde_json::Value;
use std::collections::BTreeMap;
use std::path::Path;
use std::sync::Arc;
use tomo_proto::*;

/// The last `pr_status` answer of each worktree, in `addons::State`.
pub type Cache = BTreeMap<Id, PrStatusResult>;

pub const HOOK_EVENTS: &[&str] = &["github.pr_merged"];

const OLD_TAGS_REMOVED: &str = "github.old_pr_tags_removed";

/// Removes the pull request tags that older versions wrote, one time. A tag that a person sets later stays.
pub fn migrate(store: &Store) -> anyhow::Result<()> {
    if store.kv_get(OLD_TAGS_REMOVED)?.is_some() {
        return Ok(());
    }
    for mut row in store.meta_all()? {
        let tags = model::without_old_pr_tags(&row.metadata.tags);
        if tags != row.metadata.tags {
            row.metadata.tags = tags;
            store.meta_upsert(&row)?;
        }
    }
    store.kv_set(OLD_TAGS_REMOVED, "1")
}

async fn gh(worktree: &Path, args: &[&str]) -> std::io::Result<std::process::Output> {
    tokio::process::Command::new("gh").args(args).current_dir(worktree).env("GH_NO_UPDATE_NOTIFIER", "1").env("NO_COLOR", "1").output().await
}

/// The newest pull request of each earlier branch, asked in parallel.
async fn earlier_prs(worktree: &Path, branches: Vec<String>, own: Option<String>) -> Vec<PullRequest> {
    let mut asks = tokio::task::JoinSet::new();
    for branch in branches {
        let (worktree, own) = (worktree.to_path_buf(), own.clone());
        asks.spawn(async move { model::listed(gh(&worktree, &["pr", "list", "--head", &branch, "--state", "all", "--limit", "5", "--json", model::PR_FIELDS]).await, own.as_deref()) });
    }
    asks.join_all().await.into_iter().flatten().collect()
}

fn old_tag_hooks(inner: &mut Inner) {
    let problem = model::old_tag_problem(&inner.config.hooks);
    Daemon::diagnostic_on_change(inner, "github", "hooks on pull request tags", problem);
}

/// `pr_status`: the cached answer while it is fresh, else a new `gh pr view`. It records `pr_merged` and emits `pr_changed`.
pub async fn pr_status(daemon: &Arc<Daemon>, worktree_id: Id) -> Result<Value, RpcError> {
    let (path, own, cached) = {
        let inner = daemon.lock();
        let w = inner.worktrees.get(&worktree_id).ok_or_else(|| err(ErrorCode::NotFound, "worktree not found"))?;
        let own = inner.repos.iter().find(|r| r.id == w.repo_id).and_then(|r| r.remote_url.as_deref()).and_then(model::remote_owner);
        (w.path.clone(), own, addons::state(&inner).github.get(&worktree_id).cloned())
    };
    if model::fresh(cached.as_ref(), now_ms()) {
        return ok(cached);
    }
    let (branch, trail) = trail::worktree_trail(&path, now_ms());
    let current = model::answer(gh(&path, &["pr", "view", "--json", model::PR_FIELDS]).await);
    let earlier: Vec<String> = trail.iter().map(|t| t.branch.clone()).filter(|b| Some(b) != branch.as_ref()).collect();
    let earlier = if current.available { earlier_prs(&path, earlier, own).await } else { vec![] };
    let result = model::with_history(current, earlier, &trail);
    {
        let mut inner = daemon.lock();
        remember(&mut inner, worktree_id, result.clone());
        old_tag_hooks(&mut inner);
    }
    daemon.flush_hooks();
    ok(result)
}

/// Keeps a new answer under the Core lock. A newly merged pull request records `pr_merged` and fires `github.pr_merged`.
pub fn remember(inner: &mut Inner, worktree_id: Id, result: PrStatusResult) {
    let before = addons::state_mut(inner).github.insert(worktree_id.clone(), result.clone());
    let update = model::update(before.as_ref(), &result);
    if let Some(pr) = update.merged {
        Daemon::record(inner, model::merged_event(&worktree_id, pr));
        let hook = HookEvent { addons: model::hook_fields(pr), ..events::envelope(inner, "github.pr_merged", Some(&worktree_id)) };
        inner.hook_queue.push(hook);
    }
    if update.changed {
        Daemon::emit(inner, Event::PrChanged { worktree_id, pr: result.pr, prs: result.prs });
    }
}

/// The pull request that this addon knows for a worktree: the cached one, or the newest `pr_merged` event in `events`.
pub fn known_pr(inner: &Inner, worktree_id: &str, events: &[ActivityEvent]) -> Option<KnownPr> {
    model::known_pr(addons::state(inner).github.get(worktree_id), events)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tags(store: &Store) -> Vec<String> {
        store.meta_one("w").unwrap().unwrap().metadata.tags
    }

    #[test]
    fn migrate_removes_the_old_pull_request_tags_one_time() {
        let store = Store::open_in_memory().unwrap();
        store.conn().execute("INSERT INTO worktree_meta (id, repo_id, path, tags) VALUES ('w', 'r', '/tmp/w', '[\"sync\",\"review\"]')", []).unwrap();
        migrate(&store).unwrap();
        assert_eq!(tags(&store), vec!["sync"]);
        store.conn().execute("UPDATE worktree_meta SET tags = '[\"sync\",\"review\"]' WHERE id = 'w'", []).unwrap();
        migrate(&store).unwrap();
        assert_eq!(tags(&store), vec!["sync", "review"], "a tag that a person sets after the migration stays");
    }
}
