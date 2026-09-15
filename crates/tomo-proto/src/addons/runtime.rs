//! Runtime endpoint discovery wire types.

use crate::ActivityKinds;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
pub enum RuntimeActivity {
    #[serde(rename = "endpoint_discovered")]
    EndpointDiscovered,
}

impl ActivityKinds for RuntimeActivity {}
