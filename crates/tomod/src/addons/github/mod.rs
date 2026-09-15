//! GitHub: the pull request of a worktree's branch, read with the `gh` CLI. See docs/features/github.md.
//! No poller: `gh` runs only inside a `pr_status` call, and a young pull request comes from the cache.

mod model;

pub use model::KnownPr;

use crate::daemon::{err, ok, Daemon};
use serde_json::Value;
use std::collections::BTreeMap;
use std::path::Path;
use std::sync::{Mutex, MutexGuard};
use tomo_proto::*;

// One tomod process holds one daemon (the lock file in main.rs), so this process-wide map is the cache of that daemon.
// Take `Daemon::lock` before this lock, never while this lock is held.
static CACHE: Mutex<BTreeMap<Id, PrStatusResult>> = Mutex::new(BTreeMap::new());

fn cache() -> MutexGuard<'static, BTreeMap<Id, PrStatusResult>> {
    CACHE.lock().unwrap_or_else(|p| p.into_inner())
}

async fn gh_pr_view(worktree: &Path) -> std::io::Result<std::process::Output> {
    tokio::process::Command::new("gh")
        .args(["pr", "view", "--json", "number,title,url,state,isDraft,reviewDecision,mergeable,statusCheckRollup"])
        .current_dir(worktree)
        .env("GH_NO_UPDATE_NOTIFIER", "1")
        .env("NO_COLOR", "1")
        .output()
        .await
}

/// `pr_status`: the cached answer while it is fresh, else a new `gh pr view`. It records `pr_merged` and emits `pr_changed`.
pub async fn pr_status(daemon: &Daemon, worktree_id: Id) -> Result<Value, RpcError> {
    let path = daemon.lock().worktrees.get(&worktree_id).ok_or_else(|| err(ErrorCode::NotFound, "worktree not found"))?.path.clone();
    let cached = cache().get(&worktree_id).cloned();
    if model::fresh(cached.as_ref(), now_ms()) {
        return ok(cached);
    }
    let result = model::answer(gh_pr_view(&path).await);
    let mut inner = daemon.lock();
    let before = cache().insert(worktree_id.clone(), result.clone());
    let update = model::update(before.as_ref(), &result);
    if let Some(pr) = update.merged {
        Daemon::record(&mut inner, model::merged_event(&worktree_id, pr));
    }
    if update.changed {
        Daemon::emit(&mut inner, Event::PrChanged { worktree_id, pr: result.pr.clone() });
    }
    ok(result)
}

/// The pull request that this addon knows for a worktree: the cached one, or the newest `pr_merged` event in `events`.
pub fn known_pr(worktree_id: &str, events: &[ActivityEvent]) -> Option<KnownPr> {
    model::known_pr(cache().get(worktree_id), events)
}
