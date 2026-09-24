//! GitHub wire types. `lib.rs` re-exports them, so the generated TypeScript names stay the same.

use crate::ActivityKinds;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct PullRequest {
    pub number: u64,
    pub title: String,
    pub url: String,
    pub state: String,
    pub draft: bool,
    pub review_decision: Option<String>,
    pub mergeable: Option<String>,
    pub checks_passed: u32,
    pub checks_failed: u32,
    pub checks_pending: u32,
    pub fetched_at_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct PrStatusResult {
    pub available: bool,
    pub reason: Option<String>,
    pub pr: Option<PullRequest>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
pub enum GitHubActivity {
    #[serde(rename = "pr_merged")]
    PrMerged,
}

impl ActivityKinds for GitHubActivity {}
