//! Agentation wire types: the evidence bundle that `annotations_send` types into an agent pane, and the activity kind it records.

use crate::{ActivityKinds, Id};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
pub enum AgentationActivity {
    #[serde(rename = "annotations_sent")]
    AnnotationsSent,
}

impl ActivityKinds for AgentationActivity {}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct Annotation {
    pub text: String,
    pub url: String,
    pub selector: Option<String>,
    pub element_text: Option<String>,
    /// x, y, width, height in CSS pixels.
    pub rect: Option<[f64; 4]>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct EvidenceBundle {
    pub source: String,
    pub worktree_id: Id,
    pub url: Option<String>,
    pub action_id: Option<String>,
    pub annotations: Vec<Annotation>,
    pub instruction: String,
    #[serde(default)]
    #[ts(optional)]
    pub markdown: Option<String>,
    #[serde(default)]
    #[ts(optional)]
    pub note_count: Option<u32>,
}
