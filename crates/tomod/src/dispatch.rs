//! Composition root: sends each addon `Call` to its addon, and every other `Call` to Core.

use crate::addons::{actions, towns};
use crate::daemon::Daemon;
use serde_json::Value;
use std::sync::Arc;
use tomo_proto::{Call, RpcError};

pub async fn handle(daemon: &Arc<Daemon>, client_id: u64, call: Call) -> Result<Value, RpcError> {
    match call {
        Call::ActionList { worktree_id } => actions::list(daemon, worktree_id),
        Call::ActionRun { worktree_id, action_id } => actions::run(daemon, &worktree_id, &action_id),
        Call::ActionStop { worktree_id, action_id } => actions::stop(daemon, &worktree_id, &action_id),
        Call::ActionRestart { worktree_id, action_id } => actions::restart(daemon, &worktree_id, &action_id),
        Call::TownList => towns::list(daemon),
        Call::TownPick => towns::pick(daemon),
        Call::TownHistory { slug } => towns::history(daemon, &slug),
        call => daemon.handle(client_id, call).await,
    }
}
