//! Wire types of the anime chart addon: one archived worktree and the moment that Tomo archived it.

use crate::Id;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct ArchivedShow {
    pub worktree_id: Id,
    pub name: String,
    pub archived_at_ms: u64,
}
