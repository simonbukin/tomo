//! GitHub: the pull request of a worktree's branch, read with the `gh` CLI. See docs/features/github.md.
//! No poller: `gh` runs only inside a `pr_status` call, and a young pull request comes from the cache.
//! Each answer with a pull request sets one of the GitHub tags in `model::PR_TAGS` on the worktree.

mod model;

pub use model::KnownPr;

use crate::addons;
use crate::daemon::{err, ok, Daemon, Inner};
use serde_json::Value;
use std::collections::BTreeMap;
use std::path::Path;
use tomo_proto::*;

/// The last `pr_status` answer of each worktree, in `addons::State`.
pub type Cache = BTreeMap<Id, PrStatusResult>;

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
    let (path, cached) = {
        let inner = daemon.lock();
        let path = inner.worktrees.get(&worktree_id).ok_or_else(|| err(ErrorCode::NotFound, "worktree not found"))?.path.clone();
        (path, addons::state(&inner).github.get(&worktree_id).cloned())
    };
    if model::fresh(cached.as_ref(), now_ms()) {
        return ok(cached);
    }
    let result = model::answer(gh_pr_view(&path).await);
    remember(&mut daemon.lock(), worktree_id, result.clone());
    ok(result)
}

/// Keeps a new answer under the Core lock. It records `pr_merged` and emits `pr_changed`.
pub fn remember(inner: &mut Inner, worktree_id: Id, result: PrStatusResult) {
    let before = addons::state_mut(inner).github.insert(worktree_id.clone(), result.clone());
    let update = model::update(before.as_ref(), &result);
    if let Some(pr) = update.merged {
        Daemon::record(inner, model::merged_event(&worktree_id, pr));
    }
    if let Some((pr, w)) = result.pr.as_ref().zip(inner.worktrees.get(&worktree_id)) {
        let tags = model::with_pr_tag(&w.metadata.tags, pr);
        if tags != w.metadata.tags {
            let next = WorktreeMetadata { tags, ..w.metadata.clone() };
            if let Err(e) = Daemon::write_metadata(inner, &worktree_id, next) {
                tracing::warn!("github tag for {worktree_id}: {}", e.message);
            }
        }
    }
    if update.changed {
        Daemon::emit(inner, Event::PrChanged { worktree_id, pr: result.pr });
    }
}

/// The pull request that this addon knows for a worktree: the cached one, or the newest `pr_merged` event in `events`.
pub fn known_pr(inner: &Inner, worktree_id: &str, events: &[ActivityEvent]) -> Option<KnownPr> {
    model::known_pr(addons::state(inner).github.get(worktree_id), events)
}
