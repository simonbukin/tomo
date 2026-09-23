//! Activity: one chronological stream of meaningful events. This is a Core module.
//!
//! Core records the kinds in [`CoreActivity`]. Each addon defines its own kinds as an enum in
//! `addons/<name>.rs` and implements [`ActivityKinds`] for it. This module never names an addon kind.

use crate::{AgentKind, Id};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use ts_rs::TS;

/// The kind of an activity event, spelled as on the wire and in the `activity.kind` column.
/// A kind that this build does not know keeps its string, so a row of an omitted or newer addon reads back unchanged.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
pub struct ActivityKind(pub String);

impl ActivityKind {
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// A closed set of activity kinds that one owner defines. Implement it only for an enum of unit variants.
///
/// A new addon kind serializes to `<addon>.<name>`. The addon kinds that existed before this rule keep
/// their snake_case strings, because stored rows and installed clients decode them.
pub trait ActivityKinds: Serialize {}

impl<K: ActivityKinds> From<K> for ActivityKind {
    fn from(kind: K) -> Self {
        match serde_json::to_value(kind) {
            Ok(Value::String(s)) => Self(s),
            other => unreachable!("an activity kind must serialize to a string: {other:?}"),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum CoreActivity {
    AgentStarted,
    AgentWaiting,
    AgentExited,
    CheckpointCreated,
    CheckpointResolved,
    /// Stored by builds before tags replaced workflow states. Nothing records it now.
    StateChanged,
    TagsChanged,
    Archived,
    Restored,
    HookFailed,
}

impl ActivityKinds for CoreActivity {}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct ActivityEvent {
    pub id: Id,
    pub kind: ActivityKind,
    pub occurred_at_ms: u64,
    pub worktree_id: Option<Id>,
    pub pane_id: Option<Id>,
    pub agent_kind: Option<AgentKind>,
    pub title: String,
    pub detail: Option<String>,
    #[ts(type = "unknown")]
    pub payload: Value,
    /// The attention item this event opened or resolved, if any.
    pub attention_id: Option<Id>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, TS)]
pub struct ActivityQuery {
    #[serde(default)]
    pub limit: Option<usize>,
    #[serde(default)]
    pub before_ms: Option<u64>,
    #[serde(default)]
    pub worktree_id: Option<Id>,
    /// Only events whose attention item still needs a person. See `needs_me` in `tomod`.
    #[serde(default)]
    pub needs_me: bool,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_kind_is_a_plain_string_on_the_wire() {
        assert_eq!(ActivityKind::from(CoreActivity::HookFailed).as_str(), "hook_failed");
        assert_eq!(ActivityKind::from(CoreActivity::CheckpointResolved).as_str(), "checkpoint_resolved");
        let unknown: ActivityKind = serde_json::from_str("\"future.thing\"").unwrap();
        assert_eq!((unknown.as_str(), serde_json::to_string(&unknown).unwrap()), ("future.thing", "\"future.thing\"".to_string()));
    }
}
