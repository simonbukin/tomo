use super::{claude, Gap, Program, Provider};
use crate::agents::shell_quote;
use anyhow::Result;
use serde_json::{Map, Value};
use std::path::Path;
use tomo_proto::{AgentKind, IntegrationLevel};

pub static PROVIDER: Provider = Provider {
    kind: AgentKind::Codex,
    flags,
    resume_without_session: Some("--last"),
    hook_outcome: claude::hook_outcome,
    detects,
    nested_env: &["CODEX_THREAD_ID", "CODEX_SANDBOX*"],
    write_launch_file: super::no_launch_file,
    install,
    installed,
    gap,
};

const HOOKS_FILE: &str = ".codex/hooks.json";

fn install(home: &Path, tomo_bin: &Path) -> Result<()> {
    super::merge_into_file(&home.join(HOOKS_FILE), &hooks_entries(tomo_bin), "hook codex")
}

fn installed(home: &Path) -> bool {
    std::fs::read_to_string(home.join(HOOKS_FILE)).map(|t| t.contains("hook codex")).unwrap_or(false)
}

fn gap(home: &Path) -> Option<Gap> {
    match (installed(home), hooks_trusted(home)) {
        (true, Some(true)) => None,
        (true, _) => Some(Gap { level: IntegrationLevel::Partial, reason: "hooks installed but not trusted; start Codex and press t in its hooks panel" }),
        (false, _) => Some(Gap { level: IntegrationLevel::ProcessOnly, reason: "run `tomo integrations install`, then trust the hooks in Codex" }),
    }
}

/// Codex runs a hook only after the user trusts it, and it records the trust as
/// a hash entry in `config.toml`. Tomo does not write those entries itself.
fn hooks_trusted(home: &Path) -> Option<bool> {
    let hooks: Value = serde_json::from_str(&std::fs::read_to_string(home.join(HOOKS_FILE)).ok()?).ok()?;
    let config = std::fs::read_to_string(home.join(".codex/config.toml")).unwrap_or_default();
    let events = hooks.get("hooks")?.as_object()?;
    let mut ours = 0;
    let mut trusted = 0;
    for (event, list) in events {
        for (idx, entry) in list.as_array().into_iter().flatten().enumerate() {
            if !entry.to_string().contains("hook codex") {
                continue;
            }
            ours += 1;
            let snake: String = event.chars().enumerate().map(|(i, c)| if c.is_uppercase() && i > 0 { format!("_{}", c.to_lowercase()) } else { c.to_lowercase().to_string() }).collect();
            if config.contains(&format!("hooks.json:{snake}:{idx}:0\"")) {
                trusted += 1;
            }
        }
    }
    Some(ours > 0 && trusted == ours)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codex_trust_needs_every_tomo_entry_in_config() {
        let home = std::env::temp_dir().join(format!("tomo-codex-trust-{}", std::process::id()));
        let codex_dir = home.join(".codex");
        std::fs::create_dir_all(&codex_dir).unwrap();
        assert_eq!(hooks_trusted(&home), None);
        let mut hooks = serde_json::json!({ "hooks": { "Stop": [ { "hooks": [ { "type": "command", "command": "other" } ] } ] } });
        super::super::merge_hooks(&mut hooks, &hooks_entries(Path::new("/bin/tomo")), "hook codex");
        let file = codex_dir.join("hooks.json");
        std::fs::write(&file, hooks.to_string()).unwrap();
        assert_eq!(hooks_trusted(&home), Some(false));
        let trust = |entries: &[(&str, usize)]| entries.iter().map(|(event, idx)| format!("\"{}:{event}:{idx}:0\" = \"trusted\"\n", file.display())).collect::<String>();
        let ours = [("permission_request", 0), ("post_tool_use", 0), ("pre_tool_use", 0), ("session_start", 0), ("stop", 1), ("user_prompt_submit", 0)];
        std::fs::write(codex_dir.join("config.toml"), trust(&ours[..5])).unwrap();
        assert_eq!(hooks_trusted(&home), Some(false));
        std::fs::write(codex_dir.join("config.toml"), trust(&ours)).unwrap();
        assert_eq!(hooks_trusted(&home), Some(true));
        assert!(gap(&home).is_none(), "trusted hooks leave no gap");
        let _ = std::fs::remove_dir_all(&home);
    }
}

fn detects(p: &Program) -> bool {
    is_codex(p.name) || is_codex(p.argv0)
}

/// The binary is `codex` or `codex-<target triple>`. A program whose name only
/// starts with "codex", such as a menu bar app, is another program.
fn is_codex(program: &str) -> bool {
    program == "codex" || program.strip_prefix("codex-").is_some_and(|triple| triple.starts_with("aarch64-") || triple.starts_with("x86_64-"))
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
