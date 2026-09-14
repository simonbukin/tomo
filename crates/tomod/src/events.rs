//! Typed workflow events and the hooks that react to them.
//!
//! Every event becomes a [`HookEvent`] envelope. Hooks configured for that
//! event run as ordinary processes with the envelope on stdin and in
//! `TOMO_EVENT_JSON`. Only `worktree.before_archive` is awaited; it is a gate.
//! Everything else runs detached so the daemon never waits on user scripts.

use crate::daemon::{Daemon, Inner, WorktreeState};
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;
use tomo_proto::*;

const OUTPUT_TAIL: usize = 4 * 1024;

pub fn worktree_payload(inner: &Inner, w: &WorktreeState) -> HookWorktree {
    HookWorktree {
        id: w.id.clone(),
        path: w.path.clone(),
        repo_id: w.repo_id.clone(),
        repo_path: inner.repos.iter().find(|r| r.id == w.repo_id).map(|r| r.path.clone()).unwrap_or_default(),
        branch: w.branch.clone(),
        name: Daemon::worktree_view(inner, w).name,
        state: w.metadata.state.clone(),
        project: w.metadata.project.clone(),
        tags: w.metadata.tags.clone(),
    }
}

pub fn envelope(inner: &Inner, event: &str, worktree_id: Option<&str>) -> HookEvent {
    HookEvent {
        event: event.to_string(),
        at_ms: now_ms(),
        worktree: worktree_id.and_then(|id| inner.worktrees.get(id)).map(|w| worktree_payload(inner, w)),
        ..Default::default()
    }
}

pub fn matching_hooks(config: &Config, event: &HookEvent) -> Vec<HookDef> {
    config
        .hooks
        .iter()
        .filter(|h| h.event == event.event)
        .filter(|h| match &h.state {
            Some(wanted) => event.worktree.as_ref().and_then(|w| w.state.as_deref()) == Some(wanted.as_str()),
            None => true,
        })
        .cloned()
        .collect()
}

pub fn hook_env(event: &HookEvent) -> Vec<(String, String)> {
    let mut env = vec![("TOMO_EVENT".to_string(), event.event.clone()), ("TOMO_EVENT_JSON".to_string(), serde_json::to_string(event).unwrap_or_default())];
    if let Some(w) = &event.worktree {
        env.push(("TOMO_WORKTREE_ID".into(), w.id.clone()));
        env.push(("TOMO_WORKTREE_PATH".into(), w.path.to_string_lossy().into_owned()));
        env.push(("TOMO_REPO_PATH".into(), w.repo_path.to_string_lossy().into_owned()));
        env.push(("TOMO_BRANCH".into(), w.branch.clone().unwrap_or_default()));
        env.push(("TOMO_STATE".into(), w.state.clone().unwrap_or_default()));
    }
    if let Some(p) = &event.pane {
        env.push(("TOMO_PANE_ID".into(), p.id.clone()));
    }
    if let Some(a) = &event.agent {
        env.push(("TOMO_AGENT_KIND".into(), a.kind.label().to_lowercase()));
        env.push(("TOMO_AGENT_STATE".into(), a.state.name().to_string()));
    }
    env
}

/// Last `OUTPUT_TAIL` bytes as text, cut only on a UTF-8 character boundary.
pub fn tail(bytes: &[u8]) -> String {
    let text = String::from_utf8_lossy(bytes);
    let mut start = text.len().saturating_sub(OUTPUT_TAIL);
    while start < text.len() && !text.is_char_boundary(start) {
        start += 1;
    }
    text[start..].trim().to_string()
}

/// Runs one hook to completion and returns its record. Never panics on a bad command.
pub async fn run_process(hook: &HookDef, event: &HookEvent, cwd: Option<&Path>, socket: &Path, tomo_bin: &Path) -> HookRun {
    let started = now_ms();
    let json = serde_json::to_vec(event).unwrap_or_default();
    let mut cmd = tokio::process::Command::new("sh");
    cmd.arg("-c").arg(&hook.command);
    if let Some(dir) = cwd.filter(|d| d.is_dir()) {
        cmd.current_dir(dir);
    }
    for (k, v) in hook_env(event) {
        cmd.env(k, v);
    }
    cmd.env("TOMO_SOCKET", socket).env("TOMO_BIN", tomo_bin);
    cmd.stdin(std::process::Stdio::piped()).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::piped());
    cmd.process_group(0);
    let (exit_code, output, timed_out) = match cmd.spawn() {
        Ok(mut child) => {
            let pgid = child.id().map(|p| p as i32);
            if let Some(mut stdin) = child.stdin.take() {
                use tokio::io::AsyncWriteExt;
                let _ = stdin.write_all(&json).await;
            }
            match tokio::time::timeout(Duration::from_secs(hook.timeout_s), child.wait_with_output()).await {
                Ok(Ok(out)) => (out.status.code(), [out.stdout, out.stderr].concat(), false),
                Ok(Err(e)) => (None, e.to_string().into_bytes(), false),
                Err(_) => {
                    if let Some(pgid) = pgid {
                        kill_group(pgid);
                    }
                    (None, format!("timed out after {} s; process group killed", hook.timeout_s).into_bytes(), true)
                }
            }
        }
        Err(e) => (None, e.to_string().into_bytes(), false),
    };
    HookRun {
        event: event.event.clone(),
        command: hook.command.clone(),
        worktree_id: event.worktree.as_ref().map(|w| w.id.clone()),
        started_at_ms: started,
        duration_ms: now_ms().saturating_sub(started),
        exit_code,
        ok: exit_code == Some(0) && !timed_out,
        output_tail: tail(&output),
    }
}

/// Kills every process in the hook's process group, so children and grandchildren die too.
pub fn kill_group(pgid: i32) {
    unsafe {
        libc::killpg(pgid, libc::SIGKILL);
    }
}

pub fn append_log(path: &Path, run: &HookRun) {
    let line = serde_json::to_string(run).unwrap_or_default();
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
        use std::io::Write;
        let _ = writeln!(f, "{line}");
    }
}

pub fn read_log(path: &Path, limit: usize) -> Vec<HookRun> {
    let text = std::fs::read_to_string(path).unwrap_or_default();
    let mut runs: Vec<HookRun> = text.lines().rev().filter_map(|l| serde_json::from_str(l).ok()).take(limit).collect();
    runs.reverse();
    runs
}

impl Daemon {
    /// Emits a workflow event: runs async hooks detached and pane hooks as visible panes.
    pub fn dispatch(self: &Arc<Self>, event: HookEvent) {
        let (hooks, cwd) = {
            let inner = self.lock();
            let hooks = matching_hooks(&inner.config, &event);
            let cwd = event.worktree.as_ref().map(|w| w.path.clone());
            (hooks, cwd)
        };
        for hook in hooks {
            match hook.mode {
                HookMode::Pane => self.run_hook_in_pane(&hook, &event),
                HookMode::Async => {
                    let daemon = self.clone();
                    let event = event.clone();
                    let cwd = cwd.clone();
                    tokio::spawn(async move {
                        let run = run_process(&hook, &event, cwd.as_deref(), &daemon.paths.socket, &daemon.tomo_bin).await;
                        daemon.record_hook_run(run);
                    });
                }
            }
        }
    }

    /// Runs `worktree.before_archive` hooks and returns the first failure, if any.
    pub async fn gate(self: &Arc<Self>, event: HookEvent) -> Result<(), HookRun> {
        let (hooks, cwd) = {
            let inner = self.lock();
            (matching_hooks(&inner.config, &event), event.worktree.as_ref().map(|w| w.path.clone()))
        };
        for hook in hooks.into_iter().filter(|h| h.mode == HookMode::Async) {
            let run = run_process(&hook, &event, cwd.as_deref(), &self.paths.socket, &self.tomo_bin).await;
            let ok = run.ok;
            self.record_hook_run(run.clone());
            if !ok {
                return Err(run);
            }
        }
        Ok(())
    }

    pub fn record_hook_run(&self, run: HookRun) {
        append_log(&self.paths.hook_log, &run);
        if !run.ok {
            tracing::warn!("hook {} for {} failed: {}", run.command, run.event, run.output_tail.lines().last().unwrap_or(""));
        }
        let mut inner = self.lock();
        if !run.ok {
            Self::emit(&mut inner, Event::Notice { level: NoticeLevel::Warning, message: format!("hook failed ({}): {}", run.event, run.command) });
            let mut ev = crate::activity::event(ActivityKind::HookFailed, run.worktree_id.as_deref(), format!("hook failed: {}", run.event));
            ev.detail = Some(run.command.clone());
            ev.payload = serde_json::json!({ "command": run.command, "exit_code": run.exit_code, "output_tail": run.output_tail.lines().last().unwrap_or("") });
            Self::record(&mut inner, ev);
        }
        Self::emit(&mut inner, Event::HookRan { run });
    }

    fn run_hook_in_pane(self: &Arc<Self>, hook: &HookDef, event: &HookEvent) {
        let Some(w) = &event.worktree else { return };
        let mut inner = self.lock();
        let env = hook_env(event);
        let exports: String = env.iter().map(|(k, v)| format!("export {}={}; ", k, crate::agents::shell_quote(v))).collect();
        let line = format!("{exports}{}", hook.command);
        let title = format!("hook: {}", event.event);
        if let Err(e) = self.spawn_in_worktree(&mut inner, &w.id, w.path.clone(), None, None, SplitDirection::Horizontal, None, Some(title), None).map(|(_, pane_id)| {
            if let Some(pane) = inner.panes.get_mut(&pane_id) {
                pane.pending_line = Some(line);
            }
            if let Some(pane) = inner.panes.get(&pane_id) {
                if pane.pty.is_some() {
                    self.type_pending_when_quiet(pane_id.clone());
                }
            }
        }) {
            tracing::warn!("pane hook for {}: {}", event.event, e.message);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg(hooks: Vec<HookDef>) -> Config {
        Config {
            shell: "sh".into(),
            editor_command: vec![],
            worktree_parent_dir: None,
            resource_warning_bytes: 0,
            scrollback_lines: 0,
            font_family: String::new(),
            font_size: 0,
            theme: String::new(),
            max_panes_per_tab: 4,
            keybindings: Default::default(),
            agents: Default::default(),
            archive_cleanup: vec![],
            states: vec![],
            hooks,
        }
    }

    fn hook(event: &str, state: Option<&str>) -> HookDef {
        HookDef { event: event.into(), command: "true".into(), state: state.map(String::from), mode: HookMode::Async, timeout_s: 5 }
    }

    fn wt(state: Option<&str>) -> HookWorktree {
        HookWorktree { id: "w".into(), path: "/tmp".into(), repo_id: "r".into(), repo_path: "/tmp".into(), branch: None, name: "w".into(), state: state.map(String::from), project: None, tags: vec![] }
    }

    #[test]
    fn hooks_match_on_event_and_optional_state() {
        let c = cfg(vec![hook("worktree.state_changed", Some("merged")), hook("worktree.state_changed", None), hook("agent.waiting", None)]);
        let merged = HookEvent { event: "worktree.state_changed".into(), worktree: Some(wt(Some("merged"))), ..Default::default() };
        assert_eq!(matching_hooks(&c, &merged).len(), 2);
        let active = HookEvent { event: "worktree.state_changed".into(), worktree: Some(wt(Some("active"))), ..Default::default() };
        assert_eq!(matching_hooks(&c, &active).len(), 1);
        assert!(matching_hooks(&c, &HookEvent { event: "pane.created".into(), ..Default::default() }).is_empty());
    }

    #[tokio::test]
    async fn run_process_reports_exit_timeout_and_missing_program() {
        let ev = HookEvent { event: "worktree.created".into(), worktree: Some(wt(None)), ..Default::default() };
        let ok = run_process(&HookDef { command: "test \"$TOMO_EVENT\" = worktree.created && cat >/dev/null".into(), ..hook("worktree.created", None) }, &ev, None, Path::new("/tmp/s"), Path::new("tomo")).await;
        assert!(ok.ok, "{:?}", ok.output_tail);
        let bad = run_process(&HookDef { command: "echo boom >&2; exit 3".into(), ..hook("worktree.created", None) }, &ev, None, Path::new("/tmp/s"), Path::new("tomo")).await;
        assert_eq!(bad.exit_code, Some(3));
        assert!(bad.output_tail.contains("boom"));
        let slow = run_process(&HookDef { command: "sleep 5".into(), timeout_s: 1, ..hook("worktree.created", None) }, &ev, None, Path::new("/tmp/s"), Path::new("tomo")).await;
        assert!(!slow.ok && slow.output_tail.contains("timed out"));
    }

    #[test]
    fn tail_never_splits_a_character() {
        let mut text = "日本語".repeat(OUTPUT_TAIL / 3 + 5).into_bytes();
        text.extend_from_slice("😀 end".as_bytes());
        let t = tail(&text);
        assert!(t.ends_with("😀 end"));
        assert!(t.len() <= OUTPUT_TAIL);
        assert!(std::str::from_utf8(t.as_bytes()).is_ok());
        assert_eq!(tail(b"short"), "short");
        assert_eq!(tail(b""), "");
    }

    #[tokio::test]
    async fn timeout_kills_the_whole_process_tree() {
        let marker = std::env::temp_dir().join(format!("tomo-hook-tree-{}", std::process::id()));
        let cmd = format!("(sh -c 'sleep 30; touch {m}' &) ; sleep 30; touch {m}", m = marker.display());
        let ev = HookEvent { event: "worktree.created".into(), worktree: Some(wt(None)), ..Default::default() };
        let run = run_process(&HookDef { command: cmd, timeout_s: 1, ..hook("worktree.created", None) }, &ev, None, Path::new("/tmp/s"), Path::new("tomo")).await;
        assert!(!run.ok && run.output_tail.contains("killed"));
        let out = std::process::Command::new("pgrep").args(["-f", &format!("touch {}", marker.display())]).output().unwrap();
        assert!(out.stdout.is_empty(), "grandchild survived: {}", String::from_utf8_lossy(&out.stdout));
        assert!(!marker.exists());
    }

    #[test]
    fn log_round_trips_last_n() {
        let dir = std::env::temp_dir().join(format!("tomo-hooklog-{}", std::process::id()));
        let _ = std::fs::remove_file(&dir);
        for i in 0..5 {
            append_log(&dir, &HookRun { event: format!("e{i}"), command: "c".into(), worktree_id: None, started_at_ms: i, duration_ms: 0, exit_code: Some(0), ok: true, output_tail: String::new() });
        }
        let runs = read_log(&dir, 2);
        assert_eq!(runs.iter().map(|r| r.event.as_str()).collect::<Vec<_>>(), vec!["e3", "e4"]);
        let _ = std::fs::remove_file(&dir);
    }
}
