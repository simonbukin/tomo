//! Linear wire types: the issues that each worktree's branches and commits name. `lib.rs` re-exports them, so the generated TypeScript names stay the same.

use crate::Id;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct LinearState {
    pub name: String,
    /// One of `triage`, `backlog`, `unstarted`, `started`, `completed`, `canceled`.
    pub kind: String,
    /// The hex colour that the team gave this state in Linear.
    pub color: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct LinearIssue {
    pub identifier: String,
    pub title: String,
    pub url: String,
    pub state: LinearState,
    pub assignee: Option<String>,
    pub priority: String,
    /// When the issue last changed in Linear. 0 when Linear gave no time.
    #[serde(default)]
    pub updated_at_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct LinearLink {
    pub worktree_id: Id,
    pub issue: LinearIssue,
    /// The last time that the worktree touched the branch or made the commit that names the issue.
    #[serde(default)]
    pub touched_ms: u64,
    /// The branch that the worktree has now names the issue.
    #[serde(default)]
    pub current: bool,
    /// Where the worktree names the issue, such as `branch you/eng-31-retry`.
    #[serde(default)]
    pub why: String,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
pub struct LinearStatus {
    pub available: bool,
    pub reason: Option<String>,
    pub links: Vec<LinearLink>,
    pub fetched_at_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct LinearViewer {
    pub name: String,
}
