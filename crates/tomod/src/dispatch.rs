//! Composition root: sends each addon `Call` to its addon, and every other `Call` to Core.

use crate::addons::{towns, usage};
use crate::daemon::{ok, Daemon};
use serde_json::Value;
use std::sync::Arc;
use tomo_proto::{Call, RpcError, Snapshot};

pub async fn handle(daemon: &Arc<Daemon>, client_id: u64, call: Call) -> Result<Value, RpcError> {
    match call {
        Call::Subscribe => ok(Snapshot {
            core: daemon.subscribe(client_id)?,
            usage: usage::snapshots(),
        }),
        Call::TownList => towns::list(daemon),
        Call::TownPick => towns::pick(daemon),
        Call::TownHistory { slug } => towns::history(daemon, &slug),
        Call::UsageGet { refresh } => usage::get(daemon, refresh).await,
        call => daemon.handle(client_id, call).await,
    }
}
