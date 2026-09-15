use anyhow::Result;
use serde::Deserialize;
use std::collections::{BTreeMap, HashSet};
use std::path::{Path, PathBuf};
use tomo_proto::{AgentCommand, Config, ConfigIssue, HookDef, HookMode, IssueLevel, NotificationSettings, StateDef, ThemeConfig, HOOK_EVENTS};

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
    theme: Option<toml::Value>,
    terminal: Option<toml::Value>,
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
# editor_command = ["zed", "{path}"]   # Cmd-click path:line opens "{path}" as path:line:col
# editor_command = ["code", "-g", "{path}:{line}:{col}"]
# worktree_parent_dir = "~/worktrees"
# resource_warning_gb = 2.0
# scrollback_lines = 10000
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
# settings = "mod+,"
# next_attention = "mod+shift+a"
# zoom_pane = "mod+shift+enter"

# [agents.claude]
# command = "claude"
# args = []

# Theme. name: system | murasaki-dark | murasaki-light | paper | ink.
# With system, Tomo follows the macOS appearance and uses `light` or `dark`.
# Color keys override the base theme: bg, surface, surface_hover, fg,
# fg_muted, fg_faint, border, border_strong, accent, accent_soft, working,
# waiting, danger, success. Use #rgb or #rrggbb. accent also takes
# murasaki | sora | sakura | sumi.
# [theme]
# name = "system"
# light = "murasaki-light"
# dark = "murasaki-dark"
# accent = "sora"

# [terminal]
# font_family = "Geist Mono Variable, Menlo, monospace"
# font_size = 13

# [notifications]
# desktop = true
# sounds = false
"#;

pub const DEFAULT_FONT_FAMILY: &str = "Geist Mono Variable, Menlo, monospace";
pub const THEME_TOKENS: [&str; 14] = ["bg", "surface", "surface_hover", "fg", "fg_muted", "fg_faint", "border", "border_strong", "accent", "accent_soft", "working", "waiting", "danger", "success"];
const BASE_THEMES: [&str; 5] = ["system", "murasaki-dark", "murasaki-light", "paper", "ink"];
const ACCENT_PRESETS: [&str; 4] = ["murasaki", "sora", "sakura", "sumi"];
const SETTABLE_KEYS: [&str; 14] = [
    "shell",
    "editor_command",
    "worktree_parent_dir",
    "resource_warning_gb",
    "scrollback_lines",
    "font_family",
    "font_size",
    "max_panes_per_tab",
    "theme",
    "terminal",
    "keybindings",
    "agents",
    "archive",
    "notifications",
];

pub fn default_keybindings() -> BTreeMap<String, String> {
    [
        ("home", "mod+h"),
        ("palette", "mod+k"),
        ("settings", "mod+,"),
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
        ("equalize_panes", "mod+alt+e"),
        ("reopen_tab", "mod+shift+t"),
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

/// The config for this file, plus the problems found while it was read. Bad values fall back to defaults.
pub fn load_checked(path: &Path) -> Result<(Config, Vec<ConfigIssue>)> {
    match std::fs::read_to_string(path) {
        Ok(text) => {
            let (cfg, issues) = parse(&text);
            for i in &issues {
                tracing::warn!("{}: {}: {}", path.display(), i.key, i.message);
            }
            Ok((cfg, issues))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            let _ = std::fs::write(path, DEFAULT_CONFIG_TOML);
            Ok(merge(FileConfig::default()))
        }
        Err(e) => Err(e.into()),
    }
}

pub fn load(path: &Path) -> Result<Config> {
    load_checked(path).map(|(cfg, _)| cfg)
}

pub fn parse(text: &str) -> (Config, Vec<ConfigIssue>) {
    match toml::from_str::<FileConfig>(text) {
        Ok(file) => merge(file),
        Err(e) => {
            let (cfg, _) = merge(FileConfig::default());
            (cfg, vec![issue(IssueLevel::Error, "config.toml", format!("{}; Tomo uses the defaults", e.message()))])
        }
    }
}

fn merge(file: FileConfig) -> (Config, Vec<ConfigIssue>) {
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
    let (theme, theme_issues) = parse_theme(file.theme.as_ref());
    let (font_family, font_size, terminal_issues) = parse_terminal(file.terminal.as_ref(), file.font_family, file.font_size);
    let cfg = Config {
        shell: file.shell.or_else(|| std::env::var("SHELL").ok()).unwrap_or_else(|| "/bin/zsh".into()),
        editor_command: file.editor_command.unwrap_or_else(|| vec!["zed".into(), "{path}".into()]),
        worktree_parent_dir: file.worktree_parent_dir.map(|p| expand_tilde(&p)),
        resource_warning_bytes: (file.resource_warning_gb.unwrap_or(2.0) * 1024.0 * 1024.0 * 1024.0) as u64,
        scrollback_lines: file.scrollback_lines.unwrap_or(10_000),
        font_family,
        font_size,
        theme,
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
    };
    (cfg, [theme_issues, terminal_issues].concat())
}

/// A value, or its fallback together with the reason the value was refused.
type Checked<T> = Result<T, (T, ConfigIssue)>;

fn settle<T>(checked: Checked<T>) -> (T, Option<ConfigIssue>) {
    match checked {
        Ok(v) => (v, None),
        Err((fallback, why)) => (fallback, Some(why)),
    }
}

fn unknown_keys<'a>(section: &'a str, table: &'a toml::Table, known: &'a [&'a str]) -> impl Iterator<Item = ConfigIssue> + 'a {
    table.keys().filter(move |k| !known.contains(&k.as_str())).map(move |k| issue(IssueLevel::Warning, &format!("{section}.{k}"), "unknown key; Tomo ignores it"))
}

fn theme_id(name: &str) -> Option<&'static str> {
    match name.trim().to_lowercase().replace([' ', '_'], "-").as_str() {
        "dark" => Some("murasaki-dark"),
        "light" => Some("murasaki-light"),
        other => BASE_THEMES.into_iter().find(|t| *t == other),
    }
}

fn is_hex_color(s: &str) -> bool {
    s.strip_prefix('#').map_or(false, |h| (h.len() == 3 || h.len() == 6) && h.chars().all(|c| c.is_ascii_hexdigit()))
}

fn theme_name_at(table: &toml::Table, key: &str, fallback: &str, allow_system: bool) -> Checked<String> {
    let refuse = |message: String| Err((fallback.to_string(), issue(IssueLevel::Error, &format!("theme.{key}"), message)));
    match table.get(key) {
        None => Ok(fallback.to_string()),
        Some(toml::Value::String(s)) => match theme_id(s).filter(|id| allow_system || *id != "system") {
            Some(id) => Ok(id.to_string()),
            None => refuse(format!("unknown theme {s:?}; use {}", BASE_THEMES.iter().filter(|t| allow_system || **t != "system").copied().collect::<Vec<_>>().join(", "))),
        },
        Some(v) => refuse(format!("must be a theme name, not {v}")),
    }
}

fn theme_color(key: &str, value: &toml::Value) -> Result<(String, String), ConfigIssue> {
    let refuse = |message: String| Err(issue(IssueLevel::Error, &format!("theme.{key}"), message));
    match value.as_str().map(|s| s.trim().to_lowercase()) {
        Some(s) if is_hex_color(&s) => Ok((key.to_string(), s)),
        Some(s) if key == "accent" && ACCENT_PRESETS.contains(&s.as_str()) => Ok((key.to_string(), s)),
        Some(_) => refuse(format!("{value} is not a color; use #rgb or #rrggbb")),
        None => refuse(format!("must be a color string, not {value}")),
    }
}

fn parse_theme(value: Option<&toml::Value>) -> (ThemeConfig, Vec<ConfigIssue>) {
    let base = ThemeConfig::default();
    let table = match value {
        None => return (base, vec![]),
        Some(toml::Value::String(s)) => {
            return match theme_id(s) {
                Some(id) => (ThemeConfig { name: id.into(), ..base }, vec![]),
                None => (base, vec![issue(IssueLevel::Error, "theme", format!("unknown theme {s:?}; Tomo uses system"))]),
            }
        }
        Some(toml::Value::Table(t)) => t,
        Some(v) => return (base, vec![issue(IssueLevel::Error, "theme", format!("must be a [theme] table, not {v}"))]),
    };
    let (name, name_issue) = settle(theme_name_at(table, "name", &base.name, true));
    let (light, light_issue) = settle(theme_name_at(table, "light", &base.light, false));
    let (dark, dark_issue) = settle(theme_name_at(table, "dark", &base.dark, false));
    let (colors, color_issues): (Vec<_>, Vec<_>) = THEME_TOKENS.iter().filter_map(|t| table.get(*t).map(|v| theme_color(t, v))).partition(Result::is_ok);
    let known: Vec<&str> = ["name", "light", "dark"].into_iter().chain(THEME_TOKENS).collect();
    let issues = [name_issue, light_issue, dark_issue]
        .into_iter()
        .flatten()
        .chain(color_issues.into_iter().filter_map(Result::err))
        .chain(unknown_keys("theme", table, &known))
        .collect();
    (ThemeConfig { name, light, dark, colors: colors.into_iter().filter_map(Result::ok).collect() }, issues)
}

/// `[terminal]` wins over the older top-level `font_family` and `font_size`.
fn parse_terminal(value: Option<&toml::Value>, legacy_family: Option<String>, legacy_size: Option<u32>) -> (String, u32, Vec<ConfigIssue>) {
    let family = legacy_family.unwrap_or_else(|| DEFAULT_FONT_FAMILY.into());
    let size = legacy_size.unwrap_or(13);
    let table = match value {
        None => return (family, size, vec![]),
        Some(toml::Value::Table(t)) => t,
        Some(v) => return (family, size, vec![issue(IssueLevel::Error, "terminal", format!("must be a [terminal] table, not {v}"))]),
    };
    let family: Checked<String> = match table.get("font_family") {
        None => Ok(family),
        Some(toml::Value::String(s)) if !s.trim().is_empty() => Ok(s.trim().to_string()),
        Some(v) => Err((family, issue(IssueLevel::Error, "terminal.font_family", format!("must be a font name, not {v}")))),
    };
    let size: Checked<u32> = match table.get("font_size") {
        None => Ok(size),
        Some(toml::Value::Integer(n)) if (6..=72).contains(n) => Ok(*n as u32),
        Some(v) => Err((size, issue(IssueLevel::Error, "terminal.font_size", format!("{v} must be a whole number from 6 to 72")))),
    };
    let (family, family_issue) = settle(family);
    let (size, size_issue) = settle(size);
    let issues = [family_issue, size_issue].into_iter().flatten().chain(unknown_keys("terminal", table, &["font_family", "font_size"])).collect();
    (family, size, issues)
}

fn json_to_toml(value: &serde_json::Value) -> std::result::Result<toml_edit::Value, String> {
    use serde_json::Value as J;
    match value {
        J::String(s) => Ok(s.as_str().into()),
        J::Bool(b) => Ok((*b).into()),
        J::Number(n) => n.as_i64().map(toml_edit::Value::from).or_else(|| n.as_f64().map(toml_edit::Value::from)).ok_or_else(|| format!("{n} is out of range")),
        J::Array(items) => items.iter().map(json_to_toml).collect::<std::result::Result<toml_edit::Array, _>>().map(toml_edit::Value::Array),
        J::Null | J::Object(_) => Err("set one key at a time with a dotted key".into()),
    }
}

fn implicit_table() -> toml_edit::Item {
    let mut t = toml_edit::Table::new();
    t.set_implicit(true);
    toml_edit::Item::Table(t)
}

/// Sets or removes (`null`) one dotted key in config text. Comments, order, and formatting stay as they were.
pub fn set_value(text: &str, key: &str, value: &serde_json::Value) -> std::result::Result<String, String> {
    let parts: Vec<&str> = key.split('.').map(str::trim).collect();
    if parts.iter().any(|p| p.is_empty()) || !SETTABLE_KEYS.contains(&parts[0]) {
        return Err(format!("{key:?} is not a config key that Tomo can set"));
    }
    let mut doc: toml_edit::DocumentMut = text.parse().map_err(|e: toml_edit::TomlError| format!("config.toml does not parse: {}", e.message()))?;
    if parts[0] == "theme" && parts.len() > 1 {
        if let Some(legacy) = doc.get("theme").and_then(|i| i.as_str()).map(str::to_string) {
            let mut t = toml_edit::Table::new();
            t.insert("name", toml_edit::value(legacy));
            doc.as_table_mut().insert("theme", toml_edit::Item::Table(t));
        }
    }
    let (last, parents) = parts.split_last().expect("split always yields one part");
    let mut table: &mut dyn toml_edit::TableLike = doc.as_table_mut();
    for part in parents {
        table = table.entry(part).or_insert_with(implicit_table).as_table_like_mut().ok_or_else(|| format!("{part} is not a table in config.toml"))?;
    }
    if value.is_null() {
        table.remove(last);
    } else {
        let mut next = json_to_toml(value)?;
        match table.get_mut(last) {
            Some(toml_edit::Item::Value(old)) => {
                *next.decor_mut() = old.decor().clone();
                *old = next;
            }
            Some(toml_edit::Item::Table(_)) | Some(toml_edit::Item::ArrayOfTables(_)) => return Err(format!("{key} is a table; set one of its keys")),
            _ => {
                table.insert(last, toml_edit::Item::Value(next));
            }
        }
    }
    let out = doc.to_string();
    if toml::from_str::<FileConfig>(text).is_ok() {
        toml::from_str::<FileConfig>(&out).map_err(|e| format!("{key}: {}", e.message()))?;
    }
    Ok(out)
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
    use serde_json::json;

    fn issue_keys(issues: &[ConfigIssue]) -> Vec<&str> {
        issues.iter().map(|i| i.key.as_str()).collect()
    }

    #[test]
    fn user_keybindings_override_defaults_and_keep_the_rest() {
        let (cfg, _) = parse("[keybindings]\nhome = \"mod+shift+h\"\n");
        assert_eq!(cfg.keybindings["home"], "mod+shift+h");
        assert_eq!(cfg.keybindings["palette"], "mod+k");
        assert_eq!(cfg.keybindings["settings"], "mod+,");
        assert_eq!(cfg.resource_warning_bytes, 2 * 1024 * 1024 * 1024);
        assert_eq!(cfg.states.len(), 4);
        assert!(cfg.hooks.is_empty());
        assert!(cfg.archive_cleanup.contains(&"node_modules".to_string()));
    }

    #[test]
    fn default_config_text_parses() {
        let (cfg, issues) = parse(DEFAULT_CONFIG_TOML);
        assert!(issues.is_empty(), "{issues:?}");
        assert_eq!(cfg.theme, ThemeConfig::default());
        assert_eq!(cfg.font_size, 13);
    }

    #[test]
    fn states_and_hooks_parse_with_defaults() {
        let (cfg, _) = parse("[[states]]\nid = \"in-flight\"\n\n[[hooks]]\nevent = \"worktree.created\"\ncommand = \"echo hi\"\nmode = \"pane\"\n\n[archive]\ncleanup = [\"dist\"]\n");
        assert_eq!(cfg.states[0].label, "In flight");
        assert_eq!(cfg.states[0].order, 10);
        assert_eq!(cfg.hooks[0].mode, HookMode::Pane);
        assert_eq!(cfg.hooks[0].timeout_s, 60);
        assert_eq!(cfg.archive_cleanup, vec!["dist".to_string()]);
    }

    #[test]
    fn check_reports_unknown_events_duplicate_states_and_bad_cleanup() {
        let (cfg, _) = parse("[[states]]\nid = \"a\"\n[[states]]\nid = \"a\"\n[[hooks]]\nevent = \"nope.event\"\ncommand = \"sh\"\n[archive]\ncleanup = [\"../x\"]\n");
        let issues = check(&cfg);
        let messages: Vec<String> = issues.iter().map(|i| i.message.clone()).collect();
        assert!(messages.iter().any(|m| m.contains("duplicate state id a")), "{messages:?}");
        assert!(messages.iter().any(|m| m.contains("unknown event")), "{messages:?}");
        assert!(messages.iter().any(|m| m.contains("plain directory name")), "{messages:?}");
    }

    #[test]
    fn valid_theme_table_and_terminal_section() {
        let (cfg, issues) = parse(
            "[theme]\nname = \"Murasaki Light\"\nlight = \"paper\"\ndark = \"ink\"\nbg = \"#0F0F12\"\nsurface = \"#17171c\"\naccent = \"sora\"\n\n[terminal]\nfont_family = \"Berkeley Mono\"\nfont_size = 15\n",
        );
        assert!(issues.is_empty(), "{issues:?}");
        assert_eq!(cfg.theme.name, "murasaki-light");
        assert_eq!((cfg.theme.light.as_str(), cfg.theme.dark.as_str()), ("paper", "ink"));
        assert_eq!(cfg.theme.colors["bg"], "#0f0f12");
        assert_eq!(cfg.theme.colors["accent"], "sora");
        assert_eq!((cfg.font_family.as_str(), cfg.font_size), ("Berkeley Mono", 15));
    }

    #[test]
    fn partial_theme_override_keeps_the_base_for_the_rest() {
        let (cfg, issues) = parse("[theme]\naccent = \"#abc\"\n");
        assert!(issues.is_empty(), "{issues:?}");
        assert_eq!(cfg.theme.name, "system");
        assert_eq!(cfg.theme.dark, "murasaki-dark");
        assert_eq!(cfg.theme.colors.len(), 1);
    }

    #[test]
    fn malformed_theme_falls_back_to_murasaki_and_keeps_the_rest_of_the_file() {
        let (cfg, issues) = parse("[theme]\nname = \"neon\"\ndark = \"system\"\nbg = \"blue\"\nfg = 5\naccent = \"#12345\"\nsparkle = \"#fff\"\nborder = \"#FFF\"\n\n[terminal]\nfont_size = 400\nligatures = true\n\n[keybindings]\nhome = \"mod+j\"\n");
        assert_eq!(cfg.theme.name, "system");
        assert_eq!(cfg.theme.dark, "murasaki-dark");
        assert_eq!(cfg.theme.colors.keys().collect::<Vec<_>>(), vec!["border"]);
        assert_eq!(cfg.font_size, 13);
        assert_eq!(cfg.keybindings["home"], "mod+j");
        let keys = issue_keys(&issues);
        for k in ["theme.name", "theme.dark", "theme.bg", "theme.fg", "theme.accent", "theme.sparkle", "terminal.font_size", "terminal.ligatures"] {
            assert!(keys.contains(&k), "missing {k} in {keys:?}");
        }
        assert!(issues.iter().any(|i| i.key == "theme.sparkle" && i.level == IssueLevel::Warning));
    }

    #[test]
    fn legacy_top_level_theme_and_font_keys_still_work() {
        let (cfg, issues) = parse("theme = \"dark\"\nfont_family = \"Menlo\"\nfont_size = 15\n");
        assert!(issues.is_empty(), "{issues:?}");
        assert_eq!(cfg.theme.name, "murasaki-dark");
        assert_eq!((cfg.font_family.as_str(), cfg.font_size), ("Menlo", 15));
        let (cfg, _) = parse("font_size = 15\n[terminal]\nfont_size = 16\n");
        assert_eq!(cfg.font_size, 16);
        let (cfg, issues) = parse("theme = 5\n");
        assert_eq!(cfg.theme, ThemeConfig::default());
        assert_eq!(issue_keys(&issues), vec!["theme"]);
    }

    #[test]
    fn a_file_that_does_not_parse_reports_one_issue_and_uses_defaults() {
        let (cfg, issues) = parse("[theme\nname = \"ink\"\n");
        assert_eq!(cfg.theme, ThemeConfig::default());
        assert_eq!(issue_keys(&issues), vec!["config.toml"]);
    }

    const COMMENTED: &str = "# my tomo config\nshell = \"/bin/zsh\" # login shell\n\n# keys I like\n[keybindings]\nhome = \"mod+j\" # muscle memory\n";

    #[test]
    fn set_value_round_trip_keeps_comments_and_formatting() {
        let out = set_value(COMMENTED, "keybindings.home", &json!("mod+shift+h")).unwrap();
        assert_eq!(out, COMMENTED.replace("\"mod+j\"", "\"mod+shift+h\""));
        let out = set_value(&out, "theme.name", &json!("paper")).unwrap();
        let out = set_value(&out, "terminal.font_size", &json!(15)).unwrap();
        let out = set_value(&out, "notifications.sounds", &json!(true)).unwrap();
        assert!(out.starts_with(&COMMENTED.replace("\"mod+j\"", "\"mod+shift+h\"")), "{out}");
        assert!(out.contains("[theme]\nname = \"paper\"\n"), "{out}");
        let (cfg, issues) = parse(&out);
        assert!(issues.is_empty(), "{issues:?}");
        assert_eq!((cfg.theme.name.as_str(), cfg.font_size, cfg.notifications.sounds), ("paper", 15, true));
        assert_eq!(cfg.keybindings["home"], "mod+shift+h");
        let removed = set_value(&out, "keybindings.home", &serde_json::Value::Null).unwrap();
        assert!(!removed.contains("mod+shift+h") && removed.contains("# keys I like"), "{removed}");
        assert_eq!(parse(&removed).0.keybindings["home"], "mod+h");
    }

    #[test]
    fn set_value_writes_nested_tables_and_arrays() {
        assert!(set_value("", "agents.claude.args", &json!(["--verbose"])).is_err(), "an agent table without a command does not parse");
        let out = set_value("", "agents.claude.command", &json!("claude")).unwrap();
        let out = set_value(&out, "agents.claude.args", &json!(["--verbose"])).unwrap();
        assert_eq!(out, "[agents.claude]\ncommand = \"claude\"\nargs = [\"--verbose\"]\n");
        assert_eq!(parse(&out).0.agents["claude"].args, vec!["--verbose".to_string()]);
        let out = set_value(&out, "agents.claude", &serde_json::Value::Null).unwrap();
        assert_eq!(parse(&out).0.agents["claude"].command, "claude");
    }

    #[test]
    fn set_value_turns_a_legacy_theme_string_into_a_table() {
        let out = set_value("theme = \"dark\"\n", "theme.accent", &json!("sakura")).unwrap();
        let (cfg, issues) = parse(&out);
        assert!(issues.is_empty(), "{issues:?} in {out}");
        assert_eq!(cfg.theme.name, "murasaki-dark");
        assert_eq!(cfg.theme.colors["accent"], "sakura");
    }

    #[test]
    fn set_value_refuses_changes_that_would_break_the_file() {
        assert!(set_value(COMMENTED, "keybindings.home", &json!(5)).is_err());
        assert!(set_value(COMMENTED, "keybindings", &json!("x")).is_err());
        assert!(set_value(COMMENTED, "shell.path", &json!("x")).is_err());
        assert!(set_value(COMMENTED, "sparkle", &json!(true)).is_err());
        assert!(set_value(COMMENTED, "states.0.id", &json!("x")).is_err());
        assert!(set_value(COMMENTED, "theme..name", &json!("ink")).is_err());
        assert!(set_value(COMMENTED, "theme", &json!({"name": "ink"})).is_err());
    }
}
