use serde_json::Value;
use std::path::Path;
use tomo_proto::{AgentCommand, AgentKind, AgentPresence, AgentReport, AgentState};

/// A weaker source may replace a stronger one only after this much silence.
pub const STALE_MS: u64 = 15 * 60 * 1000;

pub fn merge(current: Option<&AgentPresence>, report: &AgentReport, worktree_id: &str, pid: Option<u32>) -> Option<AgentPresence> {
    let Some(cur) = current else {
        return Some(AgentPresence {
            pane_id: report.pane_id.clone(),
            worktree_id: worktree_id.to_string(),
            kind: report.kind,
            state: report.state.unwrap_or(AgentState::Unknown),
            session_ref: report.session_ref.clone(),
            authority: report.authority,
            updated_at_ms: report.at_ms,
            pid,
        });
    };
    let session_ref = report.session_ref.clone().or_else(|| cur.session_ref.clone());
    let pid = pid.or(cur.pid);
    let stronger = report.authority < cur.authority;
    let same_and_newer = report.authority == cur.authority && report.at_ms >= cur.updated_at_ms;
    let stale = cur.updated_at_ms + STALE_MS < report.at_ms;
    let accept_state = report.state.is_some() && (stronger || same_and_newer || stale);
    let changed = accept_state || session_ref != cur.session_ref || pid != cur.pid || report.kind != cur.kind;
    if !changed {
        return None;
    }
    Some(AgentPresence {
        pane_id: cur.pane_id.clone(),
        worktree_id: cur.worktree_id.clone(),
        kind: if stronger || same_and_newer { report.kind } else { cur.kind },
        state: if accept_state { report.state.unwrap() } else { cur.state },
        session_ref,
        authority: if accept_state { report.authority } else { cur.authority },
        updated_at_ms: if accept_state { report.at_ms } else { cur.updated_at_ms },
        pid,
    })
}

pub struct HookOutcome {
    pub state: Option<AgentState>,
    pub session_ref: Option<String>,
}

pub fn hook_outcome(kind: AgentKind, payload: &Value) -> HookOutcome {
    match kind {
        AgentKind::Pi => pi_outcome(payload),
        AgentKind::Claude | AgentKind::Codex => claude_style_outcome(payload),
    }
}

fn str_field<'a>(v: &'a Value, key: &str) -> Option<&'a str> {
    v.get(key).and_then(Value::as_str).filter(|s| !s.is_empty())
}

fn claude_style_outcome(payload: &Value) -> HookOutcome {
    let event = str_field(payload, "hook_event_name").unwrap_or("");
    let state = match event {
        "SessionStart" => Some(AgentState::Idle),
        "UserPromptSubmit" | "PreToolUse" | "PostToolUse" | "PostToolUseFailure" | "PreCompact" => Some(AgentState::Working),
        "PermissionRequest" => Some(AgentState::Waiting),
        "Notification" => match str_field(payload, "notification_type").unwrap_or("") {
            "permission_prompt" | "elicitation_dialog" | "elicitation_url_dialog" | "agent_needs_input" => Some(AgentState::Waiting),
            _ => None,
        },
        "Stop" | "StopFailure" => Some(AgentState::Idle),
        "SessionEnd" => Some(AgentState::Exited),
        _ => None,
    };
    HookOutcome { state, session_ref: str_field(payload, "session_id").map(str::to_string) }
}

fn pi_outcome(payload: &Value) -> HookOutcome {
    let event = str_field(payload, "event").unwrap_or("");
    let state = match event {
        "session_start" => Some(AgentState::Idle),
        "agent_start" | "ui_prompt_end" => Some(AgentState::Working),
        "ui_prompt_start" => Some(AgentState::Waiting),
        "agent_settled" => Some(AgentState::Idle),
        "session_shutdown" if str_field(payload, "reason") == Some("quit") => Some(AgentState::Exited),
        _ => None,
    };
    let session_ref = str_field(payload, "session_file").or_else(|| str_field(payload, "session_id")).map(str::to_string);
    HookOutcome { state, session_ref }
}

pub struct SpawnPlan {
    pub argv: Vec<String>,
    pub session_ref: Option<String>,
}

pub fn spawn_plan(
    kind: AgentKind,
    cmd: &AgentCommand,
    resume: Option<&str>,
    claude_settings: &Path,
    pi_extension: &Path,
    extra: &[String],
) -> SpawnPlan {
    let mut argv = vec![cmd.command.clone()];
    argv.extend(cmd.args.iter().cloned());
    let session_ref = match kind {
        AgentKind::Claude => {
            argv.extend(["--settings".to_string(), claude_settings.to_string_lossy().into_owned()]);
            match resume {
                Some(r) => {
                    argv.extend(["--resume".to_string(), r.to_string()]);
                    Some(r.to_string())
                }
                None => {
                    let id = uuid::Uuid::new_v4().to_string();
                    argv.extend(["--session-id".to_string(), id.clone()]);
                    Some(id)
                }
            }
        }
        AgentKind::Codex => match resume {
            Some(r) => {
                argv.extend(["resume".to_string(), r.to_string()]);
                Some(r.to_string())
            }
            None => None,
        },
        AgentKind::Pi => {
            argv.extend(["-e".to_string(), pi_extension.to_string_lossy().into_owned()]);
            match resume {
                Some(r) => {
                    argv.extend(["--session".to_string(), r.to_string()]);
                    Some(r.to_string())
                }
                None => {
                    let id = uuid::Uuid::new_v4().to_string();
                    argv.extend(["--session-id".to_string(), id.clone()]);
                    Some(id)
                }
            }
        }
    };
    argv.extend(extra.iter().cloned());
    SpawnPlan { argv, session_ref }
}

pub fn shell_quote(arg: &str) -> String {
    let safe = !arg.is_empty() && arg.chars().all(|c| c.is_ascii_alphanumeric() || "-_./=:@%+,".contains(c));
    if safe {
        arg.to_string()
    } else {
        format!("'{}'", arg.replace('\'', "'\\''"))
    }
}

pub fn shell_line(argv: &[String]) -> String {
    argv.iter().map(|a| shell_quote(a)).collect::<Vec<_>>().join(" ")
}

pub fn claude_hooks_settings(tomo_bin: &Path) -> Value {
    let command = format!("{} hook claude", shell_quote(&tomo_bin.to_string_lossy()));
    let hook = |matcher: Option<&str>| {
        let mut entry = serde_json::json!({ "hooks": [{ "type": "command", "command": command, "timeout": 5 }] });
        if let Some(m) = matcher {
            entry["matcher"] = Value::String(m.to_string());
        }
        serde_json::json!([entry])
    };
    serde_json::json!({
        "hooks": {
            "SessionStart": hook(None),
            "SessionEnd": hook(None),
            "UserPromptSubmit": hook(None),
            "PreToolUse": hook(Some("*")),
            "PostToolUse": hook(Some("*")),
            "PermissionRequest": hook(Some("*")),
            "Notification": hook(None),
            "Stop": hook(None),
        }
    })
}

pub fn codex_hooks_entries(tomo_bin: &Path) -> Value {
    let command = format!("{} hook codex", shell_quote(&tomo_bin.to_string_lossy()));
    let hook = serde_json::json!({ "hooks": [{ "type": "command", "command": command, "timeout": 5 }] });
    let mut map = serde_json::Map::new();
    for name in ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PermissionRequest", "Stop"] {
        map.insert(name.to_string(), serde_json::json!([hook.clone()]));
    }
    Value::Object(map)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tomo_proto::Authority;

    fn report(auth: Authority, state: Option<AgentState>, at: u64) -> AgentReport {
        AgentReport { pane_id: "p".into(), kind: AgentKind::Claude, state, session_ref: None, authority: auth, at_ms: at }
    }

    #[test]
    fn heuristic_does_not_overwrite_fresh_lifecycle_state() {
        let cur = merge(None, &report(Authority::Lifecycle, Some(AgentState::Waiting), 1000), "w", Some(1)).unwrap();
        assert!(merge(Some(&cur), &report(Authority::Heuristic, Some(AgentState::Working), 2000), "w", Some(1)).is_none());
        let after = merge(Some(&cur), &report(Authority::Heuristic, Some(AgentState::Working), 1000 + STALE_MS + 1), "w", Some(1)).unwrap();
        assert_eq!(after.state, AgentState::Working);
    }

    #[test]
    fn stale_lifecycle_message_cannot_rewind() {
        let cur = merge(None, &report(Authority::Lifecycle, Some(AgentState::Idle), 5000), "w", None).unwrap();
        assert!(merge(Some(&cur), &report(Authority::Lifecycle, Some(AgentState::Working), 4000), "w", None).is_none());
        let newer = merge(Some(&cur), &report(Authority::Lifecycle, Some(AgentState::Working), 5000), "w", None).unwrap();
        assert_eq!(newer.state, AgentState::Working);
    }

    #[test]
    fn session_ref_updates_without_state() {
        let cur = merge(None, &report(Authority::Lifecycle, Some(AgentState::Idle), 1), "w", None).unwrap();
        let mut r = report(Authority::Heuristic, None, 2);
        r.session_ref = Some("abc".into());
        let after = merge(Some(&cur), &r, "w", Some(9)).unwrap();
        assert_eq!(after.session_ref.as_deref(), Some("abc"));
        assert_eq!(after.state, AgentState::Idle);
        assert_eq!(after.pid, Some(9));
    }

    #[test]
    fn claude_hook_mapping() {
        let waiting = hook_outcome(AgentKind::Claude, &serde_json::json!({"hook_event_name":"Notification","notification_type":"permission_prompt","session_id":"s1"}));
        assert_eq!(waiting.state, Some(AgentState::Waiting));
        assert_eq!(waiting.session_ref.as_deref(), Some("s1"));
        let idle = hook_outcome(AgentKind::Codex, &serde_json::json!({"hook_event_name":"Stop"}));
        assert_eq!(idle.state, Some(AgentState::Idle));
        let none = hook_outcome(AgentKind::Claude, &serde_json::json!({"hook_event_name":"Notification","notification_type":"idle_prompt"}));
        assert_eq!(none.state, None);
    }

    #[test]
    fn pi_hook_mapping_prefers_session_file() {
        let o = hook_outcome(AgentKind::Pi, &serde_json::json!({"event":"ui_prompt_start","session_id":"id","session_file":"/f.jsonl"}));
        assert_eq!(o.state, Some(AgentState::Waiting));
        assert_eq!(o.session_ref.as_deref(), Some("/f.jsonl"));
        let quit = hook_outcome(AgentKind::Pi, &serde_json::json!({"event":"session_shutdown","reason":"quit"}));
        assert_eq!(quit.state, Some(AgentState::Exited));
    }

    #[test]
    fn spawn_plan_builds_resume_and_fresh_commands() {
        let cmd = AgentCommand { command: "claude".into(), args: vec![] };
        let fresh = spawn_plan(AgentKind::Claude, &cmd, None, Path::new("/s.json"), Path::new("/e.ts"), &[]);
        assert!(fresh.session_ref.is_some());
        assert!(fresh.argv.contains(&"--session-id".to_string()));
        let resumed = spawn_plan(AgentKind::Codex, &AgentCommand { command: "codex".into(), args: vec![] }, Some("abc"), Path::new("/s"), Path::new("/e"), &[]);
        assert_eq!(resumed.argv, vec!["codex", "resume", "abc"]);
        assert_eq!(shell_line(&["a b".to_string(), "c'd".to_string()]), "'a b' 'c'\\''d'");
    }

    fn rep(pane: &str, auth: Authority, state: Option<AgentState>, at: u64) -> AgentReport {
        AgentReport { pane_id: pane.into(), kind: AgentKind::Claude, state, session_ref: None, authority: auth, at_ms: at }
    }

    #[test]
    fn torture_authority_battery() {
        let waiting = merge(None, &rep("p", Authority::Lifecycle, Some(AgentState::Waiting), 10_000), "w", Some(7)).unwrap();
        assert!(merge(Some(&waiting), &rep("p", Authority::Heuristic, Some(AgentState::Working), 11_000), "w", Some(7)).is_none(), "heuristic must not beat fresh lifecycle");
        assert!(merge(Some(&waiting), &rep("p", Authority::Lifecycle, Some(AgentState::Idle), 9_000), "w", Some(7)).is_none(), "older lifecycle is ignored");
        assert!(merge(Some(&waiting), &rep("p", Authority::Report, Some(AgentState::Idle), 12_000), "w", Some(7)).is_none(), "explicit report is weaker than lifecycle");
        let stale = merge(Some(&waiting), &rep("p", Authority::Heuristic, Some(AgentState::Working), 10_000 + STALE_MS + 1), "w", Some(7)).unwrap();
        assert_eq!((stale.state, stale.authority), (AgentState::Working, Authority::Heuristic), "silent lifecycle yields to heuristic");
        let back = merge(Some(&stale), &rep("p", Authority::Lifecycle, Some(AgentState::Idle), 10_000 + STALE_MS + 2), "w", Some(7)).unwrap();
        assert_eq!(back.state, AgentState::Idle, "lifecycle regains authority immediately");
        let exited = merge(Some(&back), &rep("p", Authority::Lifecycle, Some(AgentState::Exited), 10_000 + STALE_MS + 3), "w", None).unwrap();
        assert_eq!(exited.state, AgentState::Exited);
        assert_eq!(exited.pid, Some(7), "pid is kept until a new one is seen");
    }

    #[test]
    fn torture_same_kind_agents_are_independent() {
        let a = merge(None, &rep("a", Authority::Lifecycle, Some(AgentState::Working), 1), "w", Some(1)).unwrap();
        let b = merge(None, &rep("b", Authority::Lifecycle, Some(AgentState::Idle), 1), "w", Some(2)).unwrap();
        let a2 = merge(Some(&a), &rep("a", Authority::Lifecycle, Some(AgentState::Waiting), 2), "w", Some(1)).unwrap();
        assert_eq!(a2.pane_id, "a");
        assert_eq!(b.state, AgentState::Idle);
        assert!(merge(Some(&b), &rep("b", Authority::Heuristic, None, 3), "w", Some(2)).is_none(), "presence-only report with nothing new is a no-op");
    }

    #[test]
    fn torture_resumed_process_rebuilds_presence() {
        let old = merge(None, &rep("p", Authority::Lifecycle, Some(AgentState::Exited), 5), "w", Some(10)).unwrap();
        let mut fresh = rep("p", Authority::Lifecycle, Some(AgentState::Idle), 6);
        fresh.session_ref = Some("sess".into());
        let next = merge(Some(&old), &fresh, "w", Some(11)).unwrap();
        assert_eq!((next.state, next.pid, next.session_ref.as_deref()), (AgentState::Idle, Some(11), Some("sess")));
    }
}
