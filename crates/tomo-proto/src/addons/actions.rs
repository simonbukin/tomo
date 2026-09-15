//! Actions wire types.

use crate::ActivityKinds;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
pub enum ActionActivity {
    #[serde(rename = "action_started")]
    Started,
    #[serde(rename = "action_stopped")]
    Stopped,
    #[serde(rename = "action_completed")]
    Completed,
    #[serde(rename = "action_crashed")]
    Crashed,
}

impl ActivityKinds for ActionActivity {}
