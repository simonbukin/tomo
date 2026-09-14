use crate::agents;
use anyhow::{Context, Result};
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
        let already = list.as_array().unwrap().iter().any(|e| e.to_string().contains(marker));
        if !already {
            list.as_array_mut().unwrap().extend(entries.as_array().cloned().unwrap_or_default());
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
    }
}
