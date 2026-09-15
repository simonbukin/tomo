use super::{claude, Provider};
use crate::agents::shell_quote;
use serde_json::{Map, Value};
use std::path::Path;

pub static PROVIDER: Provider = Provider {
    flags,
    resume_without_session: Some("--last"),
    hook_outcome: claude::hook_outcome,
};

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
