use crate::daemon::{Daemon, Inner};
use crate::procs::{self, Root};
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;
use tomo_proto::*;

const BUSY_CPU_PERCENT: f32 = 3.0;

pub fn classify_all(inner: &Inner) -> Vec<ProcessInfo> {
    let roots: Vec<Root> = inner
        .panes
        .values()
        .filter(|p| p.exit_code.is_none())
        .filter_map(|p| p.pty.as_ref().map(|pty| Root { pid: pty.pid, pane_id: p.row.id.clone(), worktree_id: p.row.worktree_id.clone() }))
        .collect();
    let paths: Vec<(Id, std::path::PathBuf)> = inner.worktrees.values().filter(|w| w.exists).map(|w| (w.id.clone(), w.path.clone())).collect();
    procs::classify(&inner.proc_rows, &roots, &paths)
}

const FULL_CWD_REFRESH_MS: u64 = 20_000;

pub fn poll_once(daemon: &Arc<Daemon>, inner: &mut Inner, force_full: bool) {
    let _ = daemon;
    let roots: Vec<u32> = inner.panes.values().filter(|p| p.exit_code.is_none()).filter_map(|p| p.pty.as_ref().map(|x| x.pid)).collect();
    let full = force_full || now_ms().saturating_sub(inner.last_full_poll_ms) >= FULL_CWD_REFRESH_MS;
    if full {
        inner.last_full_poll_ms = now_ms();
    }
    inner.proc_rows = inner.procs.refresh(&roots, full);
    inner.proc_rows_at_ms = now_ms();
    let by_pid: HashMap<u32, usize> = inner.proc_rows.iter().enumerate().map(|(i, r)| (r.pid, i)).collect();
    let index = procs::children_index(&inner.proc_rows);
    let now = now_ms();

    let pane_ids: Vec<Id> = inner.panes.keys().cloned().collect();
    for pane_id in pane_ids {
        let Some(root_pid) = inner.panes.get(&pane_id).filter(|p| p.exit_code.is_none()).and_then(|p| p.pty.as_ref()).map(|p| p.pid) else { continue };
        let Some(&root_idx) = by_pid.get(&root_pid) else { continue };
        let cwd = inner.proc_rows[root_idx].cwd.clone();
        let newest =
            index.get(&root_pid).and_then(|kids| kids.iter().filter_map(|k| by_pid.get(k)).map(|&i| &inner.proc_rows[i]).max_by_key(|r| r.start_time_s));
        let title = newest.map(|r| r.name.clone());
        let cmd = newest.map(|r| r.cmd.chars().take(200).collect::<String>());
        let mut changed = false;
        {
            let pane = inner.panes.get_mut(&pane_id).unwrap();
            if let Some(cwd) = cwd.filter(|c| c != &pane.row.cwd) {
                pane.row.cwd = cwd;
                let row = pane.row.clone();
                let _ = inner.store.pane_upsert(&row);
                changed = true;
            }
            if pane.process_title != title {
                pane.process_title = title;
                changed = true;
            }
            if pane.process_cmd != cmd {
                pane.process_cmd = cmd;
                changed = true;
            }
        }
        if changed {
            if let Some(view) = Daemon::pane_view(inner, &pane_id) {
                Daemon::emit(inner, Event::PaneChanged { pane: view });
            }
        }

        let descendants = procs::descendants(&inner.proc_rows, root_pid);
        let agent_proc = descendants
            .iter()
            .filter_map(|pid| by_pid.get(pid))
            .map(|&i| &inner.proc_rows[i])
            .find_map(|r| crate::providers::detect(&r.name, &r.cmd).map(|k| (k, r.pid)));
        match agent_proc {
            Some((kind, pid)) => {
                let subtree_cpu: f32 = std::iter::once(pid)
                    .chain(procs::descendants(&inner.proc_rows, pid))
                    .filter_map(|p| by_pid.get(&p))
                    .map(|&i| inner.proc_rows[i].cpu_percent)
                    .sum();
                let state = (subtree_cpu > BUSY_CPU_PERCENT).then_some(AgentState::Working);
                let report = AgentReport { pane_id: pane_id.clone(), kind, state, session_ref: None, authority: Authority::Heuristic, at_ms: now };
                Daemon::apply_report(inner, &report, Some(pid));
            }
            None => {
                let gone = inner.agents.get(&pane_id).map_or(false, |a| a.pid.is_some() && a.state != AgentState::Exited);
                if gone {
                    let kind = inner.agents[&pane_id].kind;
                    let report = AgentReport {
                        pane_id: pane_id.clone(),
                        kind,
                        state: Some(AgentState::Exited),
                        session_ref: None,
                        authority: Authority::Lifecycle,
                        at_ms: now,
                    };
                    Daemon::apply_report(inner, &report, None);
                }
            }
        }
    }

    let resources = procs::worktrees_by_weight(&classify_all(inner));
    let changed = resources.len() != inner.resources.len()
        || resources.iter().zip(&inner.resources).any(|(a, b)| {
            a.worktree_id != b.worktree_id
                || a.rss_bytes.abs_diff(b.rss_bytes) > 8 * 1024 * 1024
                || (a.cpu_percent - b.cpu_percent).abs() > 2.0
                || a.process_count != b.process_count
        });
    inner.resources = resources;
    if changed {
        let snapshot = inner.resources.clone();
        Daemon::emit(inner, Event::Resources { worktrees: snapshot });
    }
}

/// One monitor tick: the process poll under the lock, then the `process_polled`
/// seams with the lock released, then the queued hooks. Blocking; call it from a
/// blocking task.
pub fn poll_and_scan(daemon: &Arc<Daemon>, force_full: bool) {
    {
        let mut inner = daemon.lock();
        poll_once(daemon, &mut inner, force_full);
    }
    for polled in &daemon.seams.process_polled {
        polled(daemon);
    }
    daemon.flush_hooks();
}

pub async fn run(daemon: Arc<Daemon>) {
    loop {
        let subscribed = daemon.lock().clients.values().any(|c| c.subscribed);
        tokio::time::sleep(if subscribed { Duration::from_secs(2) } else { Duration::from_secs(15) }).await;
        let d = daemon.clone();
        let _ = tokio::task::spawn_blocking(move || poll_and_scan(&d, false)).await;
    }
}
