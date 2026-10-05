//! Composition root: sends each addon `Call` to its addon, and every other `Call` to Core.

use crate::addons::{actions, github, runtime};
use crate::daemon::{ok, Daemon};
use serde_json::Value;
use std::sync::Arc;
use tomo_proto::{Call, RpcError, Snapshot};

/// Addon calls that wait on a subprocess. `server.rs` runs them in their own task, as it does for slow Core calls.
pub fn is_slow(call: &Call) -> bool {
    matches!(call, Call::PrStatus { .. } | Call::RuntimeList { .. })
}

pub async fn handle(daemon: &Arc<Daemon>, client_id: u64, call: Call) -> Result<Value, RpcError> {
    match call {
        Call::Subscribe => {
            let core = daemon.subscribe(client_id)?;
            let inner = daemon.lock();
            let snapshot = Snapshot { core, actions: actions::snapshot(&inner), endpoints: runtime::snapshot(&inner) };
            drop(inner);
            ok(snapshot)
        }
        Call::RuntimeList { worktree_id } => runtime::list(daemon, worktree_id).await,
        Call::ActionList { worktree_id } => actions::list(daemon, worktree_id),
        Call::ActionRun { worktree_id, action_id } => actions::run(daemon, &worktree_id, &action_id),
        Call::ActionStop { worktree_id, action_id } => actions::stop(daemon, &worktree_id, &action_id),
        Call::ActionRestart { worktree_id, action_id } => actions::restart(daemon, &worktree_id, &action_id),
        Call::PrStatus { worktree_id } => github::pr_status(daemon, worktree_id).await,
        call => daemon.handle(client_id, call).await,
    }
}
