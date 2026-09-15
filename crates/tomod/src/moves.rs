//! Tab reorder and pane moves. The tree edits are the pure functions in `layout.rs`;
//! this module applies them to daemon state and the store. The caller emits the events.

use crate::daemon::{err, new_id, Inner};
use crate::layout;
use crate::store::TabRow;
use tomo_proto::{DropPlace, ErrorCode, Id, LayoutNode, RpcError};

fn not_found(what: &str) -> RpcError {
    err(ErrorCode::NotFound, format!("{what} not found"))
}

fn stored(e: anyhow::Error) -> RpcError {
    err(ErrorCode::Internal, e.to_string())
}

fn put_tab(inner: &mut Inner, tab: TabRow) -> Result<(), RpcError> {
    if !layout::is_valid(&tab.layout) {
        return Err(err(ErrorCode::Internal, format!("move would leave tab {} with an invalid layout", tab.id)));
    }
    inner.store.tab_upsert(&tab).map_err(stored)?;
    inner.tabs.insert(tab.id.clone(), tab);
    Ok(())
}

fn set_pane_tab(inner: &mut Inner, pane_id: &str, tab_id: &str) -> Result<(), RpcError> {
    let pane = inner.panes.get_mut(pane_id).ok_or_else(|| not_found("pane"))?;
    pane.row.tab_id = tab_id.to_string();
    let row = pane.row.clone();
    inner.store.pane_upsert(&row).map_err(stored)
}

fn activate(inner: &mut Inner, worktree_id: &str, tab_id: &str, pane_id: &str) -> Result<(), RpcError> {
    let changed: Vec<TabRow> = inner
        .tabs
        .values()
        .filter(|t| t.worktree_id == worktree_id)
        .filter_map(|t| {
            let active = t.id == tab_id;
            let pane = if active { Some(pane_id.to_string()) } else { t.active_pane_id.clone() };
            (t.is_active != active || t.active_pane_id != pane).then(|| TabRow { is_active: active, active_pane_id: pane, ..t.clone() })
        })
        .collect();
    changed.into_iter().try_for_each(|t| put_tab(inner, t))
}

/// Moves a tab to `position` among its worktree's tabs and renumbers them 0..n.
/// Returns the worktree id.
pub fn move_tab(inner: &mut Inner, tab_id: &str, position: u32) -> Result<Id, RpcError> {
    let worktree_id = inner.tabs.get(tab_id).ok_or_else(|| not_found("tab"))?.worktree_id.clone();
    let mut siblings: Vec<(i64, Id)> = inner.tabs.values().filter(|t| t.worktree_id == worktree_id).map(|t| (t.position, t.id.clone())).collect();
    siblings.sort();
    let ids: Vec<Id> = siblings.into_iter().map(|(_, id)| id).collect();
    let changed: Vec<TabRow> = layout::reorder(&ids, tab_id, position as usize)
        .iter()
        .enumerate()
        .filter_map(|(i, id)| inner.tabs.get(id).filter(|t| t.position != i as i64).map(|t| TabRow { position: i as i64, ..t.clone() }))
        .collect();
    changed.into_iter().try_for_each(|t| put_tab(inner, t))?;
    Ok(worktree_id)
}

pub struct Moved {
    pub worktree_id: Id,
    /// Panes whose tab changed.
    pub panes: Vec<Id>,
}

fn active_after_leaving(tab: &TabRow, layout: &LayoutNode, leaving: &str, replacement: Option<&str>) -> Option<Id> {
    match tab.active_pane_id.as_deref() {
        Some(p) if p == leaving => replacement.map(str::to_string).or_else(|| layout::pane_ids(layout).first().cloned()),
        other => other.map(str::to_string),
    }
}

/// Moves `pane_id` beside `target_pane_id` (or to the `place` edge of tab `tab_id`).
/// `Center` on a pane swaps the two panes, also across tabs. A cross-tab move out of a
/// tab's last pane deletes that empty tab; no process stops. Moves never cross worktrees.
pub fn move_pane(inner: &mut Inner, pane_id: &str, target_pane_id: Option<&str>, tab_id: Option<&str>, place: DropPlace) -> Result<Moved, RpcError> {
    let row = &inner.panes.get(pane_id).ok_or_else(|| not_found("pane"))?.row;
    let (worktree_id, src_id) = (row.worktree_id.clone(), row.tab_id.clone());
    let dst_id = match (target_pane_id, tab_id) {
        (Some(t), _) => inner.panes.get(t).ok_or_else(|| not_found("target pane"))?.row.tab_id.clone(),
        (None, Some(t)) => t.to_string(),
        (None, None) => return Err(err(ErrorCode::BadRequest, "target_pane_id or tab_id required")),
    };
    let dst = inner.tabs.get(&dst_id).ok_or_else(|| not_found("tab"))?.clone();
    let src = inner.tabs.get(&src_id).ok_or_else(|| not_found("tab"))?.clone();
    if dst.worktree_id != worktree_id {
        return Err(err(ErrorCode::BadRequest, "cannot move a pane to another worktree"));
    }
    let split_id = new_id();
    let none = Moved { worktree_id: worktree_id.clone(), panes: vec![] };

    if src.id == dst.id {
        let next = match target_pane_id {
            Some(t) => layout::move_within(&src.layout, pane_id, t, place, &split_id),
            None => layout::move_to_edge(&src.layout, pane_id, place, &split_id),
        };
        let Some(layout) = next else { return Ok(none) };
        put_tab(inner, TabRow { layout, ..src })?;
        activate(inner, &worktree_id, &dst_id, pane_id)?;
        return Ok(none);
    }

    if let (Some(target), DropPlace::Center) = (target_pane_id, place) {
        let src_layout = layout::swap(&src.layout, pane_id, target);
        let dst_layout = layout::swap(&dst.layout, pane_id, target);
        let src_active = active_after_leaving(&src, &src_layout, pane_id, Some(target));
        put_tab(inner, TabRow { layout: src_layout, active_pane_id: src_active, ..src })?;
        put_tab(inner, TabRow { layout: dst_layout, ..dst })?;
        set_pane_tab(inner, pane_id, &dst_id)?;
        set_pane_tab(inner, target, &src_id)?;
        activate(inner, &worktree_id, &dst_id, pane_id)?;
        return Ok(Moved { worktree_id, panes: vec![pane_id.to_string(), target.to_string()] });
    }

    let max = inner.config.max_panes_per_tab as usize;
    if max > 0 && layout::leaf_count(&dst.layout) >= max {
        return Err(err(ErrorCode::Conflict, format!("tab already holds {max} panes (max_panes_per_tab)")));
    }
    let dst_layout = match target_pane_id {
        Some(t) => layout::insert(&dst.layout, t, place, pane_id, &split_id),
        None => layout::beside(&dst.layout, place, pane_id, &split_id),
    };
    put_tab(inner, TabRow { layout: dst_layout, ..dst })?;
    match layout::remove(&src.layout, pane_id) {
        Some(src_layout) => {
            let src_active = active_after_leaving(&src, &src_layout, pane_id, None);
            put_tab(inner, TabRow { layout: src_layout, active_pane_id: src_active, ..src })?;
        }
        None => {
            inner.tabs.remove(&src_id);
            inner.store.tab_delete(&src_id).map_err(stored)?;
        }
    }
    set_pane_tab(inner, pane_id, &dst_id)?;
    activate(inner, &worktree_id, &dst_id, pane_id)?;
    Ok(Moved { worktree_id, panes: vec![pane_id.to_string()] })
}
