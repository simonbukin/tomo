//! Runtime: listening TCP sockets owned by pane process trees.
//!
//! Attribution goes pid → pane (the pane whose PTY root is an ancestor) →
//! the pane source. A port number is never evidence; a process outside every
//! pane tree is never reported. The scan joins the monitor tick through the
//! `process_polled` seam. See docs/runtime.md.

mod model;
#[cfg(test)]
mod tests;

use crate::activity;
use crate::addons;
use crate::daemon::{ok, Daemon, Inner};
use crate::events;
use crate::monitor;
use crate::procs;
use model::{is_shell, normalise_host, probe, reconcile, Listener, Reconciled};
use serde_json::{json, Value};
use std::collections::{BTreeSet, HashMap};
use std::sync::Arc;
use tomo_proto::*;

/// One `endpoint_discovered` activity per worktree and port in this window.
pub const ENDPOINT_REPEAT_MS: u64 = 60_000;
/// `runtime_list` polls first when the last scan is older than this, the same rule as `ps`.
const STALE_MS: u64 = 1_500;

/// The endpoints of one daemon, in `addons::State`. Memory only: a restart finds them again on the first poll.
#[derive(Debug, Default)]
pub struct Endpoints {
    list: Vec<RuntimeEndpoint>,
    gone_ms: HashMap<Id, u64>,
    at_ms: u64,
}

fn state(inner: &Inner) -> &Endpoints {
    &addons::state(inner).runtime
}

/// One `lsof` call for the given pids; none when there is nothing to ask about.
/// The call has a deadline, because the monitor tick waits for the answer.
fn listeners(pids: &[u32]) -> Result<Vec<Listener>, String> {
    if pids.is_empty() {
        return Ok(Vec::new());
    }
    let list = pids.iter().map(u32::to_string).collect::<Vec<_>>().join(",");
    let mut command = std::process::Command::new("lsof");
    command.args(["-nP", "-iTCP", "-sTCP:LISTEN", "-a", "-p", &list, "-F", "pn"]).stdin(std::process::Stdio::null()).stderr(std::process::Stdio::null());
    match model::output_within(command, model::LSOF_DEADLINE) {
        Ok(Some(stdout)) => Ok(model::parse_lsof(&String::from_utf8_lossy(&stdout))),
        Ok(None) => Err(format!("lsof did not answer in {} s", model::LSOF_DEADLINE.as_secs())),
        Err(e) => Err(format!("lsof failed: {e}")),
    }
}

fn owned(inner: &Inner) -> Vec<ProcessInfo> {
    monitor::classify_all(inner).into_iter().filter(|p| p.ownership == Ownership::Owned).collect()
}

fn program_of(inner: &Inner, pid: u32) -> Option<String> {
    inner.proc_rows.iter().find(|r| r.pid == pid).map(procs::program_name)
}

/// Every owned process except an idle pane shell, which cannot listen. A pane
/// root is judged by the program it runs now, because a shell that exec'd a
/// server keeps its pid.
fn candidate_pids(inner: &Inner) -> Vec<u32> {
    owned(inner).into_iter().filter(|p| p.depth > 0 || !program_of(inner, p.pid).map_or(true, |n| is_shell(&n))).map(|p| p.pid).collect()
}

fn observe(inner: &Inner, listeners: &[Listener], now: u64) -> Vec<RuntimeEndpoint> {
    let by_pid: HashMap<u32, ProcessInfo> = owned(inner).into_iter().map(|p| (p.pid, p)).collect();
    listeners
        .iter()
        .filter_map(|l| {
            let p = by_pid.get(&l.pid)?;
            let pane_id = p.pane_id.clone()?;
            let worktree_id = p.worktree_id.clone()?;
            let source = inner.panes.get(&pane_id).and_then(|p| p.source.clone());
            Some(RuntimeEndpoint {
                id: format!("{}:{}", l.pid, l.port),
                worktree_id,
                pane_id: Some(pane_id),
                action_id: PaneSource::action_id(source.as_ref()),
                pid: l.pid,
                process: program_of(inner, l.pid).unwrap_or_else(|| p.name.clone()),
                protocol: RuntimeProtocol::Tcp,
                host: normalise_host(&l.host),
                port: l.port,
                label: source.as_ref().map(|s| s.label.clone()),
                discovered_at_ms: now,
                source,
            })
        })
        .collect()
}

fn emit(inner: &mut Inner, worktree_id: &str) {
    let endpoints = state(inner).list.iter().filter(|e| e.worktree_id == worktree_id).cloned().collect();
    Daemon::emit(inner, Event::EndpointsChanged { worktree_id: worktree_id.to_string(), endpoints });
}

fn hook(inner: &Inner, event: &str, e: &RuntimeEndpoint) -> HookEvent {
    HookEvent {
        pane: e.pane_id.as_deref().and_then(|p| Daemon::hook_pane(inner, p)),
        action: e.action_id.as_ref().map(|id| HookAction { id: id.clone(), label: e.label.clone().unwrap_or_else(|| id.clone()) }),
        ..events::envelope(inner, event, Some(&e.worktree_id))
    }
}

fn discovered(e: &RuntimeEndpoint) -> ActivityEvent {
    ActivityEvent {
        pane_id: e.pane_id.clone(),
        detail: Some(format!("{}:{}", e.host, e.port)),
        payload: json!({ "port": e.port, "host": e.host, "pid": e.pid, "action_id": e.action_id, "endpoint_id": e.id }),
        ..activity::event(RuntimeActivity::EndpointDiscovered, Some(&e.worktree_id), format!("{} listens on {}", e.label.clone().unwrap_or_else(|| e.process.clone()), e.port))
    }
}

/// Merges one observation under the lock: the list, the activity, the hooks, and `endpoints_changed`.
/// Returns the new endpoints, which still need a protocol probe.
pub fn remember(inner: &mut Inner, observed: Vec<RuntimeEndpoint>, now: u64) -> Vec<RuntimeEndpoint> {
    let Reconciled { endpoints, gone_ms, added, removed, restarted } = reconcile(&state(inner).list, &state(inner).gone_ms, observed, now);
    addons::state_mut(inner).runtime = Endpoints { list: endpoints, gone_ms, at_ms: now };
    for e in &added {
        let ev = hook(inner, "runtime.endpoint_discovered", e);
        inner.hook_queue.push(ev);
        let repeat = Daemon::recorded_recently(inner, RuntimeActivity::EndpointDiscovered, ENDPOINT_REPEAT_MS, |a| a.worktree_id.as_deref() == Some(e.worktree_id.as_str()) && a.payload["port"] == e.port);
        if !repeat {
            Daemon::record(inner, discovered(e));
        }
    }
    for e in &removed {
        let ev = hook(inner, "runtime.endpoint_removed", e);
        inner.hook_queue.push(ev);
    }
    let changed: BTreeSet<Id> = added.iter().chain(&removed).chain(&restarted).map(|e| e.worktree_id.clone()).collect();
    for worktree_id in &changed {
        emit(inner, worktree_id);
    }
    added.into_iter().chain(restarted).collect()
}

/// The `process_polled` seam: one `lsof` with no lock held, the merge under the lock, then one probe for each new endpoint.
pub fn scan(daemon: &Arc<Daemon>) {
    let pids = candidate_pids(&daemon.lock());
    let scanned = listeners(&pids);
    let mut inner = daemon.lock();
    Daemon::diagnostic_on_change(&mut inner, "runtime", "port scan", scanned.as_ref().err().cloned());
    let Ok(found) = scanned else { return };
    let now = now_ms();
    let observed = observe(&inner, &found, now);
    let fresh = remember(&mut inner, observed, now);
    drop(inner);
    for e in fresh {
        probe_endpoint(daemon, e.id, e.host, e.port);
    }
}

fn probe_endpoint(daemon: &Arc<Daemon>, id: Id, host: String, port: u16) {
    let d = daemon.clone();
    daemon.rt.spawn(async move {
        let protocol = tokio::task::spawn_blocking(move || probe(&host, port)).await.unwrap_or(RuntimeProtocol::Tcp);
        let mut inner = d.lock();
        let Some(e) = addons::state_mut(&mut inner).runtime.list.iter_mut().find(|e| e.id == id) else { return };
        if e.protocol == protocol {
            return;
        }
        e.protocol = protocol;
        let worktree_id = e.worktree_id.clone();
        emit(&mut inner, &worktree_id);
    });
}

/// `runtime_list`: the endpoints of one worktree, or of all, by worktree, port, and pid.
pub async fn list(daemon: &Arc<Daemon>, worktree_id: Option<Id>) -> Result<Value, RpcError> {
    let stale = now_ms().saturating_sub(state(&daemon.lock()).at_ms) > STALE_MS;
    if stale {
        let d = daemon.clone();
        let _ = tokio::task::spawn_blocking(move || monitor::poll_and_scan(&d, false)).await;
    }
    let inner = daemon.lock();
    let mut list: Vec<RuntimeEndpoint> = state(&inner).list.iter().filter(|e| worktree_id.as_deref().map_or(true, |w| e.worktree_id == w)).cloned().collect();
    list.sort_by(|a, b| (&a.worktree_id, a.port, a.pid).cmp(&(&b.worktree_id, b.port, b.pid)));
    ok(list)
}

/// The `endpoints` field of the `subscribe` snapshot.
pub fn snapshot(inner: &Inner) -> Vec<RuntimeEndpoint> {
    state(inner).list.clone()
}
