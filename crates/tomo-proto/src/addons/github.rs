//! GitHub wire types.

use crate::ActivityKinds;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
pub enum GitHubActivity {
    #[serde(rename = "pr_merged")]
    PrMerged,
}

impl ActivityKinds for GitHubActivity {}
