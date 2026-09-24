//! Runtime endpoint discovery wire types: observed listening sockets owned by pane process trees.

use crate::{ActivityKinds, Id, PaneSource};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum RuntimeProtocol {
    Http,
    Https,
    Tcp,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct RuntimeEndpoint {
    pub id: Id,
    pub worktree_id: Id,
    pub pane_id: Option<Id>,
    /// `PaneSource::action_id` of the pane source, for installed clients that read it.
    pub action_id: Option<String>,
    pub pid: u32,
    pub process: String,
    pub protocol: RuntimeProtocol,
    pub host: String,
    pub port: u16,
    pub label: Option<String>,
    pub discovered_at_ms: u64,
    /// The source of the pane when the endpoint was found. A client finds the endpoints of one source by it.
    #[serde(default)]
    pub source: Option<PaneSource>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
pub enum RuntimeActivity {
    #[serde(rename = "endpoint_discovered")]
    EndpointDiscovered,
}

impl ActivityKinds for RuntimeActivity {}
