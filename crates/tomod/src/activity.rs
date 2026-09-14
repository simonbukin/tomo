//! One chronological stream of meaningful events, kept in the `activity` table.

use crate::daemon::{Daemon, Inner};
use tomo_proto::{ActivityEvent, Event};

pub fn record(inner: &mut Inner, event: ActivityEvent) {
    if let Err(e) = inner.store.activity_insert(&event) {
        tracing::warn!("activity insert: {e}");
    }
    Daemon::emit(inner, Event::ActivityAdded { event });
}
