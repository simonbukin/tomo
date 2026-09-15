use super::{claude, Program, Provider};
use crate::agents::shell_quote;
use serde_json::{Map, Value};
use std::path::Path;
use tomo_proto::AgentKind;

pub static PROVIDER: Provider = Provider {
    kind: AgentKind::Codex,
    flags,
    resume_without_session: Some("--last"),
    hook_outcome: claude::hook_outcome,
    detects,
};

fn detects(p: &Program) -> bool {
    p.name.starts_with("codex") || p.argv0.starts_with("codex")
}

/// Codex takes the session on the command line, and it reports one only after a
/// trusted hook runs. A pane without a session resumes the newest one in its directory.
fn flags(resume: Option<&str>, _launch_dir: &Path) -> (Vec<String>, Option<String>) {
    match resume {
        Some(r) => (vec!["resume".to_string(), r.to_string()], Some(r.to_string())),
        None => (Vec::new(), None),
    }
}

pub fn hooks_entries(tomo_bin: &Path) -> Value {
    let command = format!("{} hook codex", shell_quote(&tomo_bin.to_string_lossy()));
    let hook = serde_json::json!({ "hooks": [{ "type": "command", "command": command, "timeout": 5 }] });
    let mut map = Map::new();
    for name in ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PermissionRequest", "Stop"] {
        map.insert(name.to_string(), serde_json::json!([hook.clone()]));
    }
    Value::Object(map)
}
