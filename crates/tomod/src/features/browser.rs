//! Browser panes: a built-in pane kind with a URL and no PTY.
//!
//! Core keeps the kind itself (`PaneKind::Browser`), because restore, reopen,
//! and the terminal-only guard must know that a pane has no PTY. This module
//! owns the calls that make and change a browser pane. The GUI owns the page.

use crate::daemon::{err, internal, new_id, ok, Daemon, Inner, PaneState};
use crate::events;
use crate::pty::Scrollback;
use crate::store::PaneRow;
use anyhow::Result;
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::Arc;
use tomo_proto::{now_ms, ErrorCode, HookPane, Id, PaneKind, PaneOrigin, RpcError, SplitDirection};

impl Daemon {
    pub(crate) fn create_browser_pane(inner: &mut Inner, tab_id: &str, worktree_id: &str, cwd: PathBuf, url: String) -> Result<Id> {
        let id = new_id();
        let row = PaneRow {
            id: id.clone(),
            tab_id: tab_id.to_string(),
            worktree_id: worktree_id.to_string(),
            user_title: None,
            cwd,
            cols: 0,
            rows: 0,
            agent_kind: None,
            session_ref: None,
            created_at_ms: now_ms(),
            kind: PaneKind::Browser,
            url: Some(url),
        };
        inner.store.pane_upsert(&row)?;
        let hook_pane = HookPane { id: row.id.clone(), tab_id: row.tab_id.clone(), cwd: row.cwd.clone() };
        inner.panes.insert(
            id.clone(),
            PaneState { row, pty: None, origin: PaneOrigin::Live, exit_code: None, process_title: None, process_cmd: None, stop_intent: false, pending_line: None, last_output_ms: 0, scrollback: Scrollback::default(), source: None },
        );
        let mut ev = events::envelope(inner, "pane.created", Some(worktree_id));
        ev.pane = Some(hook_pane);
        inner.hook_queue.push(ev);
        Ok(id)
    }

    pub(crate) fn browser_open(self: &Arc<Self>, worktree_id: Id, url: Option<String>, tab_id: Option<Id>) -> Result<Value, RpcError> {
        let mut inner = self.lock();
        let cwd = inner.worktrees.get(&worktree_id).ok_or_else(|| err(ErrorCode::NotFound, "worktree not found"))?.path.clone();
        let url = url.map(|u| u.trim().to_string()).filter(|u| !u.is_empty()).unwrap_or_else(|| "about:blank".to_string());
        let tab_id = match tab_id {
            Some(t) if inner.tabs.contains_key(&t) => t,
            Some(_) => return Err(err(ErrorCode::NotFound, "tab not found")),
            None => {
                let tab = Self::create_tab(&mut inner, &worktree_id, Some("Browser".to_string()));
                for t in inner.tabs.values().filter(|t| t.worktree_id == worktree_id && t.id != tab.id).cloned().collect::<Vec<_>>() {
                    let _ = inner.store.tab_upsert(&t);
                }
                tab.id
            }
        };
        let pane_id = Self::create_browser_pane(&mut inner, &tab_id, &worktree_id, cwd, url).map_err(internal)?;
        Self::place_pane(&mut inner, &tab_id, &pane_id, None, SplitDirection::Horizontal);
        Self::touch(&mut inner, &worktree_id);
        Self::emit_tabs(&mut inner, &worktree_id);
        Self::emit_pane(&mut inner, &pane_id);
        ok(json!({ "pane": Self::pane_view(&inner, &pane_id), "tab": Self::tab_view(&inner, &inner.tabs[&tab_id]) }))
    }

    pub(crate) fn browser_navigate(self: &Arc<Self>, pane_id: Id, url: String) -> Result<Value, RpcError> {
        let mut inner = self.lock();
        let pane = inner.panes.get_mut(&pane_id).ok_or_else(|| err(ErrorCode::NotFound, "pane not found"))?;
        if pane.row.kind != PaneKind::Browser {
            return Err(err(ErrorCode::BadRequest, "pane is not a browser"));
        }
        pane.row.url = Some(url);
        let row = pane.row.clone();
        inner.store.pane_upsert(&row).map_err(internal)?;
        Self::emit_pane(&mut inner, &pane_id);
        ok(Self::pane_view(&inner, &pane_id))
    }
}
