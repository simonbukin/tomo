//! Composition root: sends each addon `Call` to its addon, and every other `Call` to Core. The base ships no addons.

use crate::daemon::Daemon;
use serde_json::Value;
use std::sync::Arc;
use tomo_proto::{Call, RpcError, Snapshot};
use crate::daemon::ok;

/// Addon calls that wait on a subprocess. `server.rs` runs them in their own task, as it does for slow Core calls.
pub fn is_slow(_call: &Call) -> bool {
    false
}

pub async fn handle(daemon: &Arc<Daemon>, client_id: u64, call: Call) -> Result<Value, RpcError> {
    match call {
        Call::Subscribe => ok(Snapshot { core: daemon.subscribe(client_id)? }),
        call => daemon.handle(client_id, call).await,
    }
}
