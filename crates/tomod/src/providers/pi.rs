use super::{str_field, HookOutcome, Program, Provider};
use crate::subagents::SubagentEvent;
use anyhow::Result;
use serde_json::Value;
use std::path::{Path, PathBuf};
use tomo_proto::{AgentKind, AgentSession, AgentState};

pub static PROVIDER: Provider = Provider {
    kind: AgentKind::Pi,
    flags,
    resume_without_session: None,
    resume_env: &[],
    reports_end: true,
    hooks_need_process: false,
    hook_outcome,
    detects,
    nested_env: &["PI_CODING_AGENT"],
    write_launch_file,
    install,
    installed,
    gap: super::no_gap,
    sessions,
    transcript_text,
    transcript_messages: None,
    sleep_safe_children: &[],
    session_saved,
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
const EXTENSION_SOURCE: &str = include_str!("../../../../integrations/pi/tomo-status.ts");
const EXTENSION_DIR: &str = ".pi/agent/extensions";

fn extension_path(launch_dir: &Path) -> PathBuf {
    launch_dir.join(EXTENSION_FILE)
}

fn write_launch_file(launch_dir: &Path, _tomo_bin: &Path) -> Result<()> {
    std::fs::write(extension_path(launch_dir), EXTENSION_SOURCE)?;
    Ok(())
}

fn install(home: &Path, _tomo_bin: &Path) -> Result<()> {
    let dir = home.join(EXTENSION_DIR);
    std::fs::create_dir_all(&dir)?;
    std::fs::write(dir.join(EXTENSION_FILE), EXTENSION_SOURCE)?;
    Ok(())
}

fn installed(home: &Path) -> bool {
    home.join(EXTENSION_DIR).join(EXTENSION_FILE).exists()
}

fn is_session_file(session_ref: &str) -> bool {
    session_ref.contains('/') || session_ref.ends_with(".jsonl")
}

/// `--session-id` opens the session of this project with that id, or creates it, so a session that ended before
/// its first message still resumes. A session file resumes by its path.
fn flags(resume: Option<&str>, launch_dir: &Path) -> (Vec<String>, Option<String>) {
    let extension = ["-e".to_string(), extension_path(launch_dir).to_string_lossy().into_owned()];
    let session_ref = resume.map(str::to_string).unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let flag = if is_session_file(&session_ref) { "--session" } else { "--session-id" };
    (extension.into_iter().chain([flag.to_string(), session_ref.clone()]).collect(), Some(session_ref))
}

fn hook_outcome(payload: &Value) -> HookOutcome {
    let event = str_field(payload, "event").unwrap_or("");
    let still_running = payload.get("running").and_then(Value::as_bool).unwrap_or(true);
    let state = match event {
        "session_start" => Some(AgentState::Idle),
        "agent_start" => Some(AgentState::Working),
        "ui_prompt_end" => Some(if still_running { AgentState::Working } else { AgentState::Idle }),
        "ui_prompt_start" => Some(AgentState::Waiting),
        "agent_settled" => match str_field(payload, "outcome") {
            Some("aborted") => Some(AgentState::Idle),
            Some("error") => Some(AgentState::Dead),
            _ => Some(AgentState::Done),
        },
        "session_shutdown" if str_field(payload, "reason") == Some("quit") => Some(AgentState::Exited),
        _ => None,
    };
    let agent_id = str_field(payload, "agent_id").map(str::to_string);
    let subagent = agent_id.and_then(|id| match event {
        "subagent_start" => Some(SubagentEvent::Start {
            id,
            label: str_field(payload, "agent_type").unwrap_or("subagent").to_string(),
            description: str_field(payload, "description").map(str::to_string),
        }),
        "subagent_stop" => Some(SubagentEvent::Stop { id }),
        _ => None,
    });
    let session_ref = str_field(payload, "session_file").or_else(|| str_field(payload, "session_id")).map(str::to_string);
    HookOutcome {
        state,
        session_ref,
        subagent,
        only_if_busy: event == "ui_prompt_end" && !still_running,
        question: (event == "ui_prompt_start").then(|| str_field(payload, "title").map(super::clip_question)).flatten(),
    }
}

fn sessions_root(home: &Path) -> PathBuf {
    std::env::var_os("PI_CODING_AGENT_DIR").map(PathBuf::from).unwrap_or_else(|| home.join(".pi/agent")).join("sessions")
}

/// Pi's folder for the sessions of one cwd: the path without its first `/`, with `/`, `\` and `:` as `-`, in `--`.
pub fn cwd_dir(home: &Path, cwd: &Path) -> PathBuf {
    let path = cwd.to_string_lossy();
    let encoded: String = path.strip_prefix('/').unwrap_or(&path).chars().map(|c| if matches!(c, '/' | '\\' | ':') { '-' } else { c }).collect();
    sessions_root(home).join(format!("--{encoded}--"))
}

/// Pi writes the session file on the first message, named `<time>_<id>.jsonl`.
fn session_saved(home: &Path, session_ref: &str) -> bool {
    if is_session_file(session_ref) {
        return Path::new(session_ref).is_file();
    }
    let suffix = format!("_{session_ref}.jsonl");
    std::fs::read_dir(sessions_root(home))
        .into_iter()
        .flatten()
        .flatten()
        .flat_map(|dir| std::fs::read_dir(dir.path()).into_iter().flatten().flatten())
        .any(|f| f.file_name().to_string_lossy().ends_with(&suffix))
}

/// The user or assistant text of one session line. Tool results and tool calls are left out.
fn message_of(line: &str) -> Option<(bool, String)> {
    if !line.contains("\"type\":\"message\"") || !(line.contains("\"role\":\"user\"") || line.contains("\"role\":\"assistant\"")) {
        return None;
    }
    let value: Value = serde_json::from_str(line).ok()?;
    let message = value.get("message")?;
    let user = match message.get("role")?.as_str()? {
        "user" => true,
        "assistant" => false,
        _ => return None,
    };
    let text = match message.get("content")? {
        Value::String(text) => text.clone(),
        Value::Array(parts) => parts
            .iter()
            .filter(|p| p.get("type").and_then(Value::as_str) == Some("text"))
            .filter_map(|p| p.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join("\n"),
        _ => return None,
    };
    super::is_prompt(&text).then_some((user, text))
}

fn transcript_text(line: &str) -> Option<String> {
    message_of(line).map(|(_, text)| text)
}

fn parse_session(path: &Path) -> Option<AgentSession> {
    let lines = super::read_head(path);
    let header: Value = serde_json::from_str(lines.first()?).ok()?;
    let id = str_field(&header, "id")?.to_string();
    let messages: Vec<(bool, String)> = lines.iter().skip(1).filter_map(|l| message_of(l)).collect();
    let named = lines.iter().rev().filter_map(|l| serde_json::from_str::<Value>(l).ok()).find(|v| v.get("type").and_then(Value::as_str) == Some("session_info"));
    let title = named
        .and_then(|v| str_field(&v, "name").map(str::to_string))
        .or_else(|| messages.iter().find(|(user, _)| *user).map(|(_, t)| t.clone()))
        .map(|t| super::clip(&t));
    (!messages.is_empty()).then(|| AgentSession {
        kind: AgentKind::Pi,
        id,
        title,
        branch: None,
        updated_at_ms: super::modified_at_ms(path).unwrap_or(0),
        turns: messages.iter().filter(|(user, _)| *user).count() as u32,
        path: path.to_path_buf(),
    })
}

fn sessions(home: &Path, cwd: &Path) -> Vec<AgentSession> {
    super::jsonl_files(&cwd_dir(home, cwd), 0).iter().filter_map(|p| parse_session(p)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_resume_by_id_also_creates_and_a_file_resumes_by_path() {
        let (fresh, id) = flags(None, Path::new("/d"));
        assert_eq!(&fresh[2..], ["--session-id".to_string(), id.clone().unwrap()]);
        assert_eq!(&flags(Some("abc"), Path::new("/d")).0[2..], ["--session-id", "abc"]);
        assert_eq!(&flags(Some("/h/s/x_abc.jsonl"), Path::new("/d")).0[2..], ["--session", "/h/s/x_abc.jsonl"]);
    }

    fn outcome(payload: Value) -> HookOutcome {
        hook_outcome(&payload)
    }

    #[test]
    fn a_settled_run_ends_by_its_outcome() {
        let settled = |o: Option<&str>| outcome(json!({ "event": "agent_settled", "outcome": o })).state;
        assert_eq!(settled(None), Some(AgentState::Done));
        assert_eq!(settled(Some("completed")), Some(AgentState::Done));
        assert_eq!(settled(Some("aborted")), Some(AgentState::Idle));
        assert_eq!(settled(Some("error")), Some(AgentState::Dead));
    }

    #[test]
    fn a_dialog_waits_with_its_title_and_ends_by_what_runs() {
        let asks = outcome(json!({ "event": "ui_prompt_start", "kind": "confirm", "title": "Allow rm -rf build?" }));
        assert_eq!((asks.state, asks.question.as_deref()), (Some(AgentState::Waiting), Some("Allow rm -rf build?")));
        assert_eq!(outcome(json!({ "event": "ui_prompt_end", "running": true })).state, Some(AgentState::Working));
        let idle = outcome(json!({ "event": "ui_prompt_end", "running": false }));
        assert_eq!((idle.state, idle.only_if_busy), (Some(AgentState::Idle), true));
    }

    #[test]
    fn the_subagent_tool_starts_and_stops_subagents() {
        let start = outcome(json!({ "event": "subagent_start", "agent_id": "call1#0", "agent_type": "scout", "description": "find the auth code" }));
        assert_eq!(start.subagent, Some(SubagentEvent::Start { id: "call1#0".into(), label: "scout".into(), description: Some("find the auth code".into()) }));
        assert_eq!(start.state, None);
        assert_eq!(outcome(json!({ "event": "subagent_stop", "agent_id": "call1#0" })).subagent, Some(SubagentEvent::Stop { id: "call1#0".into() }));
    }

    #[test]
    fn sessions_are_listed_for_one_cwd_with_their_text() {
        let home = std::env::temp_dir().join(format!("tomo-pi-sessions-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&home);
        let dir = cwd_dir(&home, Path::new("/Users/me/repo"));
        assert!(dir.ends_with("--Users-me-repo--"), "{}", dir.display());
        std::fs::create_dir_all(&dir).unwrap();
        let lines = [
            json!({"type":"session","version":3,"id":"s1","cwd":"/Users/me/repo"}),
            json!({"type":"message","message":{"role":"user","content":"fix the login"}}),
            json!({"type":"message","message":{"role":"toolResult","content":"lots of output"}}),
            json!({"type":"message","message":{"role":"assistant","content":[{"type":"thinking","thinking":"hm"},{"type":"text","text":"Fixed."}]}}),
        ];
        std::fs::write(dir.join("2026-10-05T10-00-00-000Z_s1.jsonl"), lines.iter().map(|l| format!("{l}\n")).collect::<String>()).unwrap();
        std::fs::write(dir.join("2026-10-05T11-00-00-000Z_s2.jsonl"), format!("{}\n", json!({"type":"session","id":"s2"}))).unwrap();
        let list = sessions(&home, Path::new("/Users/me/repo"));
        assert_eq!(list.iter().map(|s| (s.id.as_str(), s.turns, s.title.as_deref())).collect::<Vec<_>>(), vec![("s1", 1, Some("fix the login"))]);
        assert_eq!(transcript_text(&lines[3].to_string()).as_deref(), Some("Fixed."));
        assert_eq!(transcript_text(&lines[2].to_string()), None);
        assert!(session_saved(&home, "s1"));
        assert!(!session_saved(&home, "s3"));
        let _ = std::fs::remove_dir_all(&home);
    }
}
