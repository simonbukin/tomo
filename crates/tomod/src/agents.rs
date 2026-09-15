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

    fn plan(kind: AgentKind, command: &str, args: &[&str], resume: Option<&str>, extra: &[&str]) -> SpawnPlan {
        let owned = |list: &[&str]| list.iter().map(|a| a.to_string()).collect::<Vec<_>>();
        let cmd = AgentCommand { command: command.into(), args: owned(args) };
        spawn_plan(kind, &cmd, resume, Path::new("/d/claude-hooks.json"), Path::new("/d/tomo-status.ts"), &owned(extra))
    }

    fn state_of(kind: AgentKind, payload: Value) -> Option<AgentState> {
        hook_outcome(kind, &payload).state
    }

    #[test]
    fn claude_spawn_plan_passes_settings_and_a_new_session_id() {
        let fresh = plan(AgentKind::Claude, "claude", &["--model", "opus"], None, &["--verbose"]);
        let id = fresh.session_ref.clone().unwrap();
        assert!(uuid::Uuid::parse_str(&id).is_ok(), "{id}");
        assert_eq!(fresh.argv, ["claude", "--model", "opus", "--settings", "/d/claude-hooks.json", "--session-id", id.as_str(), "--verbose"]);
        assert_ne!(plan(AgentKind::Claude, "claude", &[], None, &[]).session_ref, fresh.session_ref);
        let resumed = plan(AgentKind::Claude, "claude", &[], Some("s1"), &[]);
        assert_eq!(resumed.argv, ["claude", "--settings", "/d/claude-hooks.json", "--resume", "s1"]);
        assert_eq!(resumed.session_ref.as_deref(), Some("s1"));
    }

    #[test]
    fn codex_spawn_plan_has_no_session_until_a_hook_reports_one() {
        let fresh = plan(AgentKind::Codex, "codex", &["--full-auto"], None, &["-m", "o3"]);
        assert_eq!(fresh.argv, ["codex", "--full-auto", "-m", "o3"]);
        assert_eq!(fresh.session_ref, None);
        let resumed = plan(AgentKind::Codex, "codex", &["--full-auto"], Some("019a"), &["-m", "o3"]);
        assert_eq!(resumed.argv, ["codex", "--full-auto", "resume", "019a", "-m", "o3"]);
        let last = plan(AgentKind::Codex, "codex", &[], Some("--last"), &[]);
        assert_eq!(last.argv, ["codex", "resume", "--last"]);
        assert_eq!(last.session_ref.as_deref(), Some("--last"), "the restore fallback flag comes back as a session reference");
    }

    #[test]
    fn pi_spawn_plan_loads_the_extension_and_resumes_by_session_ref() {
        let fresh = plan(AgentKind::Pi, "pi", &[], None, &[]);
        let id = fresh.session_ref.clone().unwrap();
        assert!(uuid::Uuid::parse_str(&id).is_ok(), "{id}");
        assert_eq!(fresh.argv, ["pi", "-e", "/d/tomo-status.ts", "--session-id", id.as_str()]);
        let file = "/h/.pi/agent/sessions/--w--/2026_s.jsonl";
        let resumed = plan(AgentKind::Pi, "pi", &[], Some(file), &["--model", "x"]);
        assert_eq!(resumed.argv, ["pi", "-e", "/d/tomo-status.ts", "--session", file, "--model", "x"]);
        assert_eq!(resumed.session_ref.as_deref(), Some(file));
    }

    #[test]
    fn shell_line_quotes_only_what_the_shell_would_split() {
        let argv: Vec<String> = ["/Applications/My Tools/claude", "--settings", "/d/claude-hooks.json", "--resume", "it's"].map(String::from).to_vec();
        assert_eq!(shell_line(&argv), "'/Applications/My Tools/claude' --settings /d/claude-hooks.json --resume 'it'\\''s'");
        assert_eq!(shell_quote(""), "''");
        assert_eq!(shell_quote("a=b:c@d%e+f,g"), "a=b:c@d%e+f,g");
        assert_eq!(shell_quote("$HOME"), "'$HOME'");
    }

    #[test]
    fn claude_and_codex_share_one_hook_table() {
        use AgentState::*;
        let table = [
            ("SessionStart", Some(Idle)),
            ("UserPromptSubmit", Some(Working)),
            ("PreToolUse", Some(Working)),
            ("PostToolUse", Some(Working)),
            ("PostToolUseFailure", Some(Working)),
            ("PreCompact", Some(Working)),
            ("PermissionRequest", Some(Waiting)),
            ("Stop", Some(Idle)),
            ("StopFailure", Some(Idle)),
            ("SessionEnd", Some(Exited)),
            ("PostCompact", None),
            ("SubagentStart", None),
            ("SubagentStop", None),
            ("Interrupt", None),
            ("", None),
        ];
        for kind in [AgentKind::Claude, AgentKind::Codex] {
            for (event, want) in table {
                assert_eq!(state_of(kind, serde_json::json!({ "hook_event_name": event, "session_id": "s" })), want, "{kind:?} {event}");
            }
            for t in ["permission_prompt", "elicitation_dialog", "elicitation_url_dialog", "agent_needs_input"] {
                assert_eq!(state_of(kind, serde_json::json!({ "hook_event_name": "Notification", "notification_type": t })), Some(Waiting), "{t}");
            }
            for t in ["idle_prompt", "auth_success", ""] {
                assert_eq!(state_of(kind, serde_json::json!({ "hook_event_name": "Notification", "notification_type": t })), None, "{t}");
            }
        }
    }

    #[test]
    fn hook_session_ref_ignores_missing_and_empty_ids() {
        assert_eq!(hook_outcome(AgentKind::Codex, &serde_json::json!({ "hook_event_name": "Stop", "session_id": "" })).session_ref, None);
        assert_eq!(hook_outcome(AgentKind::Codex, &serde_json::json!({ "hook_event_name": "Stop", "session_id": 7 })).session_ref, None);
        let o = hook_outcome(AgentKind::Codex, &serde_json::json!({ "hook_event_name": "UserPromptSubmit", "session_id": "019a" }));
        assert_eq!((o.state, o.session_ref.as_deref()), (Some(AgentState::Working), Some("019a")));
        assert_eq!(state_of(AgentKind::Claude, serde_json::json!({ "event": "agent_start" })), None, "a Pi payload means nothing to the Claude table");
        assert_eq!(state_of(AgentKind::Pi, serde_json::json!({ "hook_event_name": "Stop" })), None, "a Claude payload means nothing to the Pi table");
    }

    #[test]
    fn pi_event_table() {
        use AgentState::*;
        let table = [
            ("session_start", None, Some(Idle)),
            ("agent_start", None, Some(Working)),
            ("ui_prompt_end", None, Some(Working)),
            ("ui_prompt_start", None, Some(Waiting)),
            ("agent_settled", None, Some(Idle)),
            ("session_shutdown", Some("quit"), Some(Exited)),
            ("session_shutdown", Some("reload"), None),
            ("session_shutdown", None, None),
            ("agent_end", None, None),
            ("turn_end", None, None),
        ];
        for (event, reason, want) in table {
            assert_eq!(state_of(AgentKind::Pi, serde_json::json!({ "event": event, "reason": reason })), want, "{event} {reason:?}");
        }
        let without_file = hook_outcome(AgentKind::Pi, &serde_json::json!({ "event": "session_start", "session_id": "id", "session_file": "" }));
        assert_eq!(without_file.session_ref.as_deref(), Some("id"));
    }

    #[test]
    fn installed_hook_events_all_translate_to_a_state() {
        let sorted_keys = |v: &Value| {
            let mut keys: Vec<String> = v.as_object().unwrap().keys().cloned().collect();
            keys.sort();
            keys
        };
        let claude = claude_hooks_settings(Path::new("/opt/My Tomo/tomo"));
        let claude_events = sorted_keys(&claude["hooks"]);
        assert_eq!(claude_events, ["Notification", "PermissionRequest", "PostToolUse", "PreToolUse", "SessionEnd", "SessionStart", "Stop", "UserPromptSubmit"]);
        assert_eq!(claude["hooks"]["PreToolUse"][0]["matcher"], "*");
        assert!(claude["hooks"]["Stop"][0].get("matcher").is_none());
        assert_eq!(claude["hooks"]["Stop"][0]["hooks"][0]["command"], "'/opt/My Tomo/tomo' hook claude");
        let codex = codex_hooks_entries(Path::new("/usr/local/bin/tomo"));
        let codex_events = sorted_keys(&codex);
        assert_eq!(codex_events, ["PermissionRequest", "PostToolUse", "PreToolUse", "SessionStart", "Stop", "UserPromptSubmit"], "no SessionEnd: only the process monitor sees Codex exit");
        assert_eq!(codex["Stop"][0]["hooks"][0]["command"], "/usr/local/bin/tomo hook codex");
        for event in claude_events.iter().filter(|e| *e != "Notification").chain(&codex_events) {
            assert!(state_of(AgentKind::Claude, serde_json::json!({ "hook_event_name": event })).is_some(), "{event}");
        }
    }
}
