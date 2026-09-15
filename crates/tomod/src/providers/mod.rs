//! What each agent provider needs that the others do not.
//!
//! Core owns `AgentKind`, presence, state, session identity, and the generic
//! spawn and resume calls. A provider module owns the rest: the command flags,
//! the hook table, process detection, the environment markers, the files Tomo
//! writes for it, the install, the health check, and the session store.
//!
//! One `Provider` value for each module, one `match` in `provider`. A new
//! provider is a new module, one `PROVIDER` value, and one arm.

pub mod claude;
pub mod codex;
pub mod pi;

use anyhow::{Context, Result};
use serde_json::{Map, Value};
use std::path::Path;
use std::path::PathBuf;
use tomo_proto::{AgentCommand, AgentKind, AgentSession, AgentState, Config, IntegrationLevel, IntegrationStatus, Integrations};

pub struct Provider {
    pub kind: AgentKind,
    pub flags: fn(resume: Option<&str>, launch_dir: &Path) -> (Vec<String>, Option<String>),
    pub resume_without_session: Option<&'static str>,
    pub hook_outcome: fn(&Value) -> HookOutcome,
    pub detects: fn(&Program) -> bool,
    pub nested_env: &'static [&'static str],
    pub write_launch_file: fn(launch_dir: &Path, tomo_bin: &Path) -> Result<()>,
    pub install: fn(home: &Path, tomo_bin: &Path) -> Result<()>,
    pub installed: fn(home: &Path) -> bool,
    pub gap: fn(home: &Path) -> Option<Gap>,
    pub sessions: fn(home: &Path, cwd: &Path) -> Vec<AgentSession>,
}

/// What an installed provider still needs before Tomo sees its lifecycle events.
pub struct Gap {
    pub level: IntegrationLevel,
    pub reason: &'static str,
}

pub fn no_gap(_home: &Path) -> Option<Gap> {
    None
}

pub fn no_launch_file(_launch_dir: &Path, _tomo_bin: &Path) -> Result<()> {
    Ok(())
}

pub fn no_sessions(_home: &Path, _cwd: &Path) -> Vec<AgentSession> {
    Vec::new()
}

pub fn provider(kind: AgentKind) -> &'static Provider {
    match kind {
        AgentKind::Claude => &claude::PROVIDER,
        AgentKind::Codex => &codex::PROVIDER,
        AgentKind::Pi => &pi::PROVIDER,
    }
}

pub fn table() -> [&'static Provider; 3] {
    AgentKind::all().map(provider)
}

/// A running process, as the monitor sees it: the program name, the program of
/// `argv[0]`, and the whole command line.
pub struct Program<'a> {
    pub name: &'a str,
    pub argv0: &'a str,
    pub cmd: &'a str,
}

fn basename(program: &str) -> &str {
    program.rsplit('/').next().unwrap_or(program)
}

pub fn detect(name: &str, cmd: &str) -> Option<AgentKind> {
    let program = Program { name: basename(name), argv0: basename(cmd.split_whitespace().next().unwrap_or("")), cmd };
    table().into_iter().find(|p| (p.detects)(&program)).map(|p| p.kind)
}

/// True for a variable that marks the process as a child of an agent. A name
/// that ends with `*` matches every variable with that prefix.
pub fn marks_nested_agent(key: &str) -> bool {
    table().into_iter().flat_map(|p| p.nested_env).any(|name| match name.strip_suffix('*') {
        Some(prefix) => key.starts_with(prefix),
        None => key == *name,
    })
}

pub struct HookOutcome {
    pub state: Option<AgentState>,
    pub session_ref: Option<String>,
}

pub struct SpawnPlan {
    pub argv: Vec<String>,
    pub session_ref: Option<String>,
}

pub fn hook_outcome(kind: AgentKind, payload: &Value) -> HookOutcome {
    (provider(kind).hook_outcome)(payload)
}

fn str_field<'a>(v: &'a Value, key: &str) -> Option<&'a str> {
    v.get(key).and_then(Value::as_str).filter(|s| !s.is_empty())
}

pub fn plan(kind: AgentKind, cmd: &AgentCommand, resume: Option<&str>, launch_dir: &Path, extra: &[String]) -> SpawnPlan {
    let (flags, session_ref) = (provider(kind).flags)(resume, launch_dir);
    let argv = std::iter::once(cmd.command.clone()).chain(cmd.args.iter().cloned()).chain(flags).chain(extra.iter().cloned()).collect();
    SpawnPlan { argv, session_ref }
}

/// The command of `kind` from the config, with the flags of its provider and `extra`.
pub fn launch(config: &Config, kind: AgentKind, resume: Option<&str>, launch_dir: &Path, extra: &[String]) -> SpawnPlan {
    let key = kind.label().to_lowercase();
    let cmd = config.agents.get(&key).cloned().unwrap_or(AgentCommand { command: key, args: vec![] });
    plan(kind, &cmd, resume, launch_dir, extra)
}

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

/// The files Tomo writes for its own agent starts, in the data directory.
pub fn write_launch_files(launch_dir: &Path, tomo_bin: &Path) -> Result<()> {
    table().into_iter().try_for_each(|p| (p.write_launch_file)(launch_dir, tomo_bin))
}

/// The user-level hooks and extensions, so an agent started by hand also reports.
pub fn install(tomo_bin: &Path) -> Result<()> {
    let home = dirs::home_dir().context("no home dir")?;
    table().into_iter().try_for_each(|p| (p.install)(&home, tomo_bin))
}

pub fn installed() -> Integrations {
    let home = dirs::home_dir().unwrap_or_default();
    Integrations {
        claude_hooks: (claude::PROVIDER.installed)(&home),
        codex_hooks: (codex::PROVIDER.installed)(&home),
        pi_extension: (pi::PROVIDER.installed)(&home),
    }
}

/// Health of each agent integration, from what is actually installed on this machine.
/// An installed agent that works only in part is a diagnostic. A missing binary is not a problem.
pub fn record_health(inner: &mut crate::daemon::Inner, list: &[IntegrationStatus]) {
    for s in list {
        let problem = matches!(s.level, IntegrationLevel::Partial | IntegrationLevel::ProcessOnly).then(|| s.reason.clone().unwrap_or_else(|| "partial integration".to_string()));
        crate::daemon::Daemon::diagnostic_on_change(inner, "integrations", &s.kind.label().to_lowercase(), problem);
    }
}

/// Every session that the agents themselves store for `cwd`, newest first.
/// Tomo only reads these stores; it never writes to them.
pub fn sessions(home: &Path, cwd: &Path, limit: usize) -> Vec<AgentSession> {
    let mut list: Vec<AgentSession> = table().into_iter().flat_map(|p| (p.sessions)(home, cwd)).collect();
    list.sort_by_key(|s| std::cmp::Reverse(s.updated_at_ms));
    list.truncate(limit);
    list
}

const MAX_SCAN_LINES: usize = 400;

/// Reads only the first lines: a long session file can be hundreds of megabytes.
fn read_head(path: &Path) -> Vec<String> {
    use std::io::BufRead;
    let Ok(f) = std::fs::File::open(path) else { return Vec::new() };
    std::io::BufReader::new(f).lines().map_while(Result::ok).take(MAX_SCAN_LINES).collect()
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

fn modified_at_ms(path: &Path) -> Option<u64> {
    let meta = std::fs::metadata(path).ok()?;
    Some(meta.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_millis() as u64).unwrap_or(0))
}

fn is_prompt(text: &str) -> bool {
    let t = text.trim_start();
    !t.is_empty() && !t.starts_with('<') && !t.starts_with("# AGENTS.md")
}

fn clip(text: &str) -> String {
    let one_line: String = text.split_whitespace().collect::<Vec<_>>().join(" ");
    one_line.chars().take(120).collect()
}

pub fn status(config: &Config) -> Vec<IntegrationStatus> {
    let home = dirs::home_dir().unwrap_or_default();
    table()
        .into_iter()
        .map(|p| {
            let kind = p.kind;
            let key = kind.label().to_lowercase();
            let command = config.agents.get(&key).map(|a| a.command.clone()).unwrap_or(key);
            let binary = crate::config::resolve_program(&command);
            if binary.is_none() {
                return IntegrationStatus { kind, level: IntegrationLevel::Unavailable, binary, lifecycle: false, resume: false, reason: Some(format!("{command} not found on PATH")) };
            }
            match (p.gap)(&home) {
                None => IntegrationStatus { kind, level: IntegrationLevel::Full, binary, lifecycle: true, resume: true, reason: None },
                Some(gap) => IntegrationStatus { kind, level: gap.level, binary, lifecycle: false, resume: true, reason: Some(gap.reason.to_string()) },
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agents::shell_line;

    #[test]
    fn merge_is_additive_and_idempotent() {
        let mut existing = serde_json::json!({ "hooks": { "Stop": [ { "hooks": [ { "type": "command", "command": "other" } ] } ] }, "theme": "dark" });
        let additions = codex::hooks_entries(Path::new("/usr/local/bin/tomo"));
        assert!(merge_hooks(&mut existing, &additions, "hook codex"));
        assert_eq!(existing["hooks"]["Stop"].as_array().unwrap().len(), 2);
        assert_eq!(existing["theme"], "dark");
        assert!(!merge_hooks(&mut existing, &additions, "hook codex"));
        assert_eq!(existing["hooks"]["Stop"].as_array().unwrap().len(), 2);
        let moved = codex::hooks_entries(Path::new("/opt/tomo/bin/tomo"));
        assert!(merge_hooks(&mut existing, &moved, "hook codex"));
        assert_eq!(existing["hooks"]["Stop"].as_array().unwrap().len(), 2);
        assert!(existing["hooks"]["Stop"].to_string().contains("/opt/tomo/bin/tomo"));
    }

    #[test]
    fn detects_agents_by_name_or_command() {
        assert_eq!(detect("claude", ""), Some(AgentKind::Claude));
        assert_eq!(detect("codex-aarch64-apple-darwin", ""), Some(AgentKind::Codex));
        assert_eq!(detect("node", "node /x/pi-coding-agent/dist/cli.js"), Some(AgentKind::Pi));
        assert_eq!(detect("zsh", "-zsh"), None);
    }

    #[test]
    fn detect_agent_reads_argv0_and_misses_launcher_paths() {
        assert_eq!(detect("2.1.273", "claude --settings /d/claude-hooks.json --session-id s"), Some(AgentKind::Claude), "a versioned native binary is found by argv[0]");
        assert_eq!(detect("node", "/Users/me/.local/bin/claude --resume s"), Some(AgentKind::Claude));
        assert_eq!(detect("codex-aarch64-apple-darwin", "/x/codex-aarch64-apple-darwin resume abc"), Some(AgentKind::Codex));
        assert_eq!(detect("node", "node /opt/homebrew/bin/codex resume abc"), None, "an npm shim is found only through its native child");
        assert_eq!(detect("node", "pi"), Some(AgentKind::Pi), "process.title rewrites argv[0] to pi");
        assert_eq!(detect("node", "node /opt/homebrew/bin/pi -e /d/tomo-status.ts --session-id s"), None, "before process.title runs, the npm symlink path hides pi");
        assert_eq!(detect("claude-trace", "claude-trace"), None);
        assert_eq!(detect("pip", "pip install x"), None);
    }

    #[test]
    fn detect_agent_ignores_programs_that_only_mention_a_provider() {
        assert_eq!(detect("vim", "vim /src/pi-coding-agent/README.md"), None);
        assert_eq!(detect("codexbar", "codexbar"), None);
        assert_eq!(detect("codex", "codex"), Some(AgentKind::Codex), "the plain binary name still counts");
        assert_eq!(detect("node", "node --max-old-space-size=8192 /x/pi-coding-agent/dist/cli.js"), Some(AgentKind::Pi), "a runtime flag before the script still counts");
    }

    fn rust_files(dir: &Path) -> Vec<PathBuf> {
        std::fs::read_dir(dir)
            .into_iter()
            .flatten()
            .flatten()
            .map(|e| e.path())
            .flat_map(|p| if p.is_dir() { rust_files(&p) } else { vec![p] })
            .filter(|p| p.extension().is_some_and(|x| x == "rs"))
            .collect()
    }

    /// `store.rs` keeps the text of the enum, and the Usage addon fetches for
    /// each provider. Every other decision by provider belongs in this folder.
    #[test]
    fn only_provider_modules_branch_on_a_provider() {
        let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let nouns = ["agentkind::claude", "agentkind::codex", "agentkind::pi", "hook claude", "hook codex", "claudecode", "codex_thread", "pi_coding_agent", ".claude/", ".codex/", ".pi/"];
        let hits: Vec<String> = rust_files(&src)
            .into_iter()
            .filter(|p| !p.starts_with(src.join("providers")) && !p.starts_with(src.join("addons/usage")) && !p.ends_with("store.rs"))
            .flat_map(|path| {
                let text = std::fs::read_to_string(&path).unwrap_or_default();
                let code = text.split("#[cfg(test)]").next().unwrap_or_default().to_lowercase();
                code.lines()
                    .enumerate()
                    .filter_map(|(i, line)| nouns.iter().find(|n| line.contains(**n)).map(|n| format!("{}:{}: {n}", path.display(), i + 1)))
                    .collect::<Vec<_>>()
            })
            .collect();
        assert!(hits.is_empty(), "only a provider module may branch on a provider:\n{}", hits.join("\n"));
    }

    #[test]
    fn nested_agent_markers_name_the_parent_agent() {
        for key in ["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CODEX_THREAD_ID", "CODEX_SANDBOX", "CODEX_SANDBOX_NETWORK_DISABLED", "PI_CODING_AGENT"] {
            assert!(marks_nested_agent(key), "{key}");
        }
        for key in ["PATH", "TOMO_PANE_ID", "CLAUDE", "PI_HOME", "EDITOR"] {
            assert!(!marks_nested_agent(key), "{key}");
        }
    }

    #[test]
    fn lists_claude_and_codex_sessions_for_one_cwd_only() {
        let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let home = std::env::temp_dir().join(format!("tomo-sessions-{}-{nanos}", std::process::id()));
        let cwd = Path::new("/w/one");
        let cdir = claude::project_dir(&home, cwd);
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
        let out = sessions(&home, cwd, 10);
        let ids: Vec<&str> = out.iter().map(|s| s.id.as_str()).collect();
        assert!(ids.contains(&"abc") && ids.contains(&"c1") && !ids.contains(&"c2") && !ids.contains(&"empty"), "{ids:?}");
        let claude_session = out.iter().find(|s| s.id == "abc").unwrap();
        assert_eq!(claude_session.title.as_deref(), Some("Login fix"));
        assert_eq!(claude_session.branch.as_deref(), Some("feat/x"));
        assert_eq!(claude_session.turns, 3);
        let codex_session = out.iter().find(|s| s.id == "c1").unwrap();
        assert_eq!(codex_session.title.as_deref(), Some("add tests"));
        assert!(out.iter().all(|s| s.kind != AgentKind::Pi), "Pi keeps no session store that Tomo reads");
        let _ = std::fs::remove_dir_all(&home);
    }

    fn agent_plan(kind: AgentKind, command: &str, args: &[&str], resume: Option<&str>, extra: &[&str]) -> SpawnPlan {
        let owned = |list: &[&str]| list.iter().map(|a| a.to_string()).collect::<Vec<_>>();
        let cmd = AgentCommand { command: command.into(), args: owned(args) };
        plan(kind, &cmd, resume, Path::new("/d"), &owned(extra))
    }

    fn state_of(kind: AgentKind, payload: Value) -> Option<AgentState> {
        hook_outcome(kind, &payload).state
    }

    #[test]
    fn claude_hook_mapping() {
        let waiting = hook_outcome(AgentKind::Claude, &serde_json::json!({"hook_event_name":"Notification","notification_type":"permission_prompt","session_id":"s1"}));
        assert_eq!(waiting.state, Some(AgentState::Waiting));
        assert_eq!(waiting.session_ref.as_deref(), Some("s1"));
        let idle = hook_outcome(AgentKind::Codex, &serde_json::json!({"hook_event_name":"Stop"}));
        assert_eq!(idle.state, Some(AgentState::Idle));
        let none = hook_outcome(AgentKind::Claude, &serde_json::json!({"hook_event_name":"Notification","notification_type":"idle_prompt"}));
        assert_eq!(none.state, None);
    }

    #[test]
    fn pi_hook_mapping_prefers_session_file() {
        let o = hook_outcome(AgentKind::Pi, &serde_json::json!({"event":"ui_prompt_start","session_id":"id","session_file":"/f.jsonl"}));
        assert_eq!(o.state, Some(AgentState::Waiting));
        assert_eq!(o.session_ref.as_deref(), Some("/f.jsonl"));
        let quit = hook_outcome(AgentKind::Pi, &serde_json::json!({"event":"session_shutdown","reason":"quit"}));
        assert_eq!(quit.state, Some(AgentState::Exited));
    }

    #[test]
    fn spawn_plan_builds_resume_and_fresh_commands() {
        let fresh = agent_plan(AgentKind::Claude, "claude", &[], None, &[]);
        assert!(fresh.session_ref.is_some());
        assert!(fresh.argv.contains(&"--session-id".to_string()));
        let resumed = agent_plan(AgentKind::Codex, "codex", &[], Some("abc"), &[]);
        assert_eq!(resumed.argv, vec!["codex", "resume", "abc"]);
        assert_eq!(shell_line(&["a b".to_string(), "c'd".to_string()]), "'a b' 'c'\\''d'");
    }

    #[test]
    fn claude_spawn_plan_passes_settings_and_a_new_session_id() {
        let fresh = agent_plan(AgentKind::Claude, "claude", &["--model", "opus"], None, &["--verbose"]);
        let id = fresh.session_ref.clone().unwrap();
        assert!(uuid::Uuid::parse_str(&id).is_ok(), "{id}");
        assert_eq!(fresh.argv, ["claude", "--model", "opus", "--settings", "/d/claude-hooks.json", "--session-id", id.as_str(), "--verbose"]);
        assert_ne!(agent_plan(AgentKind::Claude, "claude", &[], None, &[]).session_ref, fresh.session_ref);
        let resumed = agent_plan(AgentKind::Claude, "claude", &[], Some("s1"), &[]);
        assert_eq!(resumed.argv, ["claude", "--settings", "/d/claude-hooks.json", "--resume", "s1"]);
        assert_eq!(resumed.session_ref.as_deref(), Some("s1"));
    }

    #[test]
    fn codex_spawn_plan_has_no_session_until_a_hook_reports_one() {
        let fresh = agent_plan(AgentKind::Codex, "codex", &["--full-auto"], None, &["-m", "o3"]);
        assert_eq!(fresh.argv, ["codex", "--full-auto", "-m", "o3"]);
        assert_eq!(fresh.session_ref, None);
        let resumed = agent_plan(AgentKind::Codex, "codex", &["--full-auto"], Some("019a"), &["-m", "o3"]);
        assert_eq!(resumed.argv, ["codex", "--full-auto", "resume", "019a", "-m", "o3"]);
        let last = agent_plan(AgentKind::Codex, "codex", &[], Some("--last"), &[]);
        assert_eq!(last.argv, ["codex", "resume", "--last"]);
        assert_eq!(last.session_ref.as_deref(), Some("--last"), "the restore fallback flag comes back as a session reference");
        assert_eq!(provider(AgentKind::Codex).resume_without_session, Some("--last"));
        assert_eq!(provider(AgentKind::Claude).resume_without_session, None);
    }

    #[test]
    fn pi_spawn_plan_loads_the_extension_and_resumes_by_session_ref() {
        let fresh = agent_plan(AgentKind::Pi, "pi", &[], None, &[]);
        let id = fresh.session_ref.clone().unwrap();
        assert!(uuid::Uuid::parse_str(&id).is_ok(), "{id}");
        assert_eq!(fresh.argv, ["pi", "-e", "/d/tomo-status.ts", "--session-id", id.as_str()]);
        let file = "/h/.pi/agent/sessions/--w--/2026_s.jsonl";
        let resumed = agent_plan(AgentKind::Pi, "pi", &[], Some(file), &["--model", "x"]);
        assert_eq!(resumed.argv, ["pi", "-e", "/d/tomo-status.ts", "--session", file, "--model", "x"]);
        assert_eq!(resumed.session_ref.as_deref(), Some(file));
    }

    #[test]
    fn claude_and_codex_share_one_hook_table() {
        use AgentState::*;
        let table = [
            ("SessionStart", Some(Idle)),
            ("UserPromptSubmit", Some(Working)),
            ("PreToolUse", Some(Working)),
            ("PostToolUse", Some(Working)),
            ("PostToolUseFailure", Some(Working)),
            ("PreCompact", Some(Working)),
            ("PermissionRequest", Some(Waiting)),
            ("Stop", Some(Idle)),
            ("StopFailure", Some(Idle)),
            ("SessionEnd", Some(Exited)),
            ("PostCompact", None),
            ("SubagentStart", None),
            ("SubagentStop", None),
            ("Interrupt", None),
            ("", None),
        ];
        for kind in [AgentKind::Claude, AgentKind::Codex] {
            for (event, want) in table {
                assert_eq!(state_of(kind, serde_json::json!({ "hook_event_name": event, "session_id": "s" })), want, "{kind:?} {event}");
            }
            for t in ["permission_prompt", "elicitation_dialog", "elicitation_url_dialog", "agent_needs_input"] {
                assert_eq!(state_of(kind, serde_json::json!({ "hook_event_name": "Notification", "notification_type": t })), Some(Waiting), "{t}");
            }
            for t in ["idle_prompt", "auth_success", ""] {
                assert_eq!(state_of(kind, serde_json::json!({ "hook_event_name": "Notification", "notification_type": t })), None, "{t}");
            }
        }
    }

    #[test]
    fn hook_session_ref_ignores_missing_and_empty_ids() {
        assert_eq!(hook_outcome(AgentKind::Codex, &serde_json::json!({ "hook_event_name": "Stop", "session_id": "" })).session_ref, None);
        assert_eq!(hook_outcome(AgentKind::Codex, &serde_json::json!({ "hook_event_name": "Stop", "session_id": 7 })).session_ref, None);
        let o = hook_outcome(AgentKind::Codex, &serde_json::json!({ "hook_event_name": "UserPromptSubmit", "session_id": "019a" }));
        assert_eq!((o.state, o.session_ref.as_deref()), (Some(AgentState::Working), Some("019a")));
        assert_eq!(state_of(AgentKind::Claude, serde_json::json!({ "event": "agent_start" })), None, "a Pi payload means nothing to the Claude table");
        assert_eq!(state_of(AgentKind::Pi, serde_json::json!({ "hook_event_name": "Stop" })), None, "a Claude payload means nothing to the Pi table");
    }

    #[test]
    fn pi_event_table() {
        use AgentState::*;
        let table = [
            ("session_start", None, Some(Idle)),
            ("agent_start", None, Some(Working)),
            ("ui_prompt_end", None, Some(Working)),
            ("ui_prompt_start", None, Some(Waiting)),
            ("agent_settled", None, Some(Idle)),
            ("session_shutdown", Some("quit"), Some(Exited)),
            ("session_shutdown", Some("reload"), None),
            ("session_shutdown", None, None),
            ("agent_end", None, None),
            ("turn_end", None, None),
        ];
        for (event, reason, want) in table {
            assert_eq!(state_of(AgentKind::Pi, serde_json::json!({ "event": event, "reason": reason })), want, "{event} {reason:?}");
        }
        let without_file = hook_outcome(AgentKind::Pi, &serde_json::json!({ "event": "session_start", "session_id": "id", "session_file": "" }));
        assert_eq!(without_file.session_ref.as_deref(), Some("id"));
    }

    #[test]
    fn installed_hook_events_all_translate_to_a_state() {
        let sorted_keys = |v: &Value| {
            let mut keys: Vec<String> = v.as_object().unwrap().keys().cloned().collect();
            keys.sort();
            keys
        };
        let claude_file = claude::hooks_settings(Path::new("/opt/My Tomo/tomo"));
        let claude_events = sorted_keys(&claude_file["hooks"]);
        assert_eq!(claude_events, ["Notification", "PermissionRequest", "PostToolUse", "PreToolUse", "SessionEnd", "SessionStart", "Stop", "UserPromptSubmit"]);
        assert_eq!(claude_file["hooks"]["PreToolUse"][0]["matcher"], "*");
        assert!(claude_file["hooks"]["Stop"][0].get("matcher").is_none());
        assert_eq!(claude_file["hooks"]["Stop"][0]["hooks"][0]["command"], "'/opt/My Tomo/tomo' hook claude");
        let codex_file = codex::hooks_entries(Path::new("/usr/local/bin/tomo"));
        let codex_events = sorted_keys(&codex_file);
        assert_eq!(codex_events, ["PermissionRequest", "PostToolUse", "PreToolUse", "SessionStart", "Stop", "UserPromptSubmit"], "no SessionEnd: only the process monitor sees Codex exit");
        assert_eq!(codex_file["Stop"][0]["hooks"][0]["command"], "/usr/local/bin/tomo hook codex");
        for event in claude_events.iter().filter(|e| *e != "Notification").chain(&codex_events) {
            assert!(state_of(AgentKind::Claude, serde_json::json!({ "hook_event_name": event })).is_some(), "{event}");
        }
    }
}
