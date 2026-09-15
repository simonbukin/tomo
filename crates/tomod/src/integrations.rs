use crate::agents;
use anyhow::{Context, Result};
use tomo_proto::{AgentKind, IntegrationLevel, IntegrationStatus};
use serde_json::{Map, Value};
use std::path::Path;

fn merge_hooks(existing: &mut Value, additions: &Value, marker: &str) -> bool {
    let root = match existing {
        Value::Object(m) => m,
        other => {
            *other = Value::Object(Map::new());
            other.as_object_mut().unwrap()
        }
    };
    let hooks = root.entry("hooks").or_insert_with(|| Value::Object(Map::new()));
    if !hooks.is_object() {
        *hooks = Value::Object(Map::new());
    }
    let hooks = hooks.as_object_mut().unwrap();
    let mut changed = false;
    for (event, entries) in additions.as_object().into_iter().flatten() {
        let list = hooks.entry(event.clone()).or_insert_with(|| Value::Array(vec![]));
        if !list.is_array() {
            *list = Value::Array(vec![]);
        }
        let arr = list.as_array_mut().unwrap();
        let wanted = entries.as_array().cloned().unwrap_or_default();
        let current: Vec<Value> = arr.iter().filter(|e| e.to_string().contains(marker)).cloned().collect();
        if current != wanted {
            arr.retain(|e| !e.to_string().contains(marker));
            arr.extend(wanted);
            changed = true;
        }
    }
    changed
}

fn merge_into_file(path: &Path, additions: &Value, marker: &str) -> Result<()> {
    let mut existing: Value = match std::fs::read_to_string(path) {
        Ok(text) if !text.trim().is_empty() => serde_json::from_str(&text).with_context(|| format!("parse {}", path.display()))?,
        _ => Value::Object(Map::new()),
    };
    if merge_hooks(&mut existing, additions, marker) {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(path, serde_json::to_string_pretty(&existing)?)?;
    }
    Ok(())
}

pub fn install(tomo_bin: &Path, pi_source: &str) -> Result<()> {
    let home = dirs::home_dir().context("no home dir")?;
    let claude = agents::claude_hooks_settings(tomo_bin);
    merge_into_file(&home.join(".claude/settings.json"), &claude["hooks"], "hook claude")?;
    let codex = agents::codex_hooks_entries(tomo_bin);
    merge_into_file(&home.join(".codex/hooks.json"), &codex, "hook codex")?;
    let ext_dir = home.join(".pi/agent/extensions");
    std::fs::create_dir_all(&ext_dir)?;
    std::fs::write(ext_dir.join("tomo-status.ts"), pi_source)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn merge_is_additive_and_idempotent() {
        let mut existing = serde_json::json!({ "hooks": { "Stop": [ { "hooks": [ { "type": "command", "command": "other" } ] } ] }, "theme": "dark" });
        let additions = agents::codex_hooks_entries(Path::new("/usr/local/bin/tomo"));
        assert!(merge_hooks(&mut existing, &additions, "hook codex"));
        assert_eq!(existing["hooks"]["Stop"].as_array().unwrap().len(), 2);
        assert_eq!(existing["theme"], "dark");
        assert!(!merge_hooks(&mut existing, &additions, "hook codex"));
        assert_eq!(existing["hooks"]["Stop"].as_array().unwrap().len(), 2);
        let moved = agents::codex_hooks_entries(Path::new("/opt/tomo/bin/tomo"));
        assert!(merge_hooks(&mut existing, &moved, "hook codex"));
        assert_eq!(existing["hooks"]["Stop"].as_array().unwrap().len(), 2);
        assert!(existing["hooks"]["Stop"].to_string().contains("/opt/tomo/bin/tomo"));
    }

    #[test]
    fn codex_trust_needs_every_tomo_entry_in_config() {
        let home = std::env::temp_dir().join(format!("tomo-codex-trust-{}", std::process::id()));
        let codex = home.join(".codex");
        std::fs::create_dir_all(&codex).unwrap();
        assert_eq!(codex_hooks_trusted(&home), None);
        let mut hooks = serde_json::json!({ "hooks": { "Stop": [ { "hooks": [ { "type": "command", "command": "other" } ] } ] } });
        merge_hooks(&mut hooks, &agents::codex_hooks_entries(Path::new("/bin/tomo")), "hook codex");
        let file = codex.join("hooks.json");
        std::fs::write(&file, hooks.to_string()).unwrap();
        assert_eq!(codex_hooks_trusted(&home), Some(false));
        let trust = |entries: &[(&str, usize)]| entries.iter().map(|(event, idx)| format!("\"{}:{event}:{idx}:0\" = \"trusted\"\n", file.display())).collect::<String>();
        let ours = [("permission_request", 0), ("post_tool_use", 0), ("pre_tool_use", 0), ("session_start", 0), ("stop", 1), ("user_prompt_submit", 0)];
        std::fs::write(codex.join("config.toml"), trust(&ours[..5])).unwrap();
        assert_eq!(codex_hooks_trusted(&home), Some(false));
        std::fs::write(codex.join("config.toml"), trust(&ours)).unwrap();
        assert_eq!(codex_hooks_trusted(&home), Some(true));
        let _ = std::fs::remove_dir_all(&home);
    }
}

fn codex_hooks_trusted(home: &Path) -> Option<bool> {
    let hooks: Value = serde_json::from_str(&std::fs::read_to_string(home.join(".codex/hooks.json")).ok()?).ok()?;
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

/// Health of each agent integration, from what is actually installed on this machine.
/// An installed agent that works only in part is a diagnostic. A missing binary is not a problem.
pub fn record_health(inner: &mut crate::daemon::Inner, list: &[IntegrationStatus]) {
    for s in list {
        let problem = matches!(s.level, IntegrationLevel::Partial | IntegrationLevel::ProcessOnly).then(|| s.reason.clone().unwrap_or_else(|| "partial integration".to_string()));
        crate::daemon::Daemon::diagnostic_on_change(inner, "integrations", &s.kind.label().to_lowercase(), problem);
    }
}

pub fn status(config: &tomo_proto::Config) -> Vec<IntegrationStatus> {
    let home = dirs::home_dir().unwrap_or_default();
    AgentKind::all()
        .into_iter()
        .map(|kind| {
            let key = kind.label().to_lowercase();
            let command = config.agents.get(&key).map(|a| a.command.clone()).unwrap_or(key.clone());
            let binary = crate::config::resolve_program(&command);
            if binary.is_none() {
                return IntegrationStatus { kind, level: IntegrationLevel::Unavailable, binary, lifecycle: false, resume: false, reason: Some(format!("{command} not found on PATH")) };
            }
            match kind {
                AgentKind::Claude => IntegrationStatus { kind, level: IntegrationLevel::Full, binary, lifecycle: true, resume: true, reason: None },
                AgentKind::Pi => IntegrationStatus { kind, level: IntegrationLevel::Full, binary, lifecycle: true, resume: true, reason: None },
                AgentKind::Codex => {
                    let installed = std::fs::read_to_string(home.join(".codex/hooks.json")).map(|t| t.contains("hook codex")).unwrap_or(false);
                    match (installed, codex_hooks_trusted(&home)) {
                        (true, Some(true)) => IntegrationStatus { kind, level: IntegrationLevel::Full, binary, lifecycle: true, resume: true, reason: None },
                        (true, _) => IntegrationStatus { kind, level: IntegrationLevel::Partial, binary, lifecycle: false, resume: true, reason: Some("hooks installed but not trusted; start Codex and press t in its hooks panel".into()) },
                        (false, _) => IntegrationStatus { kind, level: IntegrationLevel::ProcessOnly, binary, lifecycle: false, resume: true, reason: Some("run `tomo integrations install`, then trust the hooks in Codex".into()) },
                    }
                }
            }
        })
        .collect()
}
