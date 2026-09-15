//! Provider usage wire types: allowance for each provider, never for each worktree. `lib.rs` re-exports them, so the generated TypeScript names stay the same.

use crate::AgentKind;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct UsageBucket {
    pub label: String,
    pub fraction_used: Option<f64>,
    pub resets_at_ms: Option<u64>,
    pub detail: Option<String>,
    /// The model this bucket limits, such as `fable`. None for the whole plan.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub scope: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct UsageSnapshot {
    pub provider: AgentKind,
    pub available: bool,
    pub reason: Option<String>,
    pub buckets: Vec<UsageBucket>,
    pub fetched_at_ms: u64,
}
