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
    nested_env: &[],
};

fn detects(p: &Program) -> bool {
    p.name == "pi" || p.argv0 == "pi" || runs_the_pi_package(p)
}

/// Before `process.title` runs, Pi is a JavaScript runtime with the package
/// script as its first argument. A command that only names the package, such as
/// an editor with a file of that package, is another program.
fn runs_the_pi_package(p: &Program) -> bool {
    matches!(p.argv0, "node" | "bun") && p.cmd.split_whitespace().skip(1).find(|a| !a.starts_with('-')).is_some_and(|script| script.contains("pi-coding-agent"))
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
