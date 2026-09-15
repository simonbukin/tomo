//! Composition root: sends each addon `Call` to its addon, and every other `Call` to Core.

use crate::addons::{github, towns, usage};
use crate::daemon::{ok, Daemon};
use serde_json::Value;
use std::sync::Arc;
use tomo_proto::{ActivityEvent, Call, RpcError, Snapshot, TownPr};

/// Addon calls that wait on a subprocess. `server.rs` runs them in their own task, as it does for slow Core calls.
pub fn is_slow(call: &Call) -> bool {
    matches!(call, Call::PrStatus { .. })
}

pub async fn handle(daemon: &Arc<Daemon>, client_id: u64, call: Call) -> Result<Value, RpcError> {
    match call {
        Call::Subscribe => ok(Snapshot {
            core: daemon.subscribe(client_id)?,
            usage: usage::snapshots(),
        }),
        Call::TownList => towns::list(daemon),
        Call::TownPick => towns::pick(daemon),
        Call::TownHistory { slug } => towns::history(daemon, &slug, town_pr),
        Call::PrStatus { worktree_id } => github::pr_status(daemon, worktree_id).await,
        Call::UsageGet { refresh } => usage::get(daemon, refresh).await,
        call => daemon.handle(client_id, call).await,
    }
}

/// The pull request in a town history comes from GitHub. Without the GitHub addon, Towns gets `|_, _| None`.
fn town_pr(worktree_id: &str, events: &[ActivityEvent]) -> Option<TownPr> {
    github::known_pr(worktree_id, events).map(|pr| TownPr { number: pr.number, url: pr.url, state: pr.state })
}
