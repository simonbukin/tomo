//! A bounded stack of recently closed tabs, so that a close can be undone.
//!
//! The stack lives in daemon memory only. At close time the daemon knows the
//! cwd, the agent session, and the browser URL of every pane, so it records
//! them here. A reopen builds new panes from the record; it never reruns the
//! command that a pane source started.

use crate::daemon::{Daemon, Inner};
use crate::agents;
use crate::layout;
use crate::store::TabRow;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use tomo_proto::{AgentKind, AgentState, Id, LayoutNode, PaneKind, PaneOrigin};

pub const LIMIT: usize = 10;

#[derive(Debug, Clone, PartialEq)]
pub enum ClosedPane {
    /// A shell, or a pane that a source started: it comes back as a shell in its cwd with its title.
    Terminal { cwd: PathBuf, title: Option<String> },
    Agent { cwd: PathBuf, title: Option<String>, kind: AgentKind, session_ref: String },
    Browser { cwd: PathBuf, url: String },
}

#[derive(Debug, Clone, PartialEq)]
pub struct ClosedTab {
    pub worktree_id: Id,
    pub title: String,
    pub index: usize,
    pub layout: LayoutNode,
    pub active_pane_id: Option<Id>,
    pub panes: Vec<(Id, ClosedPane)>,
}

pub fn closed_pane(kind: PaneKind, cwd: PathBuf, title: Option<String>, url: Option<String>, agent: Option<(AgentKind, Option<String>)>) -> ClosedPane {
    match (kind, agent) {
        (PaneKind::Browser, _) => ClosedPane::Browser { cwd, url: url.unwrap_or_else(|| "about:blank".to_string()) },
        (PaneKind::Terminal, Some((kind, Some(session_ref)))) => ClosedPane::Agent { cwd, title, kind, session_ref },
        (PaneKind::Terminal, _) => ClosedPane::Terminal { cwd, title },
    }
}

/// Newest last; the oldest entries fall off past `LIMIT`.
pub fn push(stack: &[ClosedTab], tab: ClosedTab) -> Vec<ClosedTab> {
    let all: Vec<ClosedTab> = stack.iter().cloned().chain(std::iter::once(tab)).collect();
    all[all.len().saturating_sub(LIMIT)..].to_vec()
}

/// Removes the newest entry for `worktree_id`.
pub fn take_latest(stack: &[ClosedTab], worktree_id: &str) -> (Option<ClosedTab>, Vec<ClosedTab>) {
    match stack.iter().rposition(|t| t.worktree_id == worktree_id) {
        Some(i) => (Some(stack[i].clone()), stack.iter().enumerate().filter(|(j, _)| *j != i).map(|(_, t)| t.clone()).collect()),
        None => (None, stack.to_vec()),
    }
}

/// The layout with new pane ids. Leaves without a new id drop out; `None` when no leaf is left.
pub fn remap(node: &LayoutNode, ids: &HashMap<Id, Id>) -> Option<LayoutNode> {
    match node {
        LayoutNode::Leaf { pane_id } => ids.get(pane_id).map(|p| layout::leaf(p)),
        LayoutNode::Split { id, direction, ratio, first, second } => match (remap(first, ids), remap(second, ids)) {
            (Some(f), Some(s)) => Some(LayoutNode::Split { id: id.clone(), direction: *direction, ratio: *ratio, first: Box::new(f), second: Box::new(s) }),
            (one, other) => one.or(other),
        },
    }
}

/// Tab ids in their new order with `id` placed at `index`.
pub fn insert_at(order: &[Id], id: &str, index: usize) -> Vec<Id> {
    let rest: Vec<Id> = order.iter().filter(|t| *t != id).cloned().collect();
    let at = index.min(rest.len());
    rest[..at].iter().cloned().chain(std::iter::once(id.to_string())).chain(rest[at..].iter().cloned()).collect()
}

fn ordered_tabs(inner: &Inner, worktree_id: &str) -> Vec<TabRow> {
    let mut tabs: Vec<TabRow> = inner.tabs.values().filter(|t| t.worktree_id == worktree_id).cloned().collect();
    tabs.sort_by_key(|t| t.position);
    tabs
}

/// Records a tab before its panes go away.
pub fn remember(inner: &mut Inner, tab: &TabRow) {
    let panes = layout::pane_ids(&tab.layout)
        .into_iter()
        .filter_map(|id| {
            let p = inner.panes.get(&id)?;
            let agent = inner.agents.get(&id).filter(|a| a.state != AgentState::Exited).map(|a| (a.kind, a.session_ref.clone().or_else(|| p.row.session_ref.clone())));
            Some((id, closed_pane(p.row.kind, p.row.cwd.clone(), p.row.user_title.clone(), p.row.url.clone(), agent)))
        })
        .collect();
    let index = ordered_tabs(inner, &tab.worktree_id).iter().position(|t| t.id == tab.id).unwrap_or(0);
    let closed = ClosedTab { worktree_id: tab.worktree_id.clone(), title: tab.title.clone(), index, layout: tab.layout.clone(), active_pane_id: tab.active_pane_id.clone(), panes };
    inner.closed_tabs = push(&inner.closed_tabs, closed);
}

/// Records the tab of `pane_id` when that pane is its last one.
pub fn remember_if_last(inner: &mut Inner, pane_id: &str) {
    let tab = inner.panes.get(pane_id).and_then(|p| inner.tabs.get(&p.row.tab_id)).filter(|t| layout::pane_ids(&t.layout) == [pane_id]).cloned();
    if let Some(tab) = tab {
        remember(inner, &tab);
    }
}

impl Daemon {
    fn reopen_pane(self: &Arc<Self>, inner: &mut Inner, tab_id: &str, worktree_id: &str, pane: &ClosedPane) -> anyhow::Result<Id> {
        match pane {
            ClosedPane::Terminal { cwd, title } => self.create_pane(inner, tab_id, worktree_id, cwd.clone(), None, title.clone(), None, None, None, PaneOrigin::Live),
            ClosedPane::Browser { cwd, url } => Daemon::create_browser_pane(inner, tab_id, worktree_id, cwd.clone(), url.clone()),
            ClosedPane::Agent { cwd, title, kind, session_ref } => {
                let plan = crate::providers::launch(&inner.config, *kind, Some(session_ref), &self.paths.integrations_dir, &[]);
                let line = agents::shell_line(&plan.argv);
                self.create_pane(inner, tab_id, worktree_id, cwd.clone(), None, title.clone(), Some(*kind), plan.session_ref, Some(line), PaneOrigin::Live)
            }
        }
    }

    /// Builds the newest closed tab of `worktree_id` again and returns its id.
    pub(crate) fn reopen_tab(self: &Arc<Self>, inner: &mut Inner, worktree_id: &str) -> Result<Option<Id>, anyhow::Error> {
        let (closed, rest) = take_latest(&inner.closed_tabs, worktree_id);
        let Some(closed) = closed else { return Ok(None) };
        inner.closed_tabs = rest;
        let was_active = ordered_tabs(inner, worktree_id).into_iter().find(|t| t.is_active).map(|t| t.id);
        let tab = Daemon::create_tab(inner, worktree_id, Some(closed.title.clone()));
        let ids: HashMap<Id, Id> = closed.panes.iter().filter_map(|(old, pane)| self.reopen_pane(inner, &tab.id, worktree_id, pane).ok().map(|new| (old.clone(), new))).collect();
        let Some(layout) = remap(&closed.layout, &ids) else {
            inner.tabs.remove(&tab.id);
            if let Some(t) = was_active.and_then(|id| inner.tabs.get_mut(&id)) {
                t.is_active = true;
            }
            return Err(anyhow::anyhow!("no pane of the closed tab could start again"));
        };
        let active = closed.active_pane_id.as_ref().and_then(|p| ids.get(p)).cloned().or_else(|| layout::pane_ids(&layout).first().cloned());
        if let Some(t) = inner.tabs.get_mut(&tab.id) {
            t.layout = layout;
            t.active_pane_id = active;
        }
        let order: Vec<Id> = ordered_tabs(inner, worktree_id).into_iter().map(|t| t.id).collect();
        for (position, id) in insert_at(&order, &tab.id, closed.index).iter().enumerate() {
            if let Some(t) = inner.tabs.get_mut(id) {
                t.position = position as i64;
                let row = t.clone();
                let _ = inner.store.tab_upsert(&row);
            }
        }
        Daemon::touch(inner, worktree_id);
        Daemon::emit_tabs(inner, worktree_id);
        for id in ids.values() {
            Daemon::emit_pane(inner, id);
        }
        Ok(Some(tab.id))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tomo_proto::SplitDirection;

    fn tab(worktree_id: &str, title: &str) -> ClosedTab {
        ClosedTab { worktree_id: worktree_id.into(), title: title.into(), index: 0, layout: layout::leaf("p"), active_pane_id: None, panes: vec![] }
    }

    fn split(a: LayoutNode, b: LayoutNode) -> LayoutNode {
        LayoutNode::Split { id: "s".into(), direction: SplitDirection::Vertical, ratio: 0.3, first: Box::new(a), second: Box::new(b) }
    }

    #[test]
    fn stack_keeps_the_newest_ten() {
        let stack = (0..12).fold(Vec::new(), |s, i| push(&s, tab("w", &i.to_string())));
        assert_eq!(stack.len(), LIMIT);
        assert_eq!(stack.first().unwrap().title, "2");
        assert_eq!(stack.last().unwrap().title, "11");
    }

    #[test]
    fn take_latest_walks_back_per_worktree() {
        let stack = vec![tab("a", "a1"), tab("b", "b1"), tab("a", "a2")];
        let (first, stack) = take_latest(&stack, "a");
        assert_eq!(first.unwrap().title, "a2");
        let (second, stack) = take_latest(&stack, "a");
        assert_eq!(second.unwrap().title, "a1");
        let (none, stack) = take_latest(&stack, "a");
        assert!(none.is_none());
        assert_eq!(stack, vec![tab("b", "b1")]);
    }

    #[test]
    fn remap_keeps_ratios_and_drops_panes_that_did_not_start() {
        let old = split(layout::leaf("a"), split(layout::leaf("b"), layout::leaf("c")));
        let all: HashMap<Id, Id> = [("a", "x"), ("b", "y"), ("c", "z")].into_iter().map(|(k, v)| (k.into(), v.into())).collect();
        assert_eq!(remap(&old, &all), Some(split(layout::leaf("x"), split(layout::leaf("y"), layout::leaf("z")))));
        let some: HashMap<Id, Id> = [("a", "x"), ("c", "z")].into_iter().map(|(k, v)| (k.into(), v.into())).collect();
        assert_eq!(remap(&old, &some), Some(split(layout::leaf("x"), layout::leaf("z"))));
        assert_eq!(remap(&old, &HashMap::new()), None);
    }

    #[test]
    fn insert_at_clamps_to_the_end() {
        let order: Vec<Id> = ["a", "b", "n"].into_iter().map(String::from).collect();
        assert_eq!(insert_at(&order, "n", 1), ["a", "n", "b"]);
        assert_eq!(insert_at(&order, "n", 0), ["n", "a", "b"]);
        assert_eq!(insert_at(&order, "n", 9), ["a", "b", "n"]);
    }

    #[test]
    fn panes_come_back_by_kind_and_actions_never_rerun() {
        let cwd = PathBuf::from("/w");
        assert_eq!(closed_pane(PaneKind::Browser, cwd.clone(), None, Some("http://localhost:3000".into()), None), ClosedPane::Browser { cwd: cwd.clone(), url: "http://localhost:3000".into() });
        assert_eq!(
            closed_pane(PaneKind::Terminal, cwd.clone(), None, None, Some((AgentKind::Claude, Some("s1".into())))),
            ClosedPane::Agent { cwd: cwd.clone(), title: None, kind: AgentKind::Claude, session_ref: "s1".into() }
        );
        assert_eq!(closed_pane(PaneKind::Terminal, cwd.clone(), None, None, Some((AgentKind::Codex, None))), ClosedPane::Terminal { cwd: cwd.clone(), title: None });
        assert_eq!(closed_pane(PaneKind::Terminal, cwd.clone(), Some("App".into()), None, None), ClosedPane::Terminal { cwd, title: Some("App".into()) });
    }
}
