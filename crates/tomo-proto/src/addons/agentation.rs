//! Agentation wire types.

use crate::ActivityKinds;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
pub enum AgentationActivity {
    #[serde(rename = "annotations_sent")]
    AnnotationsSent,
}

impl ActivityKinds for AgentationActivity {}
