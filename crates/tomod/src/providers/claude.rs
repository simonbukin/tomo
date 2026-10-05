use super::{str_field, HookOutcome, Program, Provider};
use crate::subagents::SubagentEvent;
use crate::agents::shell_quote;
use anyhow::Result;
use serde_json::Value;
use std::path::{Path, PathBuf};
use tomo_proto::{AgentKind, AgentSession, AgentState};

pub static PROVIDER: Provider = Provider {
    kind: AgentKind::Claude,
    flags,
    resume_without_session: None,
    resume_env: &[("CLAUDE_CODE_RESUME_INTERRUPTED_TURN", "1"), ("CLAUDE_CODE_RESUME_INTERRUPTED_TURN_MAX_AGE_MS", "3600000")],
    reports_end: true,
    hooks_need_process: false,
    hook_outcome,
    detects,
    nested_env: &["CLAUDECODE", "CLAUDE_CODE_*"],
    write_launch_file,
    install,
    installed,
    gap: super::no_gap,
    sessions,
    transcript_text,
    transcript_messages: None,
    sleep_safe_children: &["caffeinate"],
    session_saved,
};

/// Claude Code keeps `~/.claude/projects/<encoded cwd>/<session id>.jsonl`.
/// It encodes a cwd by a replacement of every `/` (and `.`) with `-`.
pub fn project_dir(home: &Path, cwd: &Path) -> PathBuf {
    let encoded: String = cwd.to_string_lossy().chars().map(|c| if c == '/' || c == '.' { '-' } else { c }).collect();
    home.join(".claude").join("projects").join(encoded)
}

/// The pane may have left the directory where the agent started, so every project directory is tried.
fn session_saved(home: &Path, session_ref: &str) -> bool {
    let name = format!("{session_ref}.jsonl");
    std::fs::read_dir(home.join(".claude").join("projects")).map_or(false, |dirs| dirs.flatten().any(|d| d.path().join(&name).is_file()))
}

fn sessions(home: &Path, cwd: &Path) -> Vec<AgentSession> {
    super::jsonl_files(&project_dir(home, cwd), 0).iter().filter_map(|p| parse_session(p)).collect()
}

fn text_of(content: &Value) -> Option<String> {
    match content {
        Value::String(s) => Some(s.clone()),
        Value::Array(parts) => parts.iter().find_map(|p| (p.get("type")?.as_str()? == "text").then(|| p.get("text")?.as_str().map(str::to_string))?),
        _ => None,
    }
}

#[derive(serde::Deserialize)]
struct Line {
    #[serde(rename = "type")]
    kind: Option<String>,
    message: Option<Message>,
}

#[derive(serde::Deserialize)]
struct Message {
    content: Option<Content>,
}

/// A string, or a list of parts. Not `#[serde(untagged)]`: that copies the whole value, tool output included, before it picks a variant.
enum Content {
    Text(String),
    Parts(Vec<Part>),
}

impl<'de> serde::Deserialize<'de> for Content {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        struct Visit;
        impl<'de> serde::de::Visitor<'de> for Visit {
            type Value = Content;
            fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
                f.write_str("a string or a list of parts")
            }
            fn visit_str<E: serde::de::Error>(self, v: &str) -> Result<Content, E> {
                Ok(Content::Text(v.to_string()))
            }
            fn visit_seq<A: serde::de::SeqAccess<'de>>(self, mut seq: A) -> Result<Content, A::Error> {
                let parts = std::iter::from_fn(|| seq.next_element::<Part>().transpose()).collect::<Result<_, _>>()?;
                Ok(Content::Parts(parts))
            }
        }
        d.deserialize_any(Visit)
    }
}

/// A content part. Only `type` and `text` are read, so serde skips the large `input` and `content` of tool parts without a copy.
#[derive(serde::Deserialize)]
struct Part {
    #[serde(rename = "type")]
    kind: Option<String>,
    text: Option<String>,
}

fn transcript_text(line: &str) -> Option<String> {
    if !line.contains("\"type\":\"user\"") && !line.contains("\"type\":\"assistant\"") {
        return None;
    }
    let parsed: Line = serde_json::from_str(line).ok()?;
    if !matches!(parsed.kind.as_deref(), Some("user" | "assistant")) {
        return None;
    }
    let text = match parsed.message?.content? {
        Content::Text(t) => t,
        Content::Parts(parts) => parts.into_iter().filter(|p| p.kind.as_deref() == Some("text")).filter_map(|p| p.text).collect::<Vec<_>>().join("\n"),
    };
    super::is_prompt(&text).then_some(text)
}

/// Parses one session file. `None` when it holds no user turn.
pub fn parse_session(path: &Path) -> Option<AgentSession> {
    let id = path.file_stem()?.to_string_lossy().into_owned();
    let lines = super::read_head(path);
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
                    first_prompt = v.get("message").and_then(|m| m.get("content")).and_then(text_of).filter(|t| super::is_prompt(t)).map(|t| super::clip(&t));
                }
            }
            Some("assistant") => turns += 1,
            _ => {}
        }
    }
    if turns == 0 {
        return None;
    }
    Some(AgentSession {
        kind: AgentKind::Claude,
        id,
        title: title.or(first_prompt),
        branch,
        updated_at_ms: super::modified_at_ms(path)?,
        turns,
        path: path.to_path_buf(),
    })
}

fn write_launch_file(launch_dir: &Path, tomo_bin: &Path) -> Result<()> {
    std::fs::write(settings_path(launch_dir), serde_json::to_string_pretty(&hooks_settings(tomo_bin))?)?;
    Ok(())
}

fn install(home: &Path, tomo_bin: &Path) -> Result<()> {
    super::merge_into_file(&home.join(".claude/settings.json"), &hooks_settings(tomo_bin)["hooks"], "hook claude")
}

fn installed(home: &Path) -> bool {
    std::fs::read_to_string(home.join(".claude/settings.json")).map(|t| t.contains("hook claude")).unwrap_or(false)
}

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
            "idle_prompt" => Some(AgentState::Idle),
            _ => None,
        },
        "Stop" => Some(AgentState::Done),
        "StopFailure" => Some(AgentState::Dead),
        "SessionEnd" => Some(AgentState::Exited),
        _ => None,
    };
    let only_if_busy = event == "Notification" && str_field(payload, "notification_type") == Some("idle_prompt");
    let question = match event {
        "PermissionRequest" => str_field(payload, "tool_name").map(|tool| super::ask_text(tool, payload.get("tool_input").unwrap_or(&Value::Null))),
        "Notification" if state == Some(AgentState::Waiting) && str_field(payload, "notification_type") != Some("permission_prompt") => {
            str_field(payload, "message").map(super::clip_question)
        }
        _ => None,
    };
    HookOutcome { state, session_ref: str_field(payload, "session_id").map(str::to_string), subagent: subagent_event(event, payload, state), only_if_busy, question }
}

/// The tool that starts a subagent. Claude Code renamed `Task` to `Agent` and accepts both.
const SUBAGENT_TOOLS: [&str; 2] = ["Agent", "Task"];
const DEFAULT_SUBAGENT: &str = "general-purpose";

/// A hook that fires inside a subagent carries `agent_id` and `agent_type`. The parent's `PreToolUse` of the
/// subagent tool carries the task description, which `SubagentStart` does not.
fn subagent_event(event: &str, payload: &Value, state: Option<AgentState>) -> Option<SubagentEvent> {
    let id = str_field(payload, "agent_id").map(str::to_string);
    let label = || str_field(payload, "agent_type").unwrap_or(DEFAULT_SUBAGENT).to_string();
    match (event, id) {
        ("SubagentStart", Some(id)) => Some(SubagentEvent::Start { id, label: label(), description: None }),
        ("SubagentStop", Some(id)) => Some(SubagentEvent::Stop { id }),
        (_, Some(id)) => state.filter(|s| matches!(s, AgentState::Working | AgentState::Waiting)).map(|state| SubagentEvent::Activity { id, state }),
        ("PreToolUse", None) if str_field(payload, "tool_name").is_some_and(|t| SUBAGENT_TOOLS.contains(&t)) => {
            let input = payload.get("tool_input").unwrap_or(&Value::Null);
            Some(SubagentEvent::Launch {
                label: str_field(input, "subagent_type").unwrap_or(DEFAULT_SUBAGENT).to_string(),
                description: str_field(input, "description").map(str::to_string),
            })
        }
        _ => None,
    }
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
            "SubagentStart": hook(None),
            "SubagentStop": hook(None),
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn claude_dir_encoding_matches_claude_code() {
        assert_eq!(project_dir(Path::new("/h"), Path::new("/Users/me/Projects/tomo")), PathBuf::from("/h/.claude/projects/-Users-me-Projects-tomo"));
        assert_eq!(project_dir(Path::new("/h"), Path::new("/a/b.c")), PathBuf::from("/h/.claude/projects/-a-b-c"));
    }
}
