//! Agent sessions rooted at a worktree, read from the agents' own session stores.
//!
//! Claude Code keeps `~/.claude/projects/<encoded cwd>/<session id>.jsonl`.
//! Codex keeps `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` with the cwd in
//! the first line. Tomo only reads; it never writes to these stores.

use serde_json::Value;
use std::path::{Path, PathBuf};
use tomo_proto::{AgentKind, AgentSession};

const MAX_SCAN_LINES: usize = 400;

/// Claude encodes a cwd by replacing every `/` (and `.`) with `-`.
pub fn claude_project_dir(home: &Path, cwd: &Path) -> PathBuf {
    let encoded: String = cwd.to_string_lossy().chars().map(|c| if c == '/' || c == '.' { '-' } else { c }).collect();
    home.join(".claude").join("projects").join(encoded)
}

fn text_of(content: &Value) -> Option<String> {
    match content {
        Value::String(s) => Some(s.clone()),
        Value::Array(parts) => parts.iter().find_map(|p| (p.get("type")?.as_str()? == "text").then(|| p.get("text")?.as_str().map(str::to_string))?),
        _ => None,
    }
}

fn codex_text(content: &Value) -> Option<String> {
    content.as_array()?.iter().find_map(|p| (p.get("type")?.as_str()? == "input_text").then(|| p.get("text")?.as_str().map(str::to_string))?)
}

fn is_prompt(text: &str) -> bool {
    let t = text.trim_start();
    !t.is_empty() && !t.starts_with('<') && !t.starts_with("# AGENTS.md")
}

fn clip(text: &str) -> String {
    let one_line: String = text.split_whitespace().collect::<Vec<_>>().join(" ");
    one_line.chars().take(120).collect()
}

/// Reads only the first lines: a long Claude session file can be hundreds of megabytes.
fn read_head(path: &Path) -> Vec<String> {
    use std::io::BufRead;
    let Ok(f) = std::fs::File::open(path) else { return Vec::new() };
    std::io::BufReader::new(f).lines().map_while(Result::ok).take(MAX_SCAN_LINES).collect()
}

/// Parses one Claude session file. `None` when it holds no user turn.
pub fn parse_claude(path: &Path) -> Option<AgentSession> {
    let id = path.file_stem()?.to_string_lossy().into_owned();
    let lines = read_head(path);
    let mut title = None;
    let mut first_prompt = None;
    let mut branch = None;
    let mut turns = 0u32;
    for line in &lines {
        let Ok(v) = serde_json::from_str::<Value>(line) else { continue };
        match v.get("type").and_then(Value::as_str) {
            Some("ai-title") => title = v.get("aiTitle").and_then(Value::as_str).map(str::to_string),
            Some("user") => {
                turns += 1;
                if branch.is_none() {
                    branch = v.get("gitBranch").and_then(Value::as_str).filter(|b| *b != "HEAD").map(str::to_string);
                }
                if first_prompt.is_none() {
                    first_prompt = v.get("message").and_then(|m| m.get("content")).and_then(text_of).filter(|t| is_prompt(t)).map(|t| clip(&t));
                }
            }
            Some("assistant") => turns += 1,
            _ => {}
        }
    }
    if turns == 0 {
        return None;
    }
    let meta = std::fs::metadata(path).ok()?;
    let updated_at_ms = meta.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_millis() as u64).unwrap_or(0);
    Some(AgentSession { kind: AgentKind::Claude, id, title: title.or(first_prompt), branch, updated_at_ms, turns, path: path.to_path_buf() })
}

/// Parses one Codex rollout file. `None` when its cwd is not `cwd`.
pub fn parse_codex(path: &Path, cwd: &Path) -> Option<AgentSession> {
    let lines = read_head(path);
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
                let text = if user_message { p.and_then(|p| p.get("message")).and_then(Value::as_str).map(str::to_string) } else { p.and_then(|p| p.get("content")).and_then(codex_text) };
                title = text.filter(|t| is_prompt(t)).map(|t| clip(&t));
            }
        }
    }
    let fs_meta = std::fs::metadata(path).ok()?;
    let updated_at_ms = fs_meta.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_millis() as u64).unwrap_or(0);
    Some(AgentSession { kind: AgentKind::Codex, id, title, branch: None, updated_at_ms, turns, path: path.to_path_buf() })
}

fn jsonl_files(dir: &Path, depth: usize) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(dir) else { return Vec::new() };
    entries
        .flatten()
        .flat_map(|e| {
            let p = e.path();
            if p.is_dir() && depth > 0 {
                jsonl_files(&p, depth - 1)
            } else if p.extension().is_some_and(|x| x == "jsonl") {
                vec![p]
            } else {
                Vec::new()
            }
        })
        .collect()
}

/// Every Claude and Codex session rooted at `cwd`, newest first, capped at `limit`.
pub fn list(home: &Path, cwd: &Path, limit: usize) -> Vec<AgentSession> {
    let claude = jsonl_files(&claude_project_dir(home, cwd), 0).iter().filter_map(|p| parse_claude(p)).collect::<Vec<_>>();
    let codex_root = home.join(".codex").join("sessions");
    let mut recent_codex: Vec<PathBuf> = jsonl_files(&codex_root, 3);
    recent_codex.sort_by_key(|p| std::cmp::Reverse(std::fs::metadata(p).and_then(|m| m.modified()).ok()));
    let codex = recent_codex.iter().take(300).filter_map(|p| parse_codex(p, cwd)).collect::<Vec<_>>();
    let mut all: Vec<AgentSession> = claude.into_iter().chain(codex).collect();
    all.sort_by_key(|s| std::cmp::Reverse(s.updated_at_ms));
    all.truncate(limit);
    all
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp() -> PathBuf {
        let d = std::env::temp_dir().join(format!("tomo-sessions-{}-{}", std::process::id(), now()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn now() -> u128 {
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
    }

    #[test]
    fn claude_dir_encoding_matches_claude_code() {
        assert_eq!(claude_project_dir(Path::new("/h"), Path::new("/Users/me/Projects/tomo")), PathBuf::from("/h/.claude/projects/-Users-me-Projects-tomo"));
        assert_eq!(claude_project_dir(Path::new("/h"), Path::new("/a/b.c")), PathBuf::from("/h/.claude/projects/-a-b-c"));
    }

    #[test]
    fn lists_claude_and_codex_sessions_for_one_cwd_only() {
        let home = tmp();
        let cwd = Path::new("/w/one");
        let cdir = claude_project_dir(&home, cwd);
        std::fs::create_dir_all(&cdir).unwrap();
        std::fs::write(
            cdir.join("abc.jsonl"),
            "{\"type\":\"user\",\"gitBranch\":\"feat/x\",\"message\":{\"content\":\"<local-command-caveat>skip</local-command-caveat>\"}}\n{\"type\":\"user\",\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"fix the   login   bug\"}]}}\n{\"type\":\"assistant\"}\n{\"type\":\"ai-title\",\"aiTitle\":\"Login fix\"}\n",
        )
        .unwrap();
        std::fs::write(cdir.join("empty.jsonl"), "{\"type\":\"mode\"}\n").unwrap();
        let sdir = home.join(".codex/sessions/2026/09/14");
        std::fs::create_dir_all(&sdir).unwrap();
        std::fs::write(sdir.join("rollout-a.jsonl"), "{\"type\":\"session_meta\",\"payload\":{\"id\":\"c1\",\"cwd\":\"/w/one\"}}\n{\"type\":\"event_msg\",\"payload\":{\"type\":\"user_message\",\"message\":\"add tests\"}}\n").unwrap();
        std::fs::write(sdir.join("rollout-b.jsonl"), "{\"type\":\"session_meta\",\"payload\":{\"id\":\"c2\",\"cwd\":\"/w/other\"}}\n").unwrap();
        let out = list(&home, cwd, 10);
        let ids: Vec<&str> = out.iter().map(|s| s.id.as_str()).collect();
        assert!(ids.contains(&"abc") && ids.contains(&"c1") && !ids.contains(&"c2") && !ids.contains(&"empty"), "{ids:?}");
        let claude = out.iter().find(|s| s.id == "abc").unwrap();
        assert_eq!(claude.title.as_deref(), Some("Login fix"));
        assert_eq!(claude.branch.as_deref(), Some("feat/x"));
        assert_eq!(claude.turns, 3);
        let codex = out.iter().find(|s| s.id == "c1").unwrap();
        assert_eq!(codex.title.as_deref(), Some("add tests"));
        let _ = std::fs::remove_dir_all(&home);
    }
}
