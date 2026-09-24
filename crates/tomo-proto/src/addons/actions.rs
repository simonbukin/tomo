//! Actions wire types.

use crate::{ActivityKinds, Id, Pane};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum ActionMode {
    #[default]
    Pane,
    External,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum ActionShow {
    Topbar,
    #[default]
    Menu,
}

/// One entry of `[[actions]]` in a `.tomo.toml`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct ActionDef {
    pub id: String,
    pub label: String,
    pub command: String,
    pub mode: ActionMode,
    pub show: ActionShow,
    pub shortcut: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct ActionSet {
    pub worktree_id: Id,
    pub actions: Vec<ActionDef>,
    pub error: Option<String>,
    /// True when the set comes from the repository file, because the worktree has none.
    #[serde(default)]
    pub from_repo: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct ActionRunResult {
    pub action: ActionDef,
    pub pane: Option<Pane>,
    pub reused: bool,
}

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

/// The `PaneSource.kind` of a pane that an Action started.
pub const ACTION_SOURCE_KIND: &str = "action";

impl crate::PaneSource {
    /// The Action id of a pane source, when an Action started the pane.
    pub fn action_id(source: Option<&crate::PaneSource>) -> Option<String> {
        source.filter(|s| s.kind == ACTION_SOURCE_KIND).map(|s| s.id.clone())
    }
}

/// The `action` field that the Actions and Runtime addons put on a hook event.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct HookAction {
    pub id: String,
    pub label: String,
}

impl HookAction {
    /// The event fields for `HookEvent.addons`: this Action under the `action` key.
    pub fn fields(&self) -> serde_json::Map<String, serde_json::Value> {
        serde_json::Map::from_iter([("action".to_string(), serde_json::json!(self))])
    }

    /// The Action on a hook event, when an Action or Runtime event put one there.
    pub fn of(event: &crate::HookEvent) -> Option<HookAction> {
        event.addons.get("action").and_then(|v| serde_json::from_value(v.clone()).ok())
    }
}
