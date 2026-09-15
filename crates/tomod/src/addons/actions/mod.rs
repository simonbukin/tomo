//! Actions: named commands from `[[actions]]` in a worktree's `.tomo.toml`, run in a pane or as an external program.
//! Nothing runs by itself; every run is an explicit call. The addon keeps no table. See docs/actions.md.

mod model;
#[cfg(test)]
mod tests;

use crate::activity;
use crate::daemon::{err, new_id, ok, Daemon, Inner, PaneExit, WorktreeFile};
use crate::events;
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashSet};
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::{Arc, Mutex, MutexGuard};
use tomo_proto::*;

pub const FILE: WorktreeFile = WorktreeFile { name: model::FILE_NAME, reload };

// The parsed sets stay out of Core `Inner`. One daemon runs per process (tomod.lock), so one map is enough.
// Lock order: the Core state lock first, then this one. Never lock Core state while holding it.
static SETS: Mutex<BTreeMap<Id, ActionSet>> = Mutex::new(BTreeMap::new());

fn sets() -> MutexGuard<'static, BTreeMap<Id, ActionSet>> {
    SETS.lock().unwrap_or_else(|p| p.into_inner())
}

fn def(worktree_id: &str, action_id: &str) -> Result<ActionDef, RpcError> {
    let sets = sets();
    let set = sets.get(worktree_id).ok_or_else(|| err(ErrorCode::NotFound, "worktree not found or has no .tomo.toml"))?;
    set.actions.iter().find(|a| a.id == action_id).cloned().ok_or_else(|| {
        let known: Vec<&str> = set.actions.iter().map(|a| a.id.as_str()).collect();
        err(ErrorCode::NotFound, format!("unknown action {action_id:?}; known actions: {}", known.join(", ")))
    })
}

fn def_or_placeholder(worktree_id: &str, action_id: &str) -> ActionDef {
    def(worktree_id, action_id).unwrap_or_else(|_| ActionDef { id: action_id.to_string(), label: action_id.to_string(), command: String::new(), mode: ActionMode::Pane, show: ActionShow::Menu, shortcut: None })
}

fn source_of(action: &ActionDef) -> PaneSource {
    PaneSource { kind: ACTION_SOURCE_KIND.into(), id: action.id.clone(), label: action.label.clone() }
}

fn running_pane(inner: &Inner, worktree_id: &str, action_id: &str) -> Option<Id> {
    inner
        .panes
        .values()
        .find(|p| p.row.worktree_id == worktree_id && p.source.as_ref().is_some_and(|s| s.kind == ACTION_SOURCE_KIND && s.id == action_id) && p.pty.is_some() && p.exit_code.is_none())
        .map(|p| p.row.id.clone())
}

fn hook(inner: &Inner, event: &str, worktree_id: &str, action: &ActionDef, pane_id: Option<&str>) -> HookEvent {
    HookEvent { action: Some(HookAction { id: action.id.clone(), label: action.label.clone() }), pane: pane_id.and_then(|p| Daemon::hook_pane(inner, p)), ..events::envelope(inner, event, Some(worktree_id)) }
}

fn activity_event(kind: ActionActivity, worktree_id: &str, action: &ActionDef, pane_id: Option<&str>, verb: &str) -> ActivityEvent {
    ActivityEvent { pane_id: pane_id.map(str::to_string), payload: json!({ "action_id": action.id, "pane_id": pane_id }), ..activity::event(kind, Some(worktree_id), format!("{} {verb}", action.label)) }
}

/// The `worktree_files` reload. It reads `.tomo.toml` in every worktree and sends `actions_changed` for each set that changed.
/// A bad file never blocks the worktree: it gives an empty set and one notice.
fn reload(daemon: &Arc<Daemon>) {
    let targets: Vec<(Id, PathBuf)> = daemon.lock().worktrees.values().filter(|w| w.exists).map(|w| (w.id.clone(), w.path.clone())).collect();
    let loaded: Vec<ActionSet> = targets
        .into_iter()
        .map(|(worktree_id, path)| {
            let (actions, error) = model::load(&path);
            ActionSet { worktree_id, actions, error }
        })
        .collect();
    let mut inner = daemon.lock();
    let changed: Vec<ActionSet> = {
        let mut sets = sets();
        let live: HashSet<Id> = loaded.iter().map(|s| s.worktree_id.clone()).collect();
        sets.retain(|id, _| live.contains(id));
        let changed: Vec<ActionSet> = loaded.into_iter().filter(|set| sets.get(&set.worktree_id) != Some(set)).collect();
        sets.extend(changed.iter().map(|s| (s.worktree_id.clone(), s.clone())));
        changed
    };
    for set in changed {
        let name = inner.worktrees.get(&set.worktree_id).map(|w| Daemon::worktree_view(&inner, w).name).unwrap_or_default();
        if Daemon::diagnostic_on_change(&mut inner, "config", &format!("{name} .tomo.toml"), set.error.clone()) {
            Daemon::emit(&mut inner, Event::Notice { level: NoticeLevel::Warning, message: format!("{name}: {}", set.error.as_deref().unwrap_or_default()) });
        }
        Daemon::emit(&mut inner, Event::ActionsChanged { set });
    }
}

/// The `actions` field of the `subscribe` snapshot.
pub fn snapshot() -> Vec<ActionSet> {
    sets().values().cloned().collect()
}

/// The `pane_exited` seam. An Action pane that exits records its outcome; a non-zero exit that Tomo did not cause is a crash.
pub fn exited(inner: &mut Inner, exit: &PaneExit) {
    let Some(source) = exit.source.as_ref().filter(|s| s.kind == ACTION_SOURCE_KIND) else { return };
    let action = def_or_placeholder(&exit.worktree_id, &source.id);
    let (worktree_id, pane_id) = (exit.worktree_id.as_str(), Some(exit.pane_id.as_str()));
    let ev = hook(inner, "action.exited", worktree_id, &action, pane_id);
    inner.hook_queue.push(ev);
    match (exit.exit_code, exit.stop_intent) {
        (Some(0), _) => Daemon::record(inner, activity_event(ActionActivity::Completed, worktree_id, &action, pane_id, "completed")),
        (_, true) => Daemon::record(inner, activity_event(ActionActivity::Stopped, worktree_id, &action, pane_id, "stopped")),
        (code, false) => crashed(inner, worktree_id, &action, &exit.pane_id, code.unwrap_or(-1)),
    }
}

fn crashed(inner: &mut Inner, worktree_id: &str, action: &ActionDef, pane_id: &str, exit_code: i32) {
    let item = AttentionItem {
        id: new_id(),
        worktree_id: worktree_id.to_string(),
        pane_id: Some(pane_id.to_string()),
        level: AttentionLevel::Attention,
        message: format!("{} exited with code {exit_code}", action.label),
        created_at_ms: now_ms(),
        viewed_at_ms: None,
        kind: AttentionKind::Crash,
        url: None,
        agent_kind: None,
        resolved_at_ms: None,
    };
    Daemon::push_attention(inner, item.clone());
    let ev = HookEvent { attention: Some(item.clone()), ..hook(inner, "action.crashed", worktree_id, action, Some(pane_id)) };
    inner.hook_queue.push(ev);
    let ev = ActivityEvent {
        detail: Some(format!("exit code {exit_code}")),
        payload: json!({ "action_id": action.id, "exit_code": exit_code, "pane_id": pane_id }),
        attention_id: Some(item.id),
        ..activity_event(ActionActivity::Crashed, worktree_id, action, Some(pane_id), "crashed")
    };
    Daemon::record(inner, ev);
}

pub fn list(daemon: &Daemon, worktree_id: Id) -> Result<Value, RpcError> {
    if !daemon.lock().worktrees.contains_key(&worktree_id) {
        return Err(err(ErrorCode::NotFound, "worktree not found"));
    }
    ok(sets().get(&worktree_id).cloned().unwrap_or(ActionSet { worktree_id, actions: vec![], error: None }))
}

pub fn run(daemon: &Arc<Daemon>, worktree_id: &str, action_id: &str) -> Result<Value, RpcError> {
    let result = start(daemon, worktree_id, action_id);
    daemon.flush_hooks();
    result.and_then(ok)
}

pub fn stop(daemon: &Arc<Daemon>, worktree_id: &str, action_id: &str) -> Result<Value, RpcError> {
    let result = end(daemon, worktree_id, action_id);
    daemon.flush_hooks();
    result.map(|_| Value::Null)
}

pub fn restart(daemon: &Arc<Daemon>, worktree_id: &str, action_id: &str) -> Result<Value, RpcError> {
    let result = end(daemon, worktree_id, action_id).and_then(|_| start(daemon, worktree_id, action_id));
    daemon.flush_hooks();
    result.and_then(ok)
}

fn start(daemon: &Arc<Daemon>, worktree_id: &str, action_id: &str) -> Result<ActionRunResult, RpcError> {
    let mut inner = daemon.lock();
    let action = def(worktree_id, action_id)?;
    let path = inner.worktrees.get(worktree_id).filter(|w| w.exists).ok_or_else(|| err(ErrorCode::NotFound, "worktree not found"))?.path.clone();
    let pane_id = match action.mode {
        ActionMode::External => {
            std::process::Command::new("sh")
                .arg("-c")
                .arg(&action.command)
                .current_dir(&path)
                .env("TOMO_WORKTREE_ID", worktree_id)
                .env("TOMO_WORKTREE_PATH", &path)
                .env("TOMO_SOCKET", &daemon.paths.socket)
                .env("TOMO_BIN", &daemon.tomo_bin)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .map_err(|e| err(ErrorCode::Internal, format!("{}: {e}", action.command)))?;
            None
        }
        ActionMode::Pane => {
            if let Some(pane_id) = running_pane(&inner, worktree_id, action_id) {
                Daemon::focus_pane(&mut inner, &pane_id);
                let pane = Daemon::pane_view(&inner, &pane_id);
                return Ok(ActionRunResult { action, pane, reused: true });
            }
            let argv = [inner.config.shell.clone(), "-lc".into(), action.command.clone()];
            let (_, pane_id) = daemon.spawn_in_worktree(&mut inner, worktree_id, path, None, None, SplitDirection::Horizontal, Some(&argv), Some(action.label.clone()), None)?;
            if let Some(pane) = inner.panes.get_mut(&pane_id) {
                pane.source = Some(source_of(&action));
            }
            Daemon::focus_pane(&mut inner, &pane_id);
            Daemon::emit_pane(&mut inner, &pane_id);
            Some(pane_id)
        }
    };
    let ev = hook(&inner, "action.started", worktree_id, &action, pane_id.as_deref());
    inner.hook_queue.push(ev);
    Daemon::record(&mut inner, activity_event(ActionActivity::Started, worktree_id, &action, pane_id.as_deref(), "started"));
    let pane = pane_id.and_then(|p| Daemon::pane_view(&inner, &p));
    Ok(ActionRunResult { action, pane, reused: false })
}

fn end(daemon: &Arc<Daemon>, worktree_id: &str, action_id: &str) -> Result<bool, RpcError> {
    let mut inner = daemon.lock();
    let action = def(worktree_id, action_id)?;
    let Some(pane_id) = running_pane(&inner, worktree_id, action_id) else { return Ok(false) };
    let ev = hook(&inner, "action.exited", worktree_id, &action, Some(&pane_id));
    inner.hook_queue.push(ev);
    Daemon::record(&mut inner, activity_event(ActionActivity::Stopped, worktree_id, &action, Some(&pane_id), "stopped"));
    daemon.stop_pane(&mut inner, &pane_id);
    Daemon::emit_tabs(&mut inner, worktree_id);
    Ok(true)
}
