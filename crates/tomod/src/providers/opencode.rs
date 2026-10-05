use super::{str_field, Gap, HookOutcome, Program, Provider};
use crate::subagents::SubagentEvent;
use anyhow::Result;
use rusqlite::{Connection, OpenFlags, OptionalExtension};
use serde_json::Value;
use std::path::{Path, PathBuf};
use tomo_proto::{AgentKind, AgentSession, AgentState, IntegrationLevel};

pub static PROVIDER: Provider = Provider {
    kind: AgentKind::OpenCode,
    flags,
    resume_without_session: None,
    resume_env: &[],
    reports_end: true,
    hooks_need_process: false,
    hook_outcome,
    detects,
    nested_env: &["OPENCODE", "OPENCODE_SESSION_ID", "OPENCODE_TERMINAL"],
    write_launch_file: super::no_launch_file,
    install,
    installed,
    gap,
    sessions,
    transcript_text: super::no_transcript,
    transcript_messages: Some(transcript_messages),
    sleep_safe_children: &[],
    session_saved,
};

fn detects(p: &Program) -> bool {
    p.name == "opencode" || p.argv0 == "opencode"
}

const PLUGIN_SOURCE: &str = include_str!("../../../../integrations/opencode/tomo-status/tui.js");

/// OpenCode loads a TUI plugin from each folder of `<config>/plugins/`. The plugin runs in the TUI, which knows its
/// pane; the shared OpenCode server does not.
fn plugin_file(home: &Path) -> PathBuf {
    home.join(".config/opencode/plugins/tomo-status/tui.js")
}

fn install(home: &Path, _tomo_bin: &Path) -> Result<()> {
    let file = plugin_file(home);
    if std::fs::read_to_string(&file).is_ok_and(|s| s == PLUGIN_SOURCE) {
        return Ok(());
    }
    std::fs::create_dir_all(file.parent().expect("the plugin file has a folder"))?;
    std::fs::write(file, PLUGIN_SOURCE)?;
    Ok(())
}

fn installed(home: &Path) -> bool {
    plugin_file(home).is_file()
}

fn gap(home: &Path) -> Option<Gap> {
    (!installed(home)).then_some(Gap { level: IntegrationLevel::ProcessOnly, reason: "the Tomo plugin is not installed; run tomo integrations install" })
}

const BASE62: &[u8] = b"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/// A session id in OpenCode's own shape, so its lists sort it with the others: `ses_`, 12 hex digits of the
/// inverted creation time, and 14 random base62 characters (`Identifier.descending` in OpenCode's schema package).
pub fn new_session_id(now_ms: u64, random: &[u8; 16]) -> String {
    let time = !(now_ms.wrapping_mul(0x1000).wrapping_add(1)) & 0xffff_ffff_ffff;
    let tail: String = random.iter().take(14).map(|b| BASE62[usize::from(*b) % 62] as char).collect();
    format!("ses_{time:012x}{tail}")
}

/// `--session` opens the session, or creates it with that id when it does not exist, so Tomo names the session.
fn flags(resume: Option<&str>, _launch_dir: &Path) -> (Vec<String>, Option<String>) {
    let id = resume.map(str::to_string).unwrap_or_else(|| new_session_id(tomo_proto::now_ms(), uuid::Uuid::new_v4().as_bytes()));
    (vec!["--session".to_string(), id.clone()], Some(id))
}

fn question_of(event: &str, payload: &Value) -> Option<String> {
    match event {
        "question" => str_field(payload, "question").map(super::clip_question),
        "permission" => {
            let what = [str_field(payload, "action"), str_field(payload, "resource")].into_iter().flatten().collect::<Vec<_>>().join(": ");
            str_field(payload, "message").map(super::clip_question).or_else(|| (!what.is_empty()).then(|| super::clip_question(&what)))
        }
        _ => None,
    }
}

/// The TUI plugin sends one event for each change of a session that the pane shows. An event of a child session
/// carries `agent_id`, the child's id: it is a subagent.
fn hook_outcome(payload: &Value) -> HookOutcome {
    let event = str_field(payload, "event").unwrap_or("");
    let session_ref = str_field(payload, "session_id").map(str::to_string);
    let subagent_id = str_field(payload, "agent_id").map(str::to_string);
    let interrupted_by_user = matches!(str_field(payload, "reason"), Some("user" | "inactivity"));
    let state = match event {
        "ready" => Some(AgentState::Idle),
        "started" | "answered" => Some(AgentState::Working),
        "permission" | "question" => Some(AgentState::Waiting),
        "succeeded" => Some(AgentState::Done),
        "failed" => Some(AgentState::Dead),
        "interrupted" if interrupted_by_user => Some(AgentState::Idle),
        "exit" => Some(AgentState::Exited),
        _ => None,
    };
    let subagent = subagent_id.and_then(|id| match event {
        "subagent" => Some(SubagentEvent::Start {
            id,
            label: str_field(payload, "agent_type").unwrap_or("subagent").to_string(),
            description: str_field(payload, "description").map(str::to_string),
        }),
        "succeeded" | "failed" | "interrupted" => Some(SubagentEvent::Stop { id }),
        _ => state.filter(|s| matches!(s, AgentState::Working | AgentState::Waiting)).map(|state| SubagentEvent::Activity { id, state }),
    });
    let child = str_field(payload, "agent_id").is_some();
    HookOutcome {
        state: if child { state.filter(|s| matches!(s, AgentState::Working | AgentState::Waiting)) } else { state },
        session_ref,
        subagent,
        only_if_busy: event == "interrupted",
        question: question_of(event, payload),
    }
}

fn database_path(home: &Path) -> PathBuf {
    std::env::var_os("OPENCODE_DB").map(PathBuf::from).unwrap_or_else(|| home.join(".local/share/opencode/opencode.db"))
}

/// OpenCode keeps every session in one SQLite file. Tomo opens it read-only.
fn database(home: &Path) -> Option<Connection> {
    let path = database_path(home);
    path.is_file().then(|| Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX).ok())?
}

fn session_saved(home: &Path, session_ref: &str) -> bool {
    database(home)
        .and_then(|db| db.query_row("SELECT 1 FROM session_v2 WHERE id = ?1", [session_ref], |_| Ok(())).optional().ok().flatten())
        .is_some()
}

const SESSIONS_PER_CWD: usize = 300;

/// The root sessions that started in `cwd`, newest first. A subagent's session has a parent and is left out.
fn sessions(home: &Path, cwd: &Path) -> Vec<AgentSession> {
    let Some(db) = database(home) else { return Vec::new() };
    let query = "SELECT s.id, s.title, s.time_updated,
                        (SELECT count(*) FROM session_message m WHERE m.session_id = s.id AND m.type IN ('user', 'assistant'))
                 FROM session_v2 s
                 WHERE s.directory = ?1 AND s.parent_id IS NULL AND s.time_archived IS NULL
                 ORDER BY s.time_updated DESC LIMIT ?2";
    let Ok(mut st) = db.prepare(query) else { return Vec::new() };
    let path = database_path(home);
    let rows = st.query_map(rusqlite::params![cwd.to_string_lossy(), SESSIONS_PER_CWD as i64], |r| {
        let id: String = r.get(0)?;
        Ok(AgentSession {
            kind: AgentKind::OpenCode,
            path: path.join(&id),
            id,
            title: r.get::<_, Option<String>>(1)?.filter(|t| !t.is_empty()),
            branch: None,
            updated_at_ms: r.get::<_, i64>(2)?.max(0) as u64,
            turns: r.get::<_, i64>(3)?.max(0) as u32,
        })
    });
    rows.map(|rows| rows.flatten().filter(|s| s.turns > 0).collect()).unwrap_or_default()
}

/// The text of one stored message: what the user wrote, or the text parts of the agent's answer.
pub fn message_text(kind: &str, data: &str) -> Option<String> {
    let data: Value = serde_json::from_str(data).ok()?;
    let text = match kind {
        "user" => data.get("text")?.as_str()?.to_string(),
        "assistant" => data
            .get("content")?
            .as_array()?
            .iter()
            .filter(|part| part.get("type").and_then(Value::as_str) == Some("text"))
            .filter_map(|part| part.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join("\n"),
        _ => return None,
    };
    super::is_prompt(&text).then_some(text)
}

fn transcript_messages(home: &Path, session: &AgentSession) -> Vec<String> {
    let Some(db) = database(home) else { return Vec::new() };
    let Ok(mut st) = db.prepare("SELECT type, data FROM session_message WHERE session_id = ?1 AND type IN ('user', 'assistant') ORDER BY seq") else {
        return Vec::new();
    };
    st.query_map([&session.id], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
        .map(|rows| rows.flatten().filter_map(|(kind, data)| message_text(&kind, &data)).collect())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_session_id_has_opencodes_shape_and_newer_ids_sort_first() {
        let older = new_session_id(1_000_000, &[7; 16]);
        let newer = new_session_id(2_000_000, &[7; 16]);
        assert!(older.starts_with("ses_") && older.len() == 4 + 12 + 14, "{older}");
        assert!(newer < older);
        assert!(older[4..].chars().all(|c| c.is_ascii_alphanumeric()));
    }

    #[test]
    fn a_launch_names_the_session_and_a_resume_opens_it() {
        let (args, id) = flags(None, Path::new("/tmp"));
        assert_eq!(args[0], "--session");
        assert_eq!(Some(args[1].clone()), id);
        assert_eq!(flags(Some("ses_abc"), Path::new("/tmp")), (vec!["--session".to_string(), "ses_abc".to_string()], Some("ses_abc".to_string())));
    }

    fn outcome(payload: Value) -> (Option<AgentState>, Option<SubagentEvent>, Option<String>, bool) {
        let o = hook_outcome(&payload);
        (o.state, o.subagent, o.question, o.only_if_busy)
    }

    #[test]
    fn the_events_of_the_root_session_set_the_state() {
        assert_eq!(outcome(json!({"event": "ready", "session_id": "s"})).0, Some(AgentState::Idle));
        assert_eq!(outcome(json!({"event": "started", "session_id": "s"})).0, Some(AgentState::Working));
        assert_eq!(outcome(json!({"event": "succeeded", "session_id": "s"})).0, Some(AgentState::Done));
        assert_eq!(outcome(json!({"event": "failed", "session_id": "s", "error": "rate limit"})).0, Some(AgentState::Dead));
        assert_eq!(outcome(json!({"event": "exit", "session_id": "s"})).0, Some(AgentState::Exited));
        assert_eq!(outcome(json!({"event": "interrupted", "session_id": "s", "reason": "user"})), (Some(AgentState::Idle), None, None, true));
        assert_eq!(outcome(json!({"event": "interrupted", "session_id": "s", "reason": "superseded"})).0, None);
        assert_eq!(hook_outcome(&json!({"event": "started", "session_id": "ses_1"})).session_ref.as_deref(), Some("ses_1"));
    }

    #[test]
    fn a_permission_or_a_question_waits_with_its_text() {
        let permission = outcome(json!({"event": "permission", "session_id": "s", "action": "bash", "resource": "rm -rf build"}));
        assert_eq!((permission.0, permission.2.as_deref()), (Some(AgentState::Waiting), Some("bash: rm -rf build")));
        let question = outcome(json!({"event": "question", "session_id": "s", "question": "Which   database?"}));
        assert_eq!((question.0, question.2.as_deref()), (Some(AgentState::Waiting), Some("Which database?")));
        assert_eq!(outcome(json!({"event": "answered", "session_id": "s"})).0, Some(AgentState::Working));
    }

    #[test]
    fn a_child_session_is_a_subagent() {
        let start = outcome(json!({"event": "subagent", "session_id": "s", "agent_id": "c", "agent_type": "explore", "description": "find the tests"}));
        assert_eq!(start.1, Some(SubagentEvent::Start { id: "c".into(), label: "explore".into(), description: Some("find the tests".into()) }));
        assert_eq!(start.0, None);
        let done = outcome(json!({"event": "succeeded", "session_id": "s", "agent_id": "c"}));
        assert_eq!((done.0, done.1), (None, Some(SubagentEvent::Stop { id: "c".into() })));
        let asks = outcome(json!({"event": "permission", "session_id": "s", "agent_id": "c", "action": "edit"}));
        assert_eq!((asks.0, asks.1), (Some(AgentState::Waiting), Some(SubagentEvent::Activity { id: "c".into(), state: AgentState::Waiting })));
        assert_eq!(outcome(json!({"event": "failed", "session_id": "s", "agent_id": "c"})).0, None);
    }

    #[test]
    fn the_text_of_a_stored_message() {
        assert_eq!(message_text("user", r#"{"text":"fix the build"}"#).as_deref(), Some("fix the build"));
        let answer = r#"{"content":[{"type":"reasoning","text":"hm"},{"type":"text","text":"Done."},{"type":"tool","name":"bash"}]}"#;
        assert_eq!(message_text("assistant", answer).as_deref(), Some("Done."));
        assert_eq!(message_text("compaction", r#"{"text":"x"}"#), None);
    }

    fn store(home: &Path) -> Connection {
        let path = home.join(".local/share/opencode/opencode.db");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        let db = Connection::open(path).unwrap();
        db.execute_batch(
            "CREATE TABLE session_v2 (id text PRIMARY KEY, parent_id text, directory text NOT NULL, title text, time_updated integer NOT NULL, time_archived integer);
             CREATE TABLE session_message (id text PRIMARY KEY, session_id text NOT NULL, type text NOT NULL, seq integer NOT NULL, data text NOT NULL);",
        )
        .unwrap();
        db
    }

    #[test]
    fn sessions_come_from_the_store_for_one_cwd_with_their_text() {
        let home = std::env::temp_dir().join(format!("tomo-opencode-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&home);
        let db = store(&home);
        db.execute_batch(
            "INSERT INTO session_v2 VALUES ('ses_a', NULL, '/w', 'Fix login', 20, NULL), ('ses_child', 'ses_a', '/w', 'sub', 30, NULL),
                                           ('ses_other', NULL, '/elsewhere', 'x', 40, NULL), ('ses_empty', NULL, '/w', 'new', 50, NULL);
             INSERT INTO session_message VALUES ('m1', 'ses_a', 'user', 1, '{\"text\":\"fix the login\"}'),
                                                ('m2', 'ses_a', 'assistant', 2, '{\"content\":[{\"type\":\"text\",\"text\":\"Fixed it.\"}]}');",
        )
        .unwrap();
        let list = sessions(&home, Path::new("/w"));
        assert_eq!(list.iter().map(|s| s.id.as_str()).collect::<Vec<_>>(), vec!["ses_a"]);
        assert_eq!((list[0].title.as_deref(), list[0].turns), (Some("Fix login"), 2));
        assert_eq!(transcript_messages(&home, &list[0]), vec!["fix the login", "Fixed it."]);
        assert!(session_saved(&home, "ses_a"));
        assert!(!session_saved(&home, "ses_missing"));
        let _ = std::fs::remove_dir_all(&home);
    }
}
