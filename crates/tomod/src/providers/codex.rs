use super::{str_field, Gap, HookOutcome, Program, Provider};
use crate::agents::shell_quote;
use crate::subagents::SubagentEvent;
use anyhow::Result;
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use tomo_proto::{AgentKind, AgentSession, AgentState, IntegrationLevel};

pub static PROVIDER: Provider = Provider {
    kind: AgentKind::Codex,
    flags,
    resume_without_session: Some("--last"),
    resume_env: &[],
    reports_end: false,
    hooks_need_process: true,
    hook_outcome,
    detects,
    nested_env: &["CODEX_THREAD_ID", "CODEX_SESSION_ID", "CODEX_SANDBOX*"],
    write_launch_file: super::no_launch_file,
    install,
    installed,
    gap,
    sessions,
    transcript_text,
    transcript_messages: None,
    sleep_safe_children: &["codex-code-mode-host"],
    session_saved,
};

/// Codex puts the tool's namespace in front of its name in a hook: multi-agent v2 reports `spawn_agent` as
/// `collaborationspawn_agent`. So a tool is matched by the end of its name.
fn is_tool(name: &str, tool: &str) -> bool {
    name.ends_with(tool)
}

const SPAWN_TOOL: &str = "spawn_agent";
const ASK_TOOL: &str = "request_user_input";

/// Codex's hook events. An event inside a subagent carries `agent_id`; `session_id` is always the root session.
fn hook_outcome(payload: &Value) -> HookOutcome {
    let event = str_field(payload, "hook_event_name").unwrap_or("");
    let tool = str_field(payload, "tool_name").unwrap_or("");
    let input = payload.get("tool_input").unwrap_or(&Value::Null);
    let asks = event == "PreToolUse" && is_tool(tool, ASK_TOOL);
    let state = match event {
        "SessionStart" => Some(AgentState::Idle),
        _ if asks => Some(AgentState::Waiting),
        "UserPromptSubmit" | "PreToolUse" | "PostToolUse" | "PreCompact" | "PostCompact" => Some(AgentState::Working),
        "PermissionRequest" => Some(AgentState::Waiting),
        "Stop" => Some(AgentState::Done),
        "Interrupt" => Some(AgentState::Idle),
        "SessionEnd" => Some(AgentState::Exited),
        _ => None,
    };
    let agent_id = str_field(payload, "agent_id").map(str::to_string);
    let label = || str_field(payload, "agent_type").unwrap_or("default").to_string();
    let subagent = match (event, agent_id) {
        ("SubagentStart", Some(id)) => Some(SubagentEvent::Start { id, label: label(), description: None }),
        ("SubagentStop", Some(id)) => Some(SubagentEvent::Stop { id }),
        (_, Some(id)) => state.filter(|s| matches!(s, AgentState::Working | AgentState::Waiting)).map(|state| SubagentEvent::Activity { id, state }),
        ("PreToolUse", None) if is_tool(tool, SPAWN_TOOL) => Some(SubagentEvent::Launch {
            label: str_field(input, "agent_type").unwrap_or("default").to_string(),
            description: str_field(input, "task_name").or_else(|| str_field(input, "message")).map(super::clip_question),
        }),
        _ => None,
    };
    let question = (event == "PermissionRequest" || asks).then(|| super::ask_text(tool, input));
    HookOutcome {
        state,
        session_ref: str_field(payload, "session_id").map(str::to_string),
        subagent,
        only_if_busy: matches!(event, "Interrupt" | "PostToolUse"),
        question,
    }
}

fn codex_home(home: &Path) -> PathBuf {
    std::env::var_os("CODEX_HOME").map(PathBuf::from).unwrap_or_else(|| home.join(".codex"))
}

/// A rollout is saved on the first message, with the session id at the end of its file name.
fn session_saved(home: &Path, session_ref: &str) -> bool {
    let sessions = codex_home(home).join("sessions");
    super::jsonl_files(&sessions, 3).iter().any(|p| p.file_stem().and_then(|s| s.to_str()).is_some_and(|s| s.ends_with(session_ref)))
}

/// Codex keeps `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`, with the cwd in
/// the first line. The newest 300 files are enough for one worktree.
fn sessions(home: &Path, cwd: &Path) -> Vec<AgentSession> {
    let mut recent = super::jsonl_files(&codex_home(home).join("sessions"), 3);
    recent.sort_by_key(|p| std::cmp::Reverse(std::fs::metadata(p).and_then(|m| m.modified()).ok()));
    recent.iter().take(300).filter_map(|p| parse_session(p, cwd)).collect()
}

/// The text parts of a paginated rollout item: `text` for the user, `Text` for the agent.
fn item_text(item: &Value) -> Option<String> {
    let parts: Vec<&str> = item
        .get("content")?
        .as_array()?
        .iter()
        .filter(|p| matches!(p.get("type").and_then(Value::as_str), Some("text" | "Text")))
        .filter_map(|p| p.get("text").and_then(Value::as_str))
        .collect();
    (!parts.is_empty()).then(|| parts.join("\n"))
}

/// The user or agent text of one rollout line, in the old `user_message` / `agent_message` shape or the
/// paginated `item_completed` shape that Codex writes since 0.159.
fn message_of(line: &Value) -> Option<(bool, String)> {
    if line.get("type").and_then(Value::as_str) != Some("event_msg") {
        return None;
    }
    let payload = line.get("payload")?;
    match payload.get("type").and_then(Value::as_str)? {
        "user_message" => Some((true, payload.get("message")?.as_str()?.to_string())),
        "agent_message" => Some((false, payload.get("message")?.as_str()?.to_string())),
        "item_completed" => {
            let item = payload.get("item")?;
            match item.get("type").and_then(Value::as_str)? {
                "UserMessage" => Some((true, item_text(item)?)),
                "AgentMessage" => Some((false, item_text(item)?)),
                _ => None,
            }
        }
        _ => None,
    }
}

fn text_of(content: &Value) -> Option<String> {
    content.as_array()?.iter().find_map(|p| (p.get("type")?.as_str()? == "input_text").then(|| p.get("text")?.as_str().map(str::to_string))?)
}

/// Codex writes each message twice: as an `event_msg` and as a `response_item`. Only the `event_msg` is read.
fn transcript_text(line: &str) -> Option<String> {
    if !line.contains("\"event_msg\"") {
        return None;
    }
    let parsed: Value = serde_json::from_str(line).ok()?;
    message_of(&parsed).map(|(_, text)| text).filter(|t| super::is_prompt(t))
}

/// Parses one rollout file. `None` when its cwd is not `cwd`.
pub fn parse_session(path: &Path, cwd: &Path) -> Option<AgentSession> {
    let lines = super::read_head(path);
    let meta: Value = serde_json::from_str(lines.first()?).ok()?;
    let payload = meta.get("payload")?;
    if Path::new(payload.get("cwd")?.as_str()?) != cwd || str_field(payload, "parent_thread_id").is_some() {
        return None;
    }
    let id = payload.get("id").and_then(Value::as_str)?.to_string();
    let parsed: Vec<Value> = lines.iter().skip(1).filter_map(|l| serde_json::from_str(l).ok()).collect();
    let mut prompts: Vec<String> = parsed.iter().filter_map(message_of).filter_map(|(user, text)| user.then_some(text)).collect();
    if prompts.is_empty() {
        let user_item = |v: &&Value| v.get("type").and_then(Value::as_str) == Some("response_item") && v.get("payload").and_then(|p| p.get("role")).and_then(Value::as_str) == Some("user");
        prompts = parsed.iter().filter(user_item).filter_map(|v| v.get("payload").and_then(|p| p.get("content")).and_then(text_of)).collect();
    }
    let title = prompts.iter().find(|t| super::is_prompt(t)).map(|t| super::clip(t));
    Some(AgentSession { kind: AgentKind::Codex, id, title, branch: None, updated_at_ms: super::modified_at_ms(path)?, turns: prompts.len() as u32, path: path.to_path_buf() })
}

fn hooks_file(home: &Path) -> PathBuf {
    codex_home(home).join("hooks.json")
}

fn install(home: &Path, tomo_bin: &Path) -> Result<()> {
    super::merge_into_file(&hooks_file(home), &hooks_entries(tomo_bin), "hook codex")
}

fn installed(home: &Path) -> bool {
    std::fs::read_to_string(hooks_file(home)).map(|t| t.contains("hook codex")).unwrap_or(false)
}

fn gap(home: &Path) -> Option<Gap> {
    let ours = tomo_hooks(home);
    match (ours.is_empty(), ours.iter().all(|h| h.trusted_in_config)) {
        (true, _) => Some(Gap { level: IntegrationLevel::ProcessOnly, reason: "run `tomo integrations install`" }),
        (false, true) => None,
        (false, false) => Some(Gap {
            level: IntegrationLevel::Partial,
            reason: "Codex that Tomo starts reports in full; a Codex you start by hand reports only with --no-daemon and after you trust the hooks (press t in its hooks panel)",
        }),
    }
}

fn snake(event: &str) -> String {
    event.chars().enumerate().map(|(i, c)| if c.is_uppercase() && i > 0 { format!("_{}", c.to_lowercase()) } else { c.to_lowercase().to_string() }).collect()
}

/// Codex's trust hash of one hook group: the sha256 of the group as compact JSON with sorted keys, as `hook_hash`
/// in Codex's hooks crate computes it. A hook runs only when this hash is the one the user trusted.
pub fn trust_hash(event: &str, group: &Value) -> Option<String> {
    let handler = group.get("hooks")?.get(0)?;
    let mut normal = Map::new();
    normal.insert("type".into(), handler.get("type")?.clone());
    normal.insert("command".into(), handler.get("command")?.clone());
    normal.insert("timeout".into(), handler.get("timeout")?.clone());
    normal.insert("async".into(), handler.get("async").cloned().unwrap_or(Value::Bool(false)));
    if let Some(message) = handler.get("statusMessage") {
        normal.insert("statusMessage".into(), message.clone());
    }
    let mut hashed = Map::new();
    hashed.insert("event_name".into(), Value::String(snake(event)));
    hashed.insert("hooks".into(), Value::Array(vec![Value::Object(normal)]));
    if let Some(matcher) = group.get("matcher") {
        hashed.insert("matcher".into(), matcher.clone());
    }
    let digest = Sha256::digest(Value::Object(hashed).to_string().as_bytes());
    Some(format!("sha256:{}", digest.iter().map(|b| format!("{b:02x}")).collect::<String>()))
}

/// One of Tomo's entries in `hooks.json`: its trust key, its hash, and whether the user's config trusts it.
#[derive(Debug, PartialEq, Eq)]
struct TomoHook {
    key: String,
    hash: String,
    trusted_in_config: bool,
}

fn tomo_hooks(home: &Path) -> Vec<TomoHook> {
    let file = hooks_file(home);
    let Some(hooks) = std::fs::read_to_string(&file).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()) else { return Vec::new() };
    let config = std::fs::read_to_string(codex_home(home).join("config.toml")).unwrap_or_default();
    hooks
        .get("hooks")
        .and_then(Value::as_object)
        .into_iter()
        .flatten()
        .flat_map(|(event, groups)| {
            let file = &file;
            let config = &config;
            groups.as_array().into_iter().flatten().enumerate().filter(|(_, g)| g.to_string().contains("hook codex")).filter_map(move |(at, group)| {
                let hash = trust_hash(event, group)?;
                let key = format!("{}:{}:{at}:0", file.display(), snake(event));
                let trusted_in_config = config.contains(&format!("\"{key}\"]\ntrusted_hash = \"{hash}\""));
                Some(TomoHook { key, hash, trusted_in_config })
            })
        })
        .collect()
}

/// `-c hooks.state={...}` trusts Tomo's own hooks for one launch, so a Codex that Tomo starts reports without a trust
/// step. The value is one inline table, because Codex splits a dotted `-c` key on every dot.
fn trust_override(home: &Path) -> Option<String> {
    let ours = tomo_hooks(home);
    (!ours.is_empty()).then(|| format!("hooks.state={{{}}}", ours.iter().map(|h| format!("\"{}\"={{trusted_hash=\"{}\"}}", h.key, h.hash)).collect::<Vec<_>>().join(",")))
}

fn detects(p: &Program) -> bool {
    is_codex(p.name) || is_codex(p.argv0)
}

/// The binary is `codex` or `codex-<target triple>`. A program whose name only
/// starts with "codex", such as a menu bar app, is another program.
fn is_codex(program: &str) -> bool {
    program == "codex" || program.strip_prefix("codex-").is_some_and(|triple| triple.starts_with("aarch64-") || triple.starts_with("x86_64-"))
}

/// `--no-daemon` keeps the session in the pane's own Codex process. In the shared background server, Codex runs
/// the hooks with the server's environment, which names no pane, so no event would reach Tomo. Codex reports the
/// session only after the first prompt; a pane without one resumes the newest session in its directory.
fn flags(resume: Option<&str>, _launch_dir: &Path) -> (Vec<String>, Option<String>) {
    let home = dirs::home_dir().unwrap_or_default();
    let trust = trust_override(&home).map(|value| ["-c".to_string(), value]).into_iter().flatten();
    let launch: Vec<String> = std::iter::once("--no-daemon".to_string()).chain(trust).collect();
    match resume {
        Some(r) => (launch.into_iter().chain(["resume".to_string(), r.to_string()]).collect(), Some(r.to_string())),
        None => (launch, None),
    }
}

pub fn hooks_entries(tomo_bin: &Path) -> Value {
    let command = format!("{} hook codex", shell_quote(&tomo_bin.to_string_lossy()));
    let hook = |timeout: u32| json!([{ "hooks": [{ "type": "command", "command": command, "timeout": timeout }] }]);
    let events = [
        ("SessionStart", 5),
        ("UserPromptSubmit", 5),
        ("PreToolUse", 5),
        ("PostToolUse", 5),
        ("PermissionRequest", 5),
        ("Stop", 5),
        ("SubagentStart", 5),
        ("SubagentStop", 5),
        ("Interrupt", 3),
        ("SessionEnd", 3),
    ];
    Value::Object(events.into_iter().map(|(name, timeout)| (name.to_string(), hook(timeout))).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn group(command: &str, timeout: u32) -> Value {
        json!({ "hooks": [{ "type": "command", "command": command, "timeout": timeout }] })
    }

    #[test]
    fn the_trust_hash_is_codexs_own() {
        let stop = group("/Applications/Tomo.app/Contents/MacOS/tomo hook codex", 5);
        assert_eq!(trust_hash("Stop", &stop).as_deref(), Some("sha256:0a27619b8fe60c2ffcdbb5dd1709d4c06c4a6dc65dbfc299170883376355af8a"));
        assert_ne!(trust_hash("Stop", &stop), trust_hash("SessionStart", &stop));
        assert_eq!(snake("UserPromptSubmit"), "user_prompt_submit");
    }

    fn codex_home_with(name: &str, config: &str) -> PathBuf {
        let home = std::env::temp_dir().join(format!("tomo-codex-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&home);
        std::fs::create_dir_all(home.join(".codex")).unwrap();
        let mut hooks = json!({ "hooks": { "Stop": [ { "hooks": [ { "type": "command", "command": "other", "timeout": 1 } ] } ] } });
        super::super::merge_hooks(&mut hooks, &hooks_entries(Path::new("/bin/tomo")), "hook codex");
        std::fs::write(home.join(".codex/hooks.json"), hooks.to_string()).unwrap();
        std::fs::write(home.join(".codex/config.toml"), config).unwrap();
        home
    }

    #[test]
    fn tomos_hooks_are_found_after_other_entries_and_trusted_by_hash() {
        let home = codex_home_with("trust", "");
        let ours = tomo_hooks(&home);
        assert_eq!(ours.len(), 10);
        let stop = ours.iter().find(|h| h.key.ends_with(":stop:1:0")).expect("Tomo's Stop comes after the other entry");
        assert!(!stop.trusted_in_config);
        assert!(matches!(gap(&home), Some(Gap { level: IntegrationLevel::Partial, .. })));
        let config: String = ours.iter().map(|h| format!("[hooks.state.\"{}\"]\ntrusted_hash = \"{}\"\n\n", h.key, h.hash)).collect();
        std::fs::write(home.join(".codex/config.toml"), &config).unwrap();
        assert!(gap(&home).is_none(), "every hook trusted with its own hash leaves no gap");
        std::fs::write(home.join(".codex/config.toml"), config.replace("sha256:", "sha256:0")).unwrap();
        assert!(gap(&home).is_some(), "a stale hash is not trust");
        let value = trust_override(&home).unwrap();
        assert!(value.starts_with("hooks.state={\"") && value.contains(&format!("={{trusted_hash=\"{}\"}}", stop.hash)), "{value}");
        let _ = std::fs::remove_dir_all(&home);
    }

    fn outcome(payload: Value) -> HookOutcome {
        hook_outcome(&payload)
    }

    #[test]
    fn codex_events_set_the_state() {
        let state = |event: &str| outcome(json!({ "hook_event_name": event, "session_id": "s" })).state;
        assert_eq!(state("SessionStart"), Some(AgentState::Idle));
        assert_eq!(state("UserPromptSubmit"), Some(AgentState::Working));
        assert_eq!(state("Stop"), Some(AgentState::Done));
        assert_eq!(state("SessionEnd"), Some(AgentState::Exited));
        let interrupt = outcome(json!({ "hook_event_name": "Interrupt", "session_id": "s" }));
        assert_eq!((interrupt.state, interrupt.only_if_busy), (Some(AgentState::Idle), true));
        let late = outcome(json!({ "hook_event_name": "PostToolUse", "session_id": "s", "tool_name": "Bash" }));
        assert_eq!((late.state, late.only_if_busy), (Some(AgentState::Working), true), "a background tool that ends after the turn does not start it again");
        assert_eq!(outcome(json!({ "hook_event_name": "Stop", "session_id": "abc" })).session_ref.as_deref(), Some("abc"));
    }

    #[test]
    fn a_permission_or_a_question_waits_with_its_text() {
        let permission = outcome(json!({ "hook_event_name": "PermissionRequest", "tool_name": "Bash", "tool_input": { "command": "rm -rf build" } }));
        assert_eq!((permission.state, permission.question.as_deref()), (Some(AgentState::Waiting), Some("Bash: rm -rf build")));
        let asked = outcome(json!({ "hook_event_name": "PreToolUse", "tool_name": "request_user_input", "tool_input": { "questions": [ { "header": "DB", "question": "Which database?" } ] } }));
        assert_eq!((asked.state, asked.question.as_deref()), (Some(AgentState::Waiting), Some("Which database?")));
        assert_eq!(outcome(json!({ "hook_event_name": "PreToolUse", "tool_name": "Bash" })).question, None);
    }

    #[test]
    fn subagents_come_from_spawn_agent_and_the_subagent_events() {
        let launch = outcome(json!({ "hook_event_name": "PreToolUse", "tool_name": "collaborationspawn_agent", "tool_input": { "agent_type": "explorer", "task_name": "map the repo" } }));
        assert_eq!(launch.subagent, Some(SubagentEvent::Launch { label: "explorer".into(), description: Some("map the repo".into()) }));
        let start = outcome(json!({ "hook_event_name": "SubagentStart", "agent_id": "t2", "agent_type": "explorer" }));
        assert_eq!(start.subagent, Some(SubagentEvent::Start { id: "t2".into(), label: "explorer".into(), description: None }));
        let work = outcome(json!({ "hook_event_name": "PreToolUse", "agent_id": "t2", "tool_name": "Bash" }));
        assert_eq!(work.subagent, Some(SubagentEvent::Activity { id: "t2".into(), state: AgentState::Working }));
        assert_eq!(outcome(json!({ "hook_event_name": "SubagentStop", "agent_id": "t2" })).subagent, Some(SubagentEvent::Stop { id: "t2".into() }));
    }

    #[test]
    fn a_launch_keeps_the_session_in_the_pane_and_trusts_tomos_hooks() {
        let (fresh, session) = flags(None, Path::new("/tmp"));
        assert_eq!((fresh[0].as_str(), session), ("--no-daemon", None));
        let (resume, session) = flags(Some("019a"), Path::new("/tmp"));
        assert_eq!((resume[0].as_str(), &resume[resume.len() - 2..], session.as_deref()), ("--no-daemon", &["resume".to_string(), "019a".to_string()][..], Some("019a")));
    }

    #[test]
    fn rollouts_in_both_formats_give_their_text_and_skip_subagents() {
        let old = r#"{"type":"event_msg","payload":{"type":"user_message","message":"fix it"}}"#;
        let new_user = r#"{"type":"event_msg","payload":{"type":"item_completed","item":{"type":"UserMessage","content":[{"type":"text","text":"add tests"}]}}}"#;
        let new_agent = r#"{"type":"event_msg","payload":{"type":"item_completed","item":{"type":"AgentMessage","content":[{"type":"Text","text":"Added."}]}}}"#;
        assert_eq!(transcript_text(old).as_deref(), Some("fix it"));
        assert_eq!(transcript_text(new_user).as_deref(), Some("add tests"));
        assert_eq!(transcript_text(new_agent).as_deref(), Some("Added."));
        let dir = std::env::temp_dir().join(format!("tomo-codex-rollouts-{}", std::process::id()));
        let day = dir.join(".codex/sessions/2026/10/05");
        std::fs::create_dir_all(&day).unwrap();
        let root = format!("{}\n{new_user}\n{new_agent}\n", json!({"type":"session_meta","payload":{"id":"019a-root","cwd":"/w"}}));
        let child = format!("{}\n{new_user}\n", json!({"type":"session_meta","payload":{"id":"019a-child","cwd":"/w","parent_thread_id":"019a-root"}}));
        std::fs::write(day.join("rollout-2026-10-05T10-00-00-019a-root.jsonl"), root).unwrap();
        std::fs::write(day.join("rollout-2026-10-05T10-01-00-019a-child.jsonl"), child).unwrap();
        let list = sessions(&dir, Path::new("/w"));
        assert_eq!(list.iter().map(|s| (s.id.as_str(), s.turns, s.title.as_deref())).collect::<Vec<_>>(), vec![("019a-root", 1, Some("add tests"))]);
        assert!(session_saved(&dir, "019a-root"));
        assert!(!session_saved(&dir, "019a-gone"));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
