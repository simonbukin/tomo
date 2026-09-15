//! Activity: one chronological stream of meaningful events.
//!
//! Activity is history. Attention is urgency. An activity event may point at
//! the attention item it opened or closed, which is how `needs_me` works.
//! This module records any `ActivityKind`; the owner of a kind builds it from its own enum.

use crate::daemon::{new_id, Daemon, Inner};
use serde_json::Value;
use tomo_proto::*;

pub const KEEP: usize = 10_000;
pub const WAITING_REPEAT_MS: u64 = 30_000;

pub fn event(kind: impl Into<ActivityKind>, worktree_id: Option<&str>, title: impl Into<String>) -> ActivityEvent {
    ActivityEvent {
        id: new_id(),
        kind: kind.into(),
        occurred_at_ms: now_ms(),
        worktree_id: worktree_id.map(str::to_string),
        pane_id: None,
        agent_kind: None,
        title: title.into(),
        detail: None,
        payload: Value::Null,
        attention_id: None,
    }
}

impl Daemon {
    pub fn record(inner: &mut Inner, event: ActivityEvent) {
        if let Err(e) = inner.store.activity_insert(&event) {
            tracing::warn!("activity insert: {e}");
            return;
        }
        let _ = inner.store.activity_trim(KEEP);
        Self::emit(inner, Event::ActivityAdded { event });
    }

    pub fn recorded_recently(inner: &Inner, kind: impl Into<ActivityKind>, within_ms: u64, matches: impl Fn(&ActivityEvent) -> bool) -> bool {
        inner.store.activity_since(kind, now_ms().saturating_sub(within_ms)).unwrap_or_default().iter().any(matches)
    }
}
