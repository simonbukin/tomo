use super::{str_field, HookOutcome, Program, Provider};
use crate::agents::shell_quote;
use serde_json::Value;
use std::path::{Path, PathBuf};
use tomo_proto::{AgentKind, AgentState};

pub static PROVIDER: Provider = Provider {
    kind: AgentKind::Claude,
    flags,
    resume_without_session: None,
    hook_outcome,
    detects,
    nested_env: &["CLAUDECODE", "CLAUDE_CODE_*"],
};

fn detects(p: &Program) -> bool {
    p.name == "claude" || p.argv0 == "claude"
}

const SETTINGS_FILE: &str = "claude-hooks.json";

fn settings_path(launch_dir: &Path) -> PathBuf {
    launch_dir.join(SETTINGS_FILE)
}

fn flags(resume: Option<&str>, launch_dir: &Path) -> (Vec<String>, Option<String>) {
    let mut args = vec!["--settings".to_string(), settings_path(launch_dir).to_string_lossy().into_owned()];
    match resume {
        Some(r) => {
            args.extend(["--resume".to_string(), r.to_string()]);
            (args, Some(r.to_string()))
        }
        None => {
            let id = uuid::Uuid::new_v4().to_string();
            args.extend(["--session-id".to_string(), id.clone()]);
            (args, Some(id))
        }
    }
}

/// Codex speaks the same hook protocol, so it uses this table too.
pub fn hook_outcome(payload: &Value) -> HookOutcome {
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

pub fn hooks_settings(tomo_bin: &Path) -> Value {
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
