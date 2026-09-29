//! Sleeping agents: an agent that stays idle for the whole idle period ends, the pane keeps a snapshot of its
//! terminal, and a key resumes the same session. See docs/sleeping-agents.md.
//!
//! `blocker` holds the rules and `advance` the idle clock, both pure. The rest reads the facts from the daemon
//! state and does the file writes, the signal, and the typed resume line at the edges.

use crate::daemon::{err, internal, pending_action, Daemon, Inner, Pending};
use crate::providers;
use crate::store::SleepRow;
use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;
use tomo_proto::*;

/// The facts that decide whether an agent may sleep, read at one monitor tick.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Facts {
    pub state: AgentState,
    pub hooked: bool,
    pub subagent_runs: bool,
    pub attention_open: bool,
    pub work_child: bool,
    pub busy: bool,
    pub draft: bool,
    pub on_screen: bool,
    pub resumable: bool,
    pub keep_awake: bool,
    pub under_shell: bool,
}

/// Why an agent stays awake, in the order of the rules in docs/sleeping-agents.md.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Awake {
    NotIdle,
    Subagent,
    Attention,
    Child,
    Cpu,
    Draft,
    OnScreen,
    NoSession,
    KeepAwake,
    NoHooks,
    NoProcess,
}

impl Awake {
    pub fn message(self) -> &'static str {
        match self {
            Awake::NotIdle => "the agent is not idle or done",
            Awake::Subagent => "a subagent runs",
            Awake::Attention => "an attention item of the pane is open",
            Awake::Child => "the agent has a child process",
            Awake::Cpu => "the agent uses CPU",
            Awake::Draft => "the pane holds input that was not sent",
            Awake::OnScreen => "the pane is on screen",
            Awake::NoSession => "the session cannot resume",
            Awake::KeepAwake => "the pane is kept awake",
            Awake::NoHooks => "the agent sends no hook events",
            Awake::NoProcess => "no agent process runs under the pane's shell",
        }
    }
}

/// Who asks for the sleep. `tomo pane sleep` skips the rules that only guess what you want: CPU, on screen, and
/// keep awake. The rules that protect work stay.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Ask {
    AfterIdle,
    Now,
}

/// The first rule that keeps the agent awake, or `None` when it may sleep.
pub fn blocker(f: &Facts, ask: Ask) -> Option<Awake> {
    let guess = ask == Ask::AfterIdle;
    [
        (!matches!(f.state, AgentState::Idle | AgentState::Done), Awake::NotIdle),
        (f.subagent_runs, Awake::Subagent),
        (f.attention_open, Awake::Attention),
        (f.work_child, Awake::Child),
        (guess && f.busy, Awake::Cpu),
        (f.draft, Awake::Draft),
        (guess && f.on_screen, Awake::OnScreen),
        (!f.resumable, Awake::NoSession),
        (guess && f.keep_awake, Awake::KeepAwake),
        (!f.hooked, Awake::NoHooks),
        (!f.under_shell, Awake::NoProcess),
    ]
    .into_iter()
    .find_map(|(blocks, why)| blocks.then_some(why))
}

/// What starts the idle period again when it changes, beside a rule that fails: a hook event, a new state,
/// input, or a new agent process.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Stamp {
    pub state: AgentState,
    pub state_at_ms: u64,
    pub input_at_ms: u64,
    pub pid: Option<u32>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Clock {
    stamp: Stamp,
    since_ms: u64,
}

/// The idle clock after one tick. It runs only while every rule holds, and starts again at any change.
pub fn advance(prev: Option<Clock>, stamp: Stamp, eligible: bool, now: u64) -> Option<Clock> {
    match (eligible, prev) {
        (false, _) => None,
        (true, Some(c)) if c.stamp == stamp => Some(c),
        (true, _) => Some(Clock { stamp, since_ms: now }),
    }
}

pub fn due(clock: &Clock, period_ms: u64, now: u64) -> bool {
    now.saturating_sub(clock.since_ms) >= period_ms
}

/// The idle period in ms, or `None` when sleeping is off. `TOMO_SLEEP_AFTER_MS` is a test override.
pub fn period_ms(minutes: u32, test_override: Option<&str>) -> Option<u64> {
    Some(test_override.and_then(|v| v.parse::<u64>().ok()).unwrap_or(minutes as u64 * 60_000)).filter(|ms| *ms > 0)
}

/// What one input to the pane says about rule 5: `None` when it is no typing (a focus report), else whether
/// it leaves text that nobody sent. Only an input that ends with Enter sends the line.
pub fn draft_after(bytes: &[u8]) -> Option<bool> {
    let typed: Vec<u8> = strip_focus_reports(bytes);
    (!typed.is_empty()).then(|| !matches!(typed.last(), Some(b'\r' | b'\n')))
}

fn strip_focus_reports(bytes: &[u8]) -> Vec<u8> {
    const REPORTS: [&[u8]; 2] = [b"\x1b[I", b"\x1b[O"];
    let mut out = Vec::with_capacity(bytes.len());
    let mut rest = bytes;
    while !rest.is_empty() {
        match REPORTS.iter().find(|r| rest.starts_with(r)) {
            Some(r) => rest = &rest[r.len()..],
            None => {
                out.push(rest[0]);
                rest = &rest[1..];
            }
        }
    }
    out
}

/// The per-pane state of this feature. Memory only: the `sleep` column of the pane row is the durable part.
#[derive(Debug, Default)]
pub struct PaneSleep {
    pub input_at_ms: u64,
    pub draft: bool,
    /// The agent process that got SIGTERM and has not ended yet.
    pub ending_pid: Option<u32>,
    /// Input that arrived while the agent sleeps. It goes to the agent after its first hook event.
    pub queued: Vec<u8>,
    /// Hook events that fired before this time came from the process that ended.
    pub hooks_after_ms: u64,
}

const END_WAIT: Duration = Duration::from_secs(5);
const WAKE_WAIT: Duration = Duration::from_secs(30);

pub fn snapshot_path(daemon: &Daemon, pane_id: &str) -> PathBuf {
    daemon.paths.scrollback_dir.join(format!("{pane_id}.snapshot"))
}

fn encode_snapshot(cols: u16, rows: u16, bytes: &[u8]) -> Vec<u8> {
    [format!("{cols} {rows}\n").into_bytes(), bytes.to_vec()].concat()
}

fn decode_snapshot(file: &[u8]) -> Option<(u16, u16, &[u8])> {
    let newline = file.iter().position(|&b| b == b'\n')?;
    let (cols, rows) = std::str::from_utf8(&file[..newline]).ok()?.split_once(' ')?;
    Some((cols.parse().ok()?, rows.parse().ok()?, &file[newline + 1..]))
}

pub fn read_snapshot(daemon: &Daemon, pane_id: &str) -> Result<PaneSnapshot, RpcError> {
    use base64::Engine;
    let file = std::fs::read(snapshot_path(daemon, pane_id)).map_err(|_| err(ErrorCode::NotFound, "the pane has no snapshot"))?;
    let (cols, rows, bytes) = decode_snapshot(&file).ok_or_else(|| err(ErrorCode::Internal, "the snapshot file is damaged"))?;
    let data_base64 = base64::engine::general_purpose::STANDARD.encode(crate::pty::strip_terminal_queries(bytes));
    Ok(PaneSnapshot { cols, rows, data_base64 })
}

fn alive(pid: u32) -> bool {
    unsafe { libc::kill(pid as i32, 0) == 0 }
}

/// The facts of one agent pane from the last process poll. `None` when the pane has no live terminal.
fn facts(inner: &Inner, agent: &AgentPresence, open_attention: &HashSet<Id>) -> Option<Facts> {
    let pane = inner.panes.get(&agent.pane_id).filter(|p| p.exit_code.is_none())?;
    let root = pane.pty.as_ref()?.pid;
    let provider = providers::provider(agent.kind);
    let rows = &inner.proc_rows;
    let row = |pid: u32| rows.iter().find(|r| r.pid == pid);
    let agent_pid = agent.pid.filter(|pid| *pid != root && crate::procs::descendants(rows, root).contains(pid));
    let children: Vec<u32> = agent_pid.map(|pid| crate::procs::descendants(rows, pid)).unwrap_or_default();
    let cpu: f32 = agent_pid.into_iter().chain(children.iter().copied()).filter_map(row).map(|r| r.cpu_percent).sum();
    Some(Facts {
        state: agent.state,
        hooked: agent.authority == Authority::Lifecycle && !agent.estimated,
        subagent_runs: agent.subagents.iter().any(|s| matches!(s.state, AgentState::Working | AgentState::Waiting)),
        attention_open: open_attention.contains(&agent.pane_id),
        work_child: children.iter().filter_map(|pid| row(*pid)).any(|r| !provider.sleep_safe_children.contains(&crate::procs::program_name(r).as_str())),
        busy: cpu > crate::monitor::BUSY_CPU_PERCENT,
        draft: pane.sleep.draft,
        on_screen: inner.clients.values().any(|c| c.attached.contains(&agent.pane_id)),
        resumable: agent.session_ref.as_deref().is_some_and(|s| Some(s) != provider.resume_without_session),
        keep_awake: pane.row.keep_awake,
        under_shell: agent_pid.is_some(),
    })
}

fn stamp(inner: &Inner, agent: &AgentPresence) -> Stamp {
    let input_at_ms = inner.panes.get(&agent.pane_id).map_or(0, |p| p.sleep.input_at_ms);
    Stamp { state: agent.state, state_at_ms: agent.updated_at_ms, input_at_ms, pid: agent.pid }
}

fn open_attention(inner: &Inner) -> HashSet<Id> {
    let items = inner.store.attention_list().unwrap_or_default();
    items.into_iter().filter(|a| a.viewed_at_ms.is_none() && a.resolved_at_ms.is_none()).filter_map(|a| a.pane_id).collect()
}

/// One monitor tick: moves every idle clock, and puts to sleep each agent whose clock ran the whole period.
pub fn tick(daemon: &Arc<Daemon>, inner: &mut Inner, now: u64) {
    heal(daemon, inner);
    let Some(period) = period_ms(inner.config.sleep_after_minutes, std::env::var("TOMO_SLEEP_AFTER_MS").ok().as_deref()) else {
        inner.sleep_clocks.clear();
        return;
    };
    let open = open_attention(inner);
    let clocks: std::collections::HashMap<Id, Clock> = inner
        .agents
        .values()
        .filter(|a| a.sleep.is_none())
        .filter_map(|a| {
            let eligible = facts(inner, a, &open).is_some_and(|f| blocker(&f, Ask::AfterIdle).is_none());
            advance(inner.sleep_clocks.get(&a.pane_id).copied(), stamp(inner, a), eligible, now).map(|c| (a.pane_id.clone(), c))
        })
        .collect();
    let ready: Vec<Id> = clocks.iter().filter(|(_, c)| due(c, period, now)).map(|(id, _)| id.clone()).collect();
    inner.sleep_clocks = clocks;
    for pane_id in ready {
        if let Err(e) = begin(daemon, inner, &pane_id) {
            Daemon::diagnostic(inner, DiagnosticLevel::Warning, "sleep", format!("pane {pane_id}: {}", e.message));
        }
    }
}

/// A pane that is marked asleep while an agent runs in it is awake. This happens after a daemon crash between
/// the saved mark and the signal.
fn heal(daemon: &Arc<Daemon>, inner: &mut Inner) {
    let running = |inner: &Inner, pane_id: &str| {
        let Some(root) = inner.panes.get(pane_id).and_then(|p| p.pty.as_ref()).map(|p| p.pid) else { return false };
        let rows = &inner.proc_rows;
        crate::procs::descendants(rows, root).iter().filter_map(|pid| rows.iter().find(|r| r.pid == *pid)).any(|r| providers::detect(&r.name, &r.cmd).is_some())
    };
    let awake: Vec<Id> = inner
        .agents
        .values()
        .filter(|a| a.sleep == Some(Sleep::Asleep))
        .filter(|a| inner.panes.get(&a.pane_id).is_some_and(|p| p.sleep.ending_pid.is_none()))
        .filter(|a| running(inner, &a.pane_id))
        .map(|a| a.pane_id.clone())
        .collect();
    for pane_id in awake {
        cancel(daemon, inner, &pane_id, "an agent runs in the pane again");
    }
}

/// `tomo pane sleep`: the rules that protect work, on a fresh process poll, then the sleep.
pub fn sleep_now(daemon: &Arc<Daemon>, inner: &mut Inner, pane_id: &str) -> Result<(), RpcError> {
    crate::monitor::poll_once(daemon, inner, true);
    let agent = inner.agents.get(pane_id).cloned().ok_or_else(|| err(ErrorCode::BadRequest, "the pane has no agent"))?;
    if agent.sleep.is_some() {
        return Ok(());
    }
    let facts = facts(inner, &agent, &open_attention(inner)).ok_or_else(|| err(ErrorCode::BadRequest, "the pane is not live"))?;
    if let Some(why) = blocker(&facts, Ask::Now) {
        return Err(err(ErrorCode::Conflict, format!("the agent stays awake: {}", why.message())));
    }
    begin(daemon, inner, pane_id)
}

/// Saves the snapshot and the mark, then asks the agent process to end. The watch cancels the sleep when the
/// process is still there after `END_WAIT`. Tomo never sends SIGKILL to sleep.
fn begin(daemon: &Arc<Daemon>, inner: &mut Inner, pane_id: &str) -> Result<(), RpcError> {
    let agent = inner.agents.get(pane_id).cloned().ok_or_else(|| err(ErrorCode::NotFound, "the pane has no agent"))?;
    let pid = agent.pid.ok_or_else(|| err(ErrorCode::BadRequest, "no agent process runs in the pane"))?;
    let pane = inner.panes.get(pane_id).ok_or_else(|| err(ErrorCode::NotFound, "pane not found"))?;
    std::fs::write(snapshot_path(daemon, pane_id), encode_snapshot(pane.row.cols, pane.row.rows, &pane.scrollback.snapshot()))
        .map_err(|e| internal(e.into()))?;
    let pane = inner.panes.get_mut(pane_id).ok_or_else(|| err(ErrorCode::NotFound, "pane not found"))?;
    pane.row.sleep = Some(SleepRow { at_ms: now_ms() });
    pane.sleep.ending_pid = Some(pid);
    let row = pane.row.clone();
    inner.store.pane_upsert(&row).map_err(internal)?;
    set_phase(inner, pane_id, Some(Sleep::Asleep));
    inner.sleep_clocks.remove(pane_id);
    unsafe { libc::kill(pid as i32, libc::SIGTERM) };
    watch_end(daemon, pane_id.to_string(), pid);
    Ok(())
}

fn set_phase(inner: &mut Inner, pane_id: &str, phase: Option<Sleep>) {
    let Some(cur) = inner.agents.get(pane_id).filter(|a| a.sleep != phase) else { return };
    let pid = if phase == Some(Sleep::Asleep) { None } else { cur.pid };
    let next = AgentPresence { sleep: phase, pid, ..cur.clone() };
    inner.agents.insert(pane_id.to_string(), next.clone());
    Daemon::emit(inner, Event::AgentChanged { agent: next });
    Daemon::emit_pane(inner, pane_id);
}

fn watch_end(daemon: &Arc<Daemon>, pane_id: Id, pid: u32) {
    let daemon = daemon.clone();
    daemon.rt.clone().spawn(async move {
        let started = std::time::Instant::now();
        while alive(pid) && started.elapsed() < END_WAIT {
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        let mut inner = daemon.lock();
        let Some(pane) = inner.panes.get_mut(&pane_id).filter(|p| p.sleep.ending_pid == Some(pid)) else { return };
        pane.sleep.ending_pid = None;
        pane.sleep.hooks_after_ms = now_ms();
        if alive(pid) {
            cancel(&daemon, &mut inner, &pane_id, "the agent did not end 5 s after SIGTERM");
        } else if pane.pending_line.is_some() {
            daemon.type_pending_when_quiet(pane_id);
        }
    });
}

/// The pane stays awake: the mark, the snapshot, and a wake that waited for the end all go.
fn cancel(daemon: &Arc<Daemon>, inner: &mut Inner, pane_id: &str, why: &str) {
    if let Some(pane) = inner.panes.get_mut(pane_id) {
        pane.row.sleep = None;
        pane.sleep.ending_pid = None;
        pane.sleep.queued.clear();
        pane.pending_line = None;
        let row = pane.row.clone();
        let _ = inner.store.pane_upsert(&row);
    }
    let _ = std::fs::remove_file(snapshot_path(daemon, pane_id));
    set_phase(inner, pane_id, None);
    Daemon::diagnostic(inner, DiagnosticLevel::Warning, "sleep", format!("pane {pane_id}: {why}, so it stays awake"));
}

/// Types `clear` and the resume line into the pane's shell. The pane shows "waking" until the first hook event
/// of the new agent process. A second wake while it wakes does nothing.
pub fn wake(daemon: &Arc<Daemon>, inner: &mut Inner, pane_id: &str) -> Result<(), RpcError> {
    let agent = inner.agents.get(pane_id).cloned().ok_or_else(|| err(ErrorCode::BadRequest, "the pane has no agent"))?;
    match agent.sleep {
        Some(Sleep::Waking) => return Ok(()),
        None => return Err(err(ErrorCode::BadRequest, "the agent of this pane does not sleep")),
        Some(Sleep::Asleep) => {}
    }
    let session = agent.session_ref.clone().ok_or_else(|| err(ErrorCode::BadRequest, "the sleeping agent has no session"))?;
    inner.panes.get(pane_id).filter(|p| p.pty.is_some() && p.exit_code.is_none()).ok_or_else(|| err(ErrorCode::BadRequest, "the pane is not live"))?;
    let line = providers::wake_line(&inner.config, agent.kind, &session, &daemon.paths.integrations_dir);
    let pane = inner.panes.get_mut(pane_id).ok_or_else(|| err(ErrorCode::NotFound, "pane not found"))?;
    pane.pending_line = Some(format!("clear; {line}"));
    pane.row.sleep = None;
    pane.sleep.draft = false;
    let ending = pane.sleep.ending_pid.is_some();
    if !ending {
        pane.sleep.hooks_after_ms = now_ms();
    }
    let row = pane.row.clone();
    inner.store.pane_upsert(&row).map_err(internal)?;
    set_phase(inner, pane_id, Some(Sleep::Waking));
    if !ending {
        daemon.type_pending_when_quiet(pane_id.to_string());
    }
    watch_wake(daemon, pane_id.to_string());
    Ok(())
}

/// A wake with no hook event in `WAKE_WAIT` shows the live terminal, where the resume failed. Queued input is
/// dropped: it would land in the shell.
fn watch_wake(daemon: &Arc<Daemon>, pane_id: Id) {
    let daemon = daemon.clone();
    daemon.rt.clone().spawn(async move {
        tokio::time::sleep(WAKE_WAIT).await;
        let mut inner = daemon.lock();
        if inner.agents.get(&pane_id).and_then(|a| a.sleep) != Some(Sleep::Waking) {
            return;
        }
        let dropped = inner.panes.get_mut(&pane_id).map_or(0, |p| std::mem::take(&mut p.sleep.queued).len());
        set_phase(&mut inner, &pane_id, None);
        let lost = if dropped > 0 { format!("; {dropped} bytes of queued input were not sent") } else { String::new() };
        Daemon::diagnostic(&mut inner, DiagnosticLevel::Warning, "sleep", format!("pane {pane_id}: the resumed agent sent no hook event in 30 s{lost}"));
    });
}

/// Whether a hook event of the pane counts. While the agent sleeps, events come only from the process that
/// ends; while it wakes, only events that fired after that process ended count.
pub fn hook_counts(inner: &Inner, pane_id: &str, at_ms: u64) -> bool {
    match inner.agents.get(pane_id).and_then(|a| a.sleep) {
        None => true,
        Some(Sleep::Asleep) => false,
        Some(Sleep::Waking) => inner.panes.get(pane_id).is_some_and(|p| p.sleep.ending_pid.is_none() && at_ms >= p.sleep.hooks_after_ms),
    }
}

/// The first hook event of the resumed agent: the pane is awake, and the input that waited goes to the agent.
pub fn woke(daemon: &Arc<Daemon>, inner: &mut Inner, pane_id: &str) {
    if inner.agents.get(pane_id).and_then(|a| a.sleep) != Some(Sleep::Waking) {
        return;
    }
    set_phase(inner, pane_id, None);
    let queued = inner.panes.get_mut(pane_id).map(|p| std::mem::take(&mut p.sleep.queued)).unwrap_or_default();
    if !queued.is_empty() {
        deliver_when_quiet(daemon, pane_id.to_string(), queued);
    }
}

fn deliver_when_quiet(daemon: &Arc<Daemon>, pane_id: Id, bytes: Vec<u8>) {
    let daemon = daemon.clone();
    daemon.rt.clone().spawn(async move {
        let started = now_ms();
        loop {
            tokio::time::sleep(Duration::from_millis(100)).await;
            let mut inner = daemon.lock();
            let Some(pane) = inner.panes.get(&pane_id) else { return };
            if pending_action(pane.last_output_ms, now_ms(), started) != Pending::Wait {
                let _ = write_input(&mut inner, &pane_id, &bytes);
                return;
            }
        }
    });
}

/// Input for a pane: to its terminal, or, while its agent sleeps, into the queue, and a wake.
pub fn send_input(daemon: &Arc<Daemon>, inner: &mut Inner, pane_id: &str, bytes: &[u8]) -> Result<(), RpcError> {
    match inner.agents.get(pane_id).and_then(|a| a.sleep) {
        None => write_input(inner, pane_id, bytes),
        Some(phase) => {
            if let Some(pane) = inner.panes.get_mut(pane_id) {
                pane.sleep.queued.extend_from_slice(bytes);
            }
            match phase {
                Sleep::Asleep => wake(daemon, inner, pane_id),
                Sleep::Waking => Ok(()),
            }
        }
    }
}

fn write_input(inner: &mut Inner, pane_id: &str, bytes: &[u8]) -> Result<(), RpcError> {
    let pane = inner.panes.get_mut(pane_id).ok_or_else(|| err(ErrorCode::NotFound, "pane not found"))?;
    let pty = pane.pty.clone().ok_or_else(|| err(ErrorCode::NotFound, "pane not live"))?;
    if let Some(draft) = draft_after(bytes) {
        pane.sleep.draft = draft;
        pane.sleep.input_at_ms = now_ms();
    }
    pty.write(bytes).map_err(internal)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn idle() -> Facts {
        Facts {
            state: AgentState::Idle,
            hooked: true,
            subagent_runs: false,
            attention_open: false,
            work_child: false,
            busy: false,
            draft: false,
            on_screen: false,
            resumable: true,
            keep_awake: false,
            under_shell: true,
        }
    }

    fn after_idle(f: Facts) -> Option<Awake> {
        blocker(&f, Ask::AfterIdle)
    }

    #[test]
    fn an_idle_or_done_agent_may_sleep() {
        assert_eq!(after_idle(idle()), None);
        assert_eq!(after_idle(Facts { state: AgentState::Done, ..idle() }), None, "a done agent sleeps and keeps its done mark");
    }

    #[test]
    fn rule_1_only_an_idle_or_done_agent_sleeps() {
        for state in [AgentState::Working, AgentState::Waiting, AgentState::Unknown] {
            assert_eq!(after_idle(Facts { state, ..idle() }), Some(Awake::NotIdle), "{state:?}");
        }
    }

    #[test]
    fn rule_2_a_subagent_or_an_open_attention_item_keeps_it_awake() {
        assert_eq!(after_idle(Facts { subagent_runs: true, ..idle() }), Some(Awake::Subagent), "edge 3: a background subagent after the turn");
        assert_eq!(after_idle(Facts { attention_open: true, ..idle() }), Some(Awake::Attention));
    }

    #[test]
    fn rule_3_a_child_process_keeps_it_awake() {
        assert_eq!(after_idle(Facts { work_child: true, ..idle() }), Some(Awake::Child), "edge 2: a dev server or a background shell");
    }

    #[test]
    fn rule_4_cpu_use_keeps_it_awake() {
        assert_eq!(after_idle(Facts { busy: true, ..idle() }), Some(Awake::Cpu));
    }

    #[test]
    fn rule_5_input_that_was_not_sent_keeps_it_awake() {
        assert_eq!(after_idle(Facts { draft: true, ..idle() }), Some(Awake::Draft), "edge 1: half a prompt");
        assert_eq!(blocker(&Facts { draft: true, ..idle() }, Ask::Now), Some(Awake::Draft), "not even on request");
    }

    #[test]
    fn rule_6_a_pane_on_screen_stays_awake() {
        assert_eq!(after_idle(Facts { on_screen: true, ..idle() }), Some(Awake::OnScreen), "edge 4");
    }

    #[test]
    fn rule_7_the_session_must_resume() {
        assert_eq!(after_idle(Facts { resumable: false, ..idle() }), Some(Awake::NoSession));
    }

    #[test]
    fn rule_8_keep_awake_keeps_it_awake() {
        assert_eq!(after_idle(Facts { keep_awake: true, ..idle() }), Some(Awake::KeepAwake));
    }

    #[test]
    fn an_agent_with_no_hooks_never_sleeps() {
        assert_eq!(after_idle(Facts { hooked: false, ..idle() }), Some(Awake::NoHooks), "edge 12: its idle state is only estimated");
    }

    #[test]
    fn a_dead_or_exited_agent_has_nothing_to_sleep() {
        for state in [AgentState::Dead, AgentState::Exited] {
            assert_eq!(after_idle(Facts { state, ..idle() }), Some(Awake::NotIdle), "edge 13: {state:?}");
        }
        assert_eq!(after_idle(Facts { under_shell: false, ..idle() }), Some(Awake::NoProcess), "the agent is the pane process, or it is gone");
    }

    #[test]
    fn a_sleep_on_request_skips_only_the_rules_that_guess_a_wish() {
        let wished = Facts { busy: true, on_screen: true, keep_awake: true, ..idle() };
        assert_eq!(blocker(&wished, Ask::Now), None);
        for f in [Facts { work_child: true, ..idle() }, Facts { subagent_runs: true, ..idle() }, Facts { resumable: false, ..idle() }] {
            assert!(blocker(&f, Ask::Now).is_some(), "{f:?}");
        }
    }

    fn stamp(state_at_ms: u64, input_at_ms: u64) -> Stamp {
        Stamp { state: AgentState::Idle, state_at_ms, input_at_ms, pid: Some(7) }
    }

    #[test]
    fn the_idle_clock_starts_again_at_any_change() {
        let c = advance(None, stamp(1, 0), true, 100).unwrap();
        let later = advance(Some(c), stamp(1, 0), true, 900).unwrap();
        assert_eq!(later.since_ms, 100, "nothing changed");
        assert!(due(&later, 800, 900) && !due(&later, 801, 900));
        assert_eq!(advance(Some(later), stamp(2, 0), true, 950).unwrap().since_ms, 950, "a hook event");
        assert_eq!(advance(Some(later), stamp(1, 5), true, 950).unwrap().since_ms, 950, "input");
        assert_eq!(advance(Some(later), Stamp { pid: Some(8), ..stamp(1, 0) }, true, 950).unwrap().since_ms, 950, "a new process");
        assert_eq!(advance(Some(later), stamp(1, 0), false, 950), None, "a rule failed");
    }

    #[test]
    fn the_period_comes_from_the_config_or_the_test_override() {
        assert_eq!(period_ms(60, None), Some(3_600_000));
        assert_eq!(period_ms(0, None), None, "0 turns sleeping off");
        assert_eq!(period_ms(60, Some("1500")), Some(1500));
        assert_eq!(period_ms(60, Some("x")), Some(3_600_000));
    }

    #[test]
    fn only_input_that_ends_with_enter_sends_the_line() {
        assert_eq!(draft_after(b"fix the bug"), Some(true));
        assert_eq!(draft_after(b"fix the bug\r"), Some(false));
        assert_eq!(draft_after(b"\x1b[200~a\nb\x1b[201~\r"), Some(false), "a bracketed paste that submits");
        assert_eq!(draft_after(b"\x1b[I"), None, "a focus report is no typing");
        assert_eq!(draft_after(b"x\x1b[O"), Some(true));
    }

    #[test]
    fn a_snapshot_keeps_its_size_and_bytes() {
        let file = encode_snapshot(120, 30, b"\x1b[31mred\n");
        assert_eq!(decode_snapshot(&file), Some((120, 30, &b"\x1b[31mred\n"[..])));
        assert_eq!(decode_snapshot(b"no header"), None);
    }
}
