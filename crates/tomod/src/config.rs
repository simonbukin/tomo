use anyhow::Result;
use serde::Deserialize;
use std::collections::{BTreeMap, HashSet};
use std::path::{Path, PathBuf};
use tomo_proto::{NotificationSettings, AgentCommand, Config, ConfigIssue, HookDef, HookMode, IssueLevel, StateDef, HOOK_EVENTS};

pub struct Paths {
    pub data_dir: PathBuf,
    pub socket: PathBuf,
    pub db: PathBuf,
    pub config: PathBuf,
    pub scrollback_dir: PathBuf,
    pub integrations_dir: PathBuf,
    pub hook_log: PathBuf,
}

pub fn default_data_dir() -> PathBuf {
    if let Ok(dir) = std::env::var("TOMO_DATA_DIR") {
        return PathBuf::from(dir);
    }
    dirs::data_dir().unwrap_or_else(|| PathBuf::from(".")).join("tomo")
}

pub fn socket_path_for(data_dir: &Path) -> PathBuf {
    if let Ok(p) = std::env::var("TOMO_SOCKET") {
        return PathBuf::from(p);
    }
    data_dir.join("tomod.sock")
}

impl Paths {
    pub fn new(data_dir: PathBuf) -> Self {
        Paths {
            socket: socket_path_for(&data_dir),
            db: data_dir.join("tomo.sqlite3"),
            config: data_dir.join("config.toml"),
            scrollback_dir: data_dir.join("scrollback"),
            integrations_dir: data_dir.join("integrations"),
            hook_log: data_dir.join("hooks.log"),
            data_dir,
        }
    }

    pub fn ensure(&self) -> Result<()> {
        std::fs::create_dir_all(&self.scrollback_dir)?;
        std::fs::create_dir_all(&self.integrations_dir)?;
        Ok(())
    }
}

#[derive(Debug, Default, Deserialize)]
struct FileConfig {
    shell: Option<String>,
    editor_command: Option<Vec<String>>,
    worktree_parent_dir: Option<PathBuf>,
    resource_warning_gb: Option<f64>,
    scrollback_lines: Option<u32>,
    font_family: Option<String>,
    font_size: Option<u32>,
    theme: Option<String>,
    max_panes_per_tab: Option<u32>,
    #[serde(default)]
    keybindings: BTreeMap<String, String>,
    #[serde(default)]
    agents: BTreeMap<String, AgentCommandFile>,
    #[serde(default)]
    archive: ArchiveFile,
    #[serde(default)]
    states: Vec<StateFile>,
    #[serde(default)]
    hooks: Vec<HookFile>,
    #[serde(default)]
    notifications: NotificationsFile,
}

#[derive(Debug, Default, Deserialize)]
struct NotificationsFile {
    desktop: Option<bool>,
    sounds: Option<bool>,
}

#[derive(Debug, Deserialize)]
struct AgentCommandFile {
    command: String,
    #[serde(default)]
    args: Vec<String>,
}

#[derive(Debug, Default, Deserialize)]
struct ArchiveFile {
    cleanup: Option<Vec<String>>,
}

#[derive(Debug, Deserialize)]
struct StateFile {
    id: String,
    label: Option<String>,
    order: Option<i32>,
}

#[derive(Debug, Deserialize)]
struct HookFile {
    event: String,
    command: String,
    state: Option<String>,
    mode: Option<String>,
    timeout_s: Option<u64>,
}

pub const DEFAULT_CONFIG_TOML: &str = r#"# Tomo configuration. Every key is optional.
# Check it with: tomo config check

# shell = "/bin/zsh"
# editor_command = ["zed", "{path}"]
# worktree_parent_dir = "~/worktrees"
# resource_warning_gb = 2.0
# scrollback_lines = 10000
# font_family = "Geist Mono Variable, Menlo, monospace"
# font_size = 13
# theme = "system"   # system | dark | light
# max_panes_per_tab = 4

# Workflow states. A worktree has at most one state. Order controls grouping.
# [[states]]
# id = "exploring"
# label = "Exploring"
# order = 10
#
# [[states]]
# id = "active"
# label = "Active"
# order = 20
#
# [[states]]
# id = "waiting-review"
# label = "Waiting on review"
# order = 30
#
# [[states]]
# id = "merged"
# label = "Merged"
# order = 40

# Hooks run ordinary commands when something happens. The event JSON arrives
# on stdin and in TOMO_EVENT_JSON. mode = "pane" runs the command in a visible
# terminal pane of the worktree. `worktree.before_archive` is the only hook
# that Tomo waits for; a non-zero exit aborts the archive.
# Events: worktree.discovered, worktree.created, worktree.before_archive,
#   worktree.archived, worktree.restored, worktree.state_changed, pane.created,
#   pane.closed, agent.started, agent.working, agent.waiting, agent.idle,
#   agent.exited, attention.created
#
# [[hooks]]
# event = "worktree.created"
# command = "pnpm install"
# mode = "pane"
#
# [[hooks]]
# event = "worktree.state_changed"
# state = "merged"
# command = "~/.config/tomo/hooks/merged"

# [archive]
# cleanup = ["node_modules", "target", "dist", ".next", ".turbo", ".venv", "build"]

# [keybindings]
# home = "mod+h"
# palette = "mod+k"
# next_attention = "mod+shift+a"
# zoom_pane = "mod+shift+enter"

# [agents.claude]
# command = "claude"
# args = []
"#;

pub fn default_keybindings() -> BTreeMap<String, String> {
    [
        ("home", "mod+h"),
        ("palette", "mod+k"),
        ("next_attention", "mod+shift+a"),
        ("prev_worktree", "mod+shift+["),
        ("next_worktree", "mod+shift+]"),
        ("new_terminal", "mod+d"),
        ("split_vertical", "mod+shift+d"),
        ("new_tab", "mod+t"),
        ("close_pane", "mod+w"),
        ("focus_left", "mod+alt+left"),
        ("focus_right", "mod+alt+right"),
        ("focus_up", "mod+alt+up"),
        ("focus_down", "mod+alt+down"),
        ("toggle_left_sidebar", "mod+b"),
        ("toggle_right_sidebar", "mod+shift+b"),
        ("next_tab", "mod+shift+right"),
        ("prev_tab", "mod+shift+left"),
        ("zoom_pane", "mod+shift+enter"),
        ("move_tab_left", "mod+alt+shift+left"),
        ("move_tab_right", "mod+alt+shift+right"),
        ("move_pane_left", "mod+ctrl+alt+left"),
        ("move_pane_right", "mod+ctrl+alt+right"),
        ("move_pane_up", "mod+ctrl+alt+up"),
        ("move_pane_down", "mod+ctrl+alt+down"),
        ("equalize_splits", "mod+alt+e"),
    ]
    .into_iter()
    .map(|(k, v)| (k.to_string(), v.to_string()))
    .collect()
}

fn default_agents() -> BTreeMap<String, AgentCommand> {
    ["claude", "codex", "pi"]
        .into_iter()
        .map(|name| (name.to_string(), AgentCommand { command: name.to_string(), args: vec![] }))
        .collect()
}

pub fn default_archive_cleanup() -> Vec<String> {
    ["node_modules", "target", "dist", ".next", ".turbo", ".venv", "build"].into_iter().map(String::from).collect()
}

pub fn default_states() -> Vec<StateDef> {
    [("exploring", "Exploring", 10), ("active", "Active", 20), ("waiting-review", "Waiting on review", 30), ("merged", "Merged", 40)]
        .into_iter()
        .map(|(id, label, order)| StateDef { id: id.into(), label: label.into(), order })
        .collect()
}

pub fn expand_tilde(p: &Path) -> PathBuf {
    let s = p.to_string_lossy();
    match s.strip_prefix("~/") {
        Some(rest) => dirs::home_dir().unwrap_or_default().join(rest),
        None => p.to_path_buf(),
    }
}

pub fn load(path: &Path) -> Result<Config> {
    let file: FileConfig = match std::fs::read_to_string(path) {
        Ok(text) => match toml::from_str(&text) {
            Ok(file) => file,
            Err(e) => {
                tracing::warn!("{}: {e}; using defaults", path.display());
                FileConfig::default()
            }
        },
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            let _ = std::fs::write(path, DEFAULT_CONFIG_TOML);
            FileConfig::default()
        }
        Err(e) => return Err(e.into()),
    };
    Ok(merge(file))
}

fn merge(file: FileConfig) -> Config {
    let mut keybindings = default_keybindings();
    keybindings.extend(file.keybindings);
    let mut agents = default_agents();
    agents.extend(file.agents.into_iter().map(|(k, v)| (k, AgentCommand { command: v.command, args: v.args })));
    let states = if file.states.is_empty() {
        default_states()
    } else {
        file.states
            .into_iter()
            .enumerate()
            .map(|(i, s)| StateDef { label: s.label.unwrap_or_else(|| humanize(&s.id)), order: s.order.unwrap_or((i as i32 + 1) * 10), id: s.id })
            .collect()
    };
    let hooks = file
        .hooks
        .into_iter()
        .map(|h| HookDef {
            event: h.event,
            command: h.command,
            state: h.state,
            mode: if h.mode.as_deref() == Some("pane") { HookMode::Pane } else { HookMode::Async },
            timeout_s: h.timeout_s.unwrap_or(60),
        })
        .collect();
    Config {
        shell: file.shell.or_else(|| std::env::var("SHELL").ok()).unwrap_or_else(|| "/bin/zsh".into()),
        editor_command: file.editor_command.unwrap_or_else(|| vec!["zed".into(), "{path}".into()]),
        worktree_parent_dir: file.worktree_parent_dir.map(|p| expand_tilde(&p)),
        resource_warning_bytes: (file.resource_warning_gb.unwrap_or(2.0) * 1024.0 * 1024.0 * 1024.0) as u64,
        scrollback_lines: file.scrollback_lines.unwrap_or(10_000),
        font_family: file.font_family.unwrap_or_else(|| "Geist Mono Variable, Menlo, monospace".into()),
        font_size: file.font_size.unwrap_or(13),
        theme: file.theme.unwrap_or_else(|| "system".into()),
        max_panes_per_tab: file.max_panes_per_tab.unwrap_or(4).max(1),
        keybindings,
        agents,
        archive_cleanup: file.archive.cleanup.unwrap_or_else(default_archive_cleanup),
        states,
        hooks,
        notifications: NotificationSettings {
            desktop: file.notifications.desktop.unwrap_or(true),
            sounds: file.notifications.sounds.unwrap_or(false),
        },
    }
}

fn humanize(id: &str) -> String {
    let text = id.replace(['-', '_'], " ");
    let mut chars = text.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
        None => text,
    }
}

pub fn resolve_program(word: &str) -> Option<PathBuf> {
    let expanded = expand_tilde(Path::new(word));
    if expanded.components().count() > 1 {
        return expanded.is_file().then_some(expanded);
    }
    std::env::var("PATH").ok().and_then(|path| std::env::split_paths(&path).map(|d| d.join(word)).find(|p| p.is_file()))
}

fn issue(level: IssueLevel, key: &str, message: impl Into<String>) -> ConfigIssue {
    ConfigIssue { level, key: key.to_string(), message: message.into() }
}

/// Reports problems without changing behavior; the daemon already applied defaults.
pub fn check(cfg: &Config) -> Vec<ConfigIssue> {
    let mut out = Vec::new();
    if resolve_program(&cfg.shell).is_none() {
        out.push(issue(IssueLevel::Error, "shell", format!("{} is not an executable file", cfg.shell)));
    }
    match cfg.editor_command.first() {
        None => out.push(issue(IssueLevel::Error, "editor_command", "is empty")),
        Some(first) if resolve_program(first).is_none() => out.push(issue(IssueLevel::Warning, "editor_command", format!("{first} not found on PATH; Tomo falls back to `open`"))),
        _ => {}
    }
    if let Some(dir) = &cfg.worktree_parent_dir {
        if !dir.is_dir() {
            out.push(issue(IssueLevel::Warning, "worktree_parent_dir", format!("{} does not exist yet", dir.display())));
        }
    }
    let mut seen = HashSet::new();
    for s in &cfg.states {
        if s.id.trim().is_empty() || s.id.contains(char::is_whitespace) {
            out.push(issue(IssueLevel::Error, "states", format!("state id {:?} must be a single word", s.id)));
        }
        if !seen.insert(s.id.clone()) {
            out.push(issue(IssueLevel::Error, "states", format!("duplicate state id {}", s.id)));
        }
    }
    for (i, h) in cfg.hooks.iter().enumerate() {
        let key = format!("hooks[{i}]");
        if !HOOK_EVENTS.contains(&h.event.as_str()) {
            out.push(issue(IssueLevel::Error, &key, format!("unknown event {:?}; known: {}", h.event, HOOK_EVENTS.join(", "))));
        }
        let program = h.command.split_whitespace().next().unwrap_or("");
        if program.is_empty() {
            out.push(issue(IssueLevel::Error, &key, "command is empty"));
        } else if resolve_program(program).is_none() && !program.starts_with('.') {
            out.push(issue(IssueLevel::Warning, &key, format!("{program} not found on PATH; it will run through sh -c anyway")));
        }
        if let Some(state) = &h.state {
            if !cfg.states.iter().any(|s| &s.id == state) {
                out.push(issue(IssueLevel::Warning, &key, format!("filters on unknown state {state:?}")));
            }
            if h.event != "worktree.state_changed" {
                out.push(issue(IssueLevel::Warning, &key, "state filter only applies to worktree.state_changed"));
            }
        }
        if h.timeout_s == 0 {
            out.push(issue(IssueLevel::Error, &key, "timeout_s must be greater than 0"));
        }
    }
    for (action, binding) in &cfg.keybindings {
        let parts: Vec<&str> = binding.split('+').map(str::trim).collect();
        let key = parts.last().copied().unwrap_or("");
        if key.is_empty() || parts.iter().any(|p| p.is_empty()) {
            out.push(issue(IssueLevel::Error, "keybindings", format!("{action}: {binding:?} is not a valid binding")));
        }
    }
    for entry in &cfg.archive_cleanup {
        if entry.is_empty() || entry.contains('/') || entry == "." || entry == ".." {
            out.push(issue(IssueLevel::Error, "archive.cleanup", format!("{entry:?} must be a plain directory name")));
        }
    }
    for (name, agent) in &cfg.agents {
        if resolve_program(&agent.command).is_none() {
            out.push(issue(IssueLevel::Warning, &format!("agents.{name}"), format!("{} not found on PATH", agent.command)));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn user_keybindings_override_defaults_and_keep_the_rest() {
        let file: FileConfig = toml::from_str("[keybindings]\nhome = \"mod+shift+h\"\n").unwrap();
        let cfg = merge(file);
        assert_eq!(cfg.keybindings["home"], "mod+shift+h");
        assert_eq!(cfg.keybindings["palette"], "mod+k");
        assert_eq!(cfg.resource_warning_bytes, 2 * 1024 * 1024 * 1024);
        assert_eq!(cfg.states.len(), 4);
        assert!(cfg.hooks.is_empty());
        assert!(cfg.archive_cleanup.contains(&"node_modules".to_string()));
    }

    #[test]
    fn default_config_text_parses() {
        let file: FileConfig = toml::from_str(DEFAULT_CONFIG_TOML).unwrap();
        assert!(file.shell.is_none());
    }

    #[test]
    fn states_and_hooks_parse_with_defaults() {
        let file: FileConfig = toml::from_str(
            "[[states]]\nid = \"in-flight\"\n\n[[hooks]]\nevent = \"worktree.created\"\ncommand = \"echo hi\"\nmode = \"pane\"\n\n[archive]\ncleanup = [\"dist\"]\n",
        )
        .unwrap();
        let cfg = merge(file);
        assert_eq!(cfg.states[0].label, "In flight");
        assert_eq!(cfg.states[0].order, 10);
        assert_eq!(cfg.hooks[0].mode, HookMode::Pane);
        assert_eq!(cfg.hooks[0].timeout_s, 60);
        assert_eq!(cfg.archive_cleanup, vec!["dist".to_string()]);
    }

    #[test]
    fn check_reports_unknown_events_duplicate_states_and_bad_cleanup() {
        let file: FileConfig = toml::from_str(
            "[[states]]\nid = \"a\"\n[[states]]\nid = \"a\"\n[[hooks]]\nevent = \"nope.event\"\ncommand = \"sh\"\n[archive]\ncleanup = [\"../x\"]\n",
        )
        .unwrap();
        let cfg = merge(file);
        let issues = check(&cfg);
        let messages: Vec<String> = issues.iter().map(|i| i.message.clone()).collect();
        assert!(messages.iter().any(|m| m.contains("duplicate state id a")), "{messages:?}");
        assert!(messages.iter().any(|m| m.contains("unknown event")), "{messages:?}");
        assert!(messages.iter().any(|m| m.contains("plain directory name")), "{messages:?}");
    }
}
