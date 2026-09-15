use super::{str_field, HookOutcome, Program, Provider};
use serde_json::Value;
use std::path::{Path, PathBuf};
use tomo_proto::{AgentKind, AgentState};

pub static PROVIDER: Provider = Provider {
    kind: AgentKind::Pi,
    flags,
    resume_without_session: None,
    hook_outcome,
    detects,
};

fn detects(p: &Program) -> bool {
    p.name == "pi" || p.argv0 == "pi" || p.cmd.contains("pi-coding-agent")
}

const EXTENSION_FILE: &str = "tomo-status.ts";

fn extension_path(launch_dir: &Path) -> PathBuf {
    launch_dir.join(EXTENSION_FILE)
}

fn flags(resume: Option<&str>, launch_dir: &Path) -> (Vec<String>, Option<String>) {
    let mut args = vec!["-e".to_string(), extension_path(launch_dir).to_string_lossy().into_owned()];
    match resume {
        Some(r) => {
            args.extend(["--session".to_string(), r.to_string()]);
            (args, Some(r.to_string()))
        }
        None => {
            let id = uuid::Uuid::new_v4().to_string();
            args.extend(["--session-id".to_string(), id.clone()]);
            (args, Some(id))
        }
    }
}

fn hook_outcome(payload: &Value) -> HookOutcome {
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
