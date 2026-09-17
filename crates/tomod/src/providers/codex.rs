use super::{claude, Gap, Program, Provider};
use crate::agents::shell_quote;
use anyhow::Result;
use serde_json::{Map, Value};
use std::path::Path;
use tomo_proto::{AgentKind, AgentSession, IntegrationLevel};

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
    sessions,
};

/// Codex keeps `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`, with the cwd in
/// the first line. The newest 300 files are enough for one worktree.
fn sessions(home: &Path, cwd: &Path) -> Vec<AgentSession> {
    let mut recent = super::jsonl_files(&home.join(".codex").join("sessions"), 3);
    recent.sort_by_key(|p| std::cmp::Reverse(std::fs::metadata(p).and_then(|m| m.modified()).ok()));
    recent.iter().take(300).filter_map(|p| parse_session(p, cwd)).collect()
}

fn text_of(content: &Value) -> Option<String> {
    content.as_array()?.iter().find_map(|p| (p.get("type")?.as_str()? == "input_text").then(|| p.get("text")?.as_str().map(str::to_string))?)
}

/// Parses one rollout file. `None` when its cwd is not `cwd`.
pub fn parse_session(path: &Path, cwd: &Path) -> Option<AgentSession> {
    let lines = super::read_head(path);
    let meta: Value = serde_json::from_str(lines.first()?).ok()?;
    let payload = meta.get("payload")?;
    if Path::new(payload.get("cwd")?.as_str()?) != cwd {
        return None;
    }
    let id = payload.get("id").and_then(Value::as_str)?.to_string();
    let mut title = None;
    let mut turns = 0u32;
    for line in lines.iter().skip(1) {
        let Ok(v) = serde_json::from_str::<Value>(line) else { continue };
        let p = v.get("payload");
        let kind = v.get("type").and_then(Value::as_str);
        let user_message = kind == Some("event_msg") && p.and_then(|p| p.get("type")).and_then(Value::as_str) == Some("user_message");
        let user_item = kind == Some("response_item") && p.and_then(|p| p.get("role")).and_then(Value::as_str) == Some("user");
        if user_message || user_item {
            turns += 1;
            if title.is_none() {
                let text = if user_message {
                    p.and_then(|p| p.get("message")).and_then(Value::as_str).map(str::to_string)
                } else {
                    p.and_then(|p| p.get("content")).and_then(text_of)
                };
                title = text.filter(|t| super::is_prompt(t)).map(|t| super::clip(&t));
            }
        }
    }
    Some(AgentSession { kind: AgentKind::Codex, id, title, branch: None, updated_at_ms: super::modified_at_ms(path)?, turns, path: path.to_path_buf() })
}

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
            let snake: String = event
                .chars()
                .enumerate()
                .map(|(i, c)| if c.is_uppercase() && i > 0 { format!("_{}", c.to_lowercase()) } else { c.to_lowercase().to_string() })
                .collect();
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
        let trust = |entries: &[(&str, usize)]| {
            entries.iter().map(|(event, idx)| format!("\"{}:{event}:{idx}:0\" = \"trusted\"\n", file.display())).collect::<String>()
        };
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
