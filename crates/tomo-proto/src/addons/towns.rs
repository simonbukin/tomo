//! Japan Towns wire types. `lib.rs` re-exports them, so the generated TypeScript names stay the same.

use crate::Id;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct Town {
    pub slug: String,
    pub name: String,
    pub ja: String,
    pub pref: String,
    pub kind: String,
    pub population: Option<u64>,
    pub lat: f64,
    pub lon: f64,
    pub wiki: String,
    pub rarity: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct TownUnlock {
    pub slug: String,
    pub worktree_id: Id,
    pub repo_id: Id,
    pub unlocked_at_ms: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum TownWorktreeStatus {
    Active,
    Archived,
    Missing,
    /// Tomo has no record of the worktree any more. The unlock stays.
    Gone,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct TownPr {
    pub number: u64,
    pub url: String,
    pub state: String,
}

/// What `town_history` returns. Every field comes from Tomo's own records, never from a guess.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct TownHistory {
    pub unlock: TownUnlock,
    pub repo_name: Option<String>,
    pub worktree_name: Option<String>,
    pub branch: Option<String>,
    pub status: TownWorktreeStatus,
    /// The head of an active worktree, or the last commit of an archived one.
    pub final_commit: Option<String>,
    pub archived_at_ms: Option<u64>,
    pub pr: Option<TownPr>,
}
