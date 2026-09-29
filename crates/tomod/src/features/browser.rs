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
use tomo_proto::{now_ms, EditorTarget, ErrorCode, HookPane, Id, PaneKind, PaneOrigin, RpcError, SplitDirection};

pub(crate) fn surface_row(tab_id: &str, worktree_id: &str, cwd: PathBuf, kind: PaneKind, url: Option<String>, editor: Option<EditorTarget>) -> PaneRow {
    PaneRow {
        id: new_id(),
        tab_id: tab_id.to_string(),
        worktree_id: worktree_id.to_string(),
        user_title: None,
        cwd,
        cols: 0,
        rows: 0,
        agent_kind: None,
        session_ref: None,
        created_at_ms: now_ms(),
        kind,
        url,
        editor,
        sleep: None,
        keep_awake: false,
    }
}

impl Daemon {
    pub(crate) fn create_browser_pane(inner: &mut Inner, tab_id: &str, worktree_id: &str, cwd: PathBuf, url: String) -> Result<Id> {
        Self::insert_surface_pane(inner, surface_row(tab_id, worktree_id, cwd, PaneKind::Browser, Some(url), None))
    }

    /// Stores a pane that has no PTY and announces it to the hooks. The caller places it in a layout.
    pub(crate) fn insert_surface_pane(inner: &mut Inner, row: PaneRow) -> Result<Id> {
        let id = row.id.clone();
        inner.store.pane_upsert(&row)?;
        let hook_pane = HookPane { id: row.id.clone(), tab_id: row.tab_id.clone(), cwd: row.cwd.clone() };
        let worktree_id = row.worktree_id.clone();
        inner.panes.insert(
            id.clone(),
            PaneState {
                row,
                pty: None,
                origin: PaneOrigin::Live,
                exit_code: None,
                process_title: None,
                process_cmd: None,
                stop_intent: false,
                hook_exit: None,
                pending_line: None,
                last_output_ms: 0,
                scrollback: Scrollback::default(),
                screen: None,
                source: None,
                sleep: Default::default(),
            },
        );
        let mut ev = events::envelope(inner, "pane.created", Some(&worktree_id));
        ev.pane = Some(hook_pane);
        inner.hook_queue.push(ev);
        Ok(id)
    }

    /// The tab for a new surface pane: `tab_id` when given, else a new tab named `title`.
    pub(crate) fn surface_tab(inner: &mut Inner, worktree_id: &str, tab_id: Option<Id>, title: &str) -> Result<Id, RpcError> {
        match tab_id {
            Some(t) if inner.tabs.contains_key(&t) => Ok(t),
            Some(_) => Err(err(ErrorCode::NotFound, "tab not found")),
            None => {
                let tab = Self::create_tab(inner, worktree_id, Some(title.to_string()));
                for t in inner.tabs.values().filter(|t| t.worktree_id == worktree_id && t.id != tab.id).cloned().collect::<Vec<_>>() {
                    let _ = inner.store.tab_upsert(&t);
                }
                Ok(tab.id)
            }
        }
    }

    pub(crate) fn browser_open(self: &Arc<Self>, worktree_id: Id, url: Option<String>, tab_id: Option<Id>) -> Result<Value, RpcError> {
        let mut inner = self.lock();
        let cwd = inner.worktrees.get(&worktree_id).ok_or_else(|| err(ErrorCode::NotFound, "worktree not found"))?.path.clone();
        let url = url.map(|u| u.trim().to_string()).filter(|u| !u.is_empty()).unwrap_or_else(|| "about:blank".to_string());
        let tab_id = Self::surface_tab(&mut inner, &worktree_id, tab_id, "Browser")?;
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
