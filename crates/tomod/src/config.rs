use anyhow::Result;
use serde::Deserialize;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use tomo_proto::{AgentCommand, Config, ConfigIssue, HookDef, HookMode, IssueLevel, NotificationSettings, ThemeConfig, HOOK_EVENTS};

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
    branch_prefix: Option<String>,
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
    states: Option<toml::Value>,
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

#[derive(Debug, Deserialize)]
struct HookFile {
    event: String,
    command: String,
    tag: Option<String>,
    mode: Option<String>,
    timeout_s: Option<u64>,
}

pub const DEFAULT_CONFIG_TOML: &str = r#"# Tomo configuration. Every key is optional.
# Check it with: tomo config check

# shell = "/bin/zsh"
# editor_command = ["zed", "{path}"]   # Cmd-click path:line opens "{path}" as path:line:col
# editor_command = ["code", "-g", "{path}:{line}:{col}"]
# worktree_parent_dir = "~/worktrees"   # default: ~/tomo/worktrees/<repo>/<worktree>
# branch_prefix = "simon/"   # a create with no branch gets <branch_prefix><worktree name>
# resource_warning_gb = 2.0
# scrollback_lines = 10000
# max_panes_per_tab = 4   # a split into a full tab opens a new tab; 1 means tabs only, no splits

# Hooks run ordinary commands when something happens. The event JSON arrives
# on stdin and in TOMO_EVENT_JSON. mode = "pane" runs the command in a visible
# terminal pane of the worktree. `worktree.before_archive` is the only hook
# that Tomo waits for; a non-zero exit aborts the archive.
# Events: worktree.discovered, worktree.created, worktree.before_archive,
#   worktree.archived, worktree.restored, worktree.tags_changed, pane.created,
#   pane.closed, agent.started, agent.working, agent.waiting, agent.idle,
#   agent.exited, attention.created, checkpoint.created, checkpoint.resolved.
#   An addon can add events of its own.
#
# [[hooks]]
# event = "worktree.created"
# command = "pnpm install"
# mode = "pane"
#
# [[hooks]]
# event = "worktree.tags_changed"
# tag = "merged"
# command = "~/.config/tomo/hooks/merged"

# Archive deletes the heavy build directories before it removes the worktree.
# The hook runs in the worktree. Change the list, or delete the hook to keep them.
[[hooks]]
event = "worktree.before_archive"
command = "rm -rf node_modules target dist .next .turbo .venv build"

# [keybindings]
# home = "mod+h"
# palette = "mod+k"
# settings = "mod+,"
# next_attention = "mod+shift+a"
# zoom_pane = "mod+shift+enter"

# [agents.claude]
# command = "claude"
# args = []

# Theme. name: system | slab-dark | slab-light.
# With system, Tomo follows the macOS appearance and uses `light` or `dark`.
# Color keys override the base theme: bg, surface, surface_hover, fg,
# fg_muted, fg_faint, border, border_strong, accent, accent_soft, working,
# waiting, danger, success. Use #rgb or #rrggbb.
# [theme]
# name = "system"
# light = "slab-light"
# dark = "slab-dark"

# [terminal]
# font_family = "CommitMono, Menlo, monospace"
# font_size = 13

# [notifications]
# desktop = true
# sounds = false
"#;

pub const DEFAULT_FONT_FAMILY: &str = "CommitMono, Menlo, monospace";
pub const THEME_TOKENS: [&str; 14] = [
    "bg",
    "surface",
    "surface_hover",
    "fg",
    "fg_muted",
    "fg_faint",
    "border",
    "border_strong",
    "accent",
    "accent_soft",
    "working",
    "waiting",
    "danger",
    "success",
];
const BASE_THEMES: [&str; 3] = ["system", "slab-dark", "slab-light"];
/// Accent presets from before slab, which has no hue. A preset now gives a warning and no color.
const RETIRED_ACCENT_PRESETS: [&str; 4] = ["murasaki", "sora", "sakura", "sumi"];
const SETTABLE_KEYS: [&str; 14] = [
    "shell",
    "editor_command",
    "worktree_parent_dir",
    "branch_prefix",
    "resource_warning_gb",
    "scrollback_lines",
    "font_family",
    "font_size",
    "max_panes_per_tab",
    "theme",
    "terminal",
    "keybindings",
    "agents",
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
    tomo_proto::AgentKind::all()
        .into_iter()
        .map(|kind| {
            let name = kind.label().to_lowercase();
            (name.clone(), AgentCommand { command: name, args: vec![] })
        })
        .collect()
}

pub fn expand_tilde(p: &Path) -> PathBuf {
    let s = p.to_string_lossy();
    match s.strip_prefix("~/") {
        Some(rest) => dirs::home_dir().unwrap_or_default().join(rest),
        None => p.to_path_buf(),
    }
}

/// The directory that holds the new worktrees of one repository. `worktree_parent_dir` wins
/// whole and stays flat. Without it the parent is `~/tomo/worktrees/<repository directory name>`.
/// Two repositories with the same directory name share one directory; a name that is already
/// taken there fails in `git worktree add`, as it does today.
pub fn worktree_parent(parent_dir: Option<&Path>, repo_path: &Path) -> PathBuf {
    match parent_dir {
        Some(dir) => dir.to_path_buf(),
        None => {
            let repo = repo_path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "repo".into());
            dirs::home_dir().unwrap_or_default().join("tomo").join("worktrees").join(repo)
        }
    }
}

/// The branch of a create that names no branch: `branch_prefix` before the worktree name,
/// so `simon/` and `aogashima` give `simon/aogashima`. An empty prefix gives the bare name.
pub fn default_branch(prefix: &str, worktree_name: &str) -> String {
    format!("{}{}", prefix.trim(), worktree_name.trim())
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
            Ok(parse(DEFAULT_CONFIG_TOML))
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
    let hooks = file
        .hooks
        .into_iter()
        .map(|h| HookDef {
            event: h.event,
            command: h.command,
            tag: h.tag,
            mode: if h.mode.as_deref() == Some("pane") { HookMode::Pane } else { HookMode::Async },
            timeout_s: h.timeout_s.unwrap_or(60),
        })
        .collect();
    let (theme, theme_issues) = parse_theme(file.theme.as_ref());
    let (font_family, font_size, vt_engine, terminal_issues) = parse_terminal(file.terminal.as_ref(), file.font_family, file.font_size);
    let cfg = Config {
        shell: file.shell.or_else(|| std::env::var("SHELL").ok()).unwrap_or_else(|| "/bin/zsh".into()),
        editor_command: file.editor_command.unwrap_or_else(|| vec!["zed".into(), "{path}".into()]),
        worktree_parent_dir: file.worktree_parent_dir.map(|p| expand_tilde(&p)),
        branch_prefix: file.branch_prefix.unwrap_or_default(),
        resource_warning_bytes: (file.resource_warning_gb.unwrap_or(2.0) * 1024.0 * 1024.0 * 1024.0) as u64,
        scrollback_lines: file.scrollback_lines.unwrap_or(10_000),
        vt_engine,
        font_family,
        font_size,
        theme,
        max_panes_per_tab: file.max_panes_per_tab.unwrap_or(4).max(1),
        keybindings,
        agents,
        hooks,
        notifications: NotificationSettings { desktop: file.notifications.desktop.unwrap_or(true), sounds: file.notifications.sounds.unwrap_or(false) },
    };
    let states_issue = file.states.map(|_| issue(IssueLevel::Warning, "states", "workflow states are gone; tags replace them. Remove [[states]]."));
    (cfg, [theme_issues, terminal_issues, states_issue.into_iter().collect()].concat())
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
    table
        .keys()
        .filter(move |k| !known.contains(&k.as_str()))
        .map(move |k| issue(IssueLevel::Warning, &format!("{section}.{k}"), "unknown key; Tomo ignores it"))
}

fn theme_id(name: &str) -> Option<&'static str> {
    match name.trim().to_lowercase().replace([' ', '_'], "-").as_str() {
        "dark" | "murasaki-dark" | "ink" => Some("slab-dark"),
        "light" | "murasaki-light" | "paper" => Some("slab-light"),
        other => BASE_THEMES.into_iter().find(|t| *t == other),
    }
}

fn is_hex_color(s: &str) -> bool {
    s.strip_prefix('#').is_some_and(|h| (h.len() == 3 || h.len() == 6) && h.chars().all(|c| c.is_ascii_hexdigit()))
}

fn theme_name_at(table: &toml::Table, key: &str, fallback: &str, allow_system: bool) -> Checked<String> {
    let refuse = |message: String| Err((fallback.to_string(), issue(IssueLevel::Error, &format!("theme.{key}"), message)));
    match table.get(key) {
        None => Ok(fallback.to_string()),
        Some(toml::Value::String(s)) => match theme_id(s).filter(|id| allow_system || *id != "system") {
            Some(id) => Ok(id.to_string()),
            None => refuse(format!(
                "unknown theme {s:?}; use {}",
                BASE_THEMES.iter().filter(|t| allow_system || **t != "system").copied().collect::<Vec<_>>().join(", ")
            )),
        },
        Some(v) => refuse(format!("must be a theme name, not {v}")),
    }
}

fn theme_color(key: &str, value: &toml::Value) -> Result<(String, String), ConfigIssue> {
    let refuse = |message: String| Err(issue(IssueLevel::Error, &format!("theme.{key}"), message));
    match value.as_str().map(|s| s.trim().to_lowercase()) {
        Some(s) if is_hex_color(&s) => Ok((key.to_string(), s)),
        Some(s) if key == "accent" && RETIRED_ACCENT_PRESETS.contains(&s.as_str()) => {
            Err(issue(IssueLevel::Warning, "theme.accent", format!("the {s} preset is gone; slab has no hue, so Tomo ignores it")))
        }
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
fn parse_terminal(value: Option<&toml::Value>, legacy_family: Option<String>, legacy_size: Option<u32>) -> (String, u32, String, Vec<ConfigIssue>) {
    let family = legacy_family.unwrap_or_else(|| DEFAULT_FONT_FAMILY.into());
    let size = legacy_size.unwrap_or(13);
    let default_engine = crate::vt::VtEngine::default().name().to_string();
    let table = match value {
        None => return (family, size, default_engine, vec![]),
        Some(toml::Value::Table(t)) => t,
        Some(v) => return (family, size, default_engine, vec![issue(IssueLevel::Error, "terminal", format!("must be a [terminal] table, not {v}"))]),
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
    let engine: Checked<String> = match table.get("engine") {
        None => Ok(default_engine.clone()),
        Some(toml::Value::String(s)) => match crate::vt::VtEngine::parse(s.trim()) {
            Some(e) if e.available() => Ok(e.name().to_string()),
            Some(e) => Err((
                default_engine.clone(),
                issue(IssueLevel::Warning, "terminal.engine", format!("{} is not in this build; using {default_engine}", e.name())),
            )),
            None => Err((default_engine.clone(), issue(IssueLevel::Error, "terminal.engine", format!("{s:?} must be rio, ghostty, or xterm")))),
        },
        Some(v) => Err((default_engine.clone(), issue(IssueLevel::Error, "terminal.engine", format!("must be an engine name, not {v}")))),
    };
    let (family, family_issue) = settle(family);
    let (size, size_issue) = settle(size);
    let (engine, engine_issue) = settle(engine);
    let issues = [family_issue, size_issue, engine_issue]
        .into_iter()
        .flatten()
        .chain(unknown_keys("terminal", table, &["font_family", "font_size", "engine"]))
        .collect();
    (family, size, engine, issues)
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

/// A word that starts with U+2010 to U+2015 or U+2212 looks like a flag but is
/// not one. An editor writes these when it "improves" `--`, and the agent takes
/// the word as a positional operand, which Claude Code sends as its first
/// message. A warning only, because a Unicode argument can be deliberate.
fn unicode_dash(arg: &str) -> Option<char> {
    arg.chars().next().filter(|c| matches!(c, '\u{2010}'..='\u{2015}' | '\u{2212}'))
}

/// Reports problems without changing behavior; the daemon already applied defaults.
/// `addon_events` are the hook events that addons fire, beside Core's `HOOK_EVENTS`.
pub fn check(cfg: &Config, addon_events: &[&str]) -> Vec<ConfigIssue> {
    let mut out = Vec::new();
    if resolve_program(&cfg.shell).is_none() {
        out.push(issue(IssueLevel::Error, "shell", format!("{} is not an executable file", cfg.shell)));
    }
    match cfg.editor_command.first() {
        None => out.push(issue(IssueLevel::Error, "editor_command", "is empty")),
        Some(first) if resolve_program(first).is_none() => {
            out.push(issue(IssueLevel::Warning, "editor_command", format!("{first} not found on PATH; Tomo falls back to `open`")))
        }
        _ => {}
    }
    if let Some(dir) = &cfg.worktree_parent_dir {
        if !dir.is_dir() {
            out.push(issue(IssueLevel::Warning, "worktree_parent_dir", format!("{} does not exist yet", dir.display())));
        }
    }
    for (i, h) in cfg.hooks.iter().enumerate() {
        let key = format!("hooks[{i}]");
        if !HOOK_EVENTS.contains(&h.event.as_str()) && !addon_events.contains(&h.event.as_str()) {
            let known = [HOOK_EVENTS, addon_events].concat().join(", ");
            out.push(issue(IssueLevel::Error, &key, format!("unknown event {:?}; known: {known}", h.event)));
        }
        let program = h.command.split_whitespace().next().unwrap_or("");
        if program.is_empty() {
            out.push(issue(IssueLevel::Error, &key, "command is empty"));
        } else if resolve_program(program).is_none() && !program.starts_with('.') {
            out.push(issue(IssueLevel::Warning, &key, format!("{program} not found on PATH; it will run through sh -c anyway")));
        }
        if h.tag.is_some() && h.event != "worktree.tags_changed" {
            out.push(issue(IssueLevel::Warning, &key, "tag filter only applies to worktree.tags_changed"));
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
    for (name, agent) in &cfg.agents {
        if resolve_program(&agent.command).is_none() {
            out.push(issue(IssueLevel::Warning, &format!("agents.{name}"), format!("{} not found on PATH", agent.command)));
        }
        for (i, arg) in agent.args.iter().enumerate() {
            if let Some(dash) = unicode_dash(arg) {
                let message =
                    format!("{arg:?} starts with {dash:?}, which is not a dash. The agent reads the entry as text, not as a flag. Write the flag with --");
                out.push(issue(IssueLevel::Warning, &format!("agents.{name}.args[{i}]"), message));
            }
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
        assert!(cfg.hooks.is_empty());
    }

    #[test]
    fn default_config_text_parses() {
        let (cfg, issues) = parse(DEFAULT_CONFIG_TOML);
        assert!(issues.is_empty(), "{issues:?}");
        assert_eq!(cfg.theme, ThemeConfig::default());
        assert_eq!(cfg.font_size, 13);
        let archive = cfg.hooks.iter().find(|h| h.event == "worktree.before_archive").expect("the default config cleans up on archive");
        assert_eq!(archive.mode, HookMode::Async, "the gate runs async hooks only");
        assert!(archive.command.contains("node_modules"), "{}", archive.command);
    }

    #[test]
    fn a_new_worktree_goes_under_the_worktree_home_unless_the_config_says_otherwise() {
        let repo = Path::new("/Users/x/Projects/tomo");
        let home = dirs::home_dir().unwrap_or_default();
        assert_eq!(worktree_parent(None, repo), home.join("tomo/worktrees/tomo"));
        assert_eq!(worktree_parent(Some(Path::new("/tmp/wt")), repo), PathBuf::from("/tmp/wt"));
        assert_eq!(worktree_parent(None, Path::new("/Users/y/work/tomo")), home.join("tomo/worktrees/tomo"), "the directory name decides, not the path");
        assert_eq!(worktree_parent(None, Path::new("/")), home.join("tomo/worktrees/repo"));
    }

    #[test]
    fn a_create_with_no_branch_gets_the_prefix_and_the_worktree_name() {
        assert_eq!(default_branch("simon/", "aogashima"), "simon/aogashima");
        assert_eq!(default_branch("", "aogashima"), "aogashima", "no prefix gives the bare name");
        assert_eq!(parse("").0.branch_prefix, "", "the prefix is empty until the config sets it");
        assert_eq!(parse("branch_prefix = \"simon/\"\n").0.branch_prefix, "simon/");
    }

    #[test]
    fn hooks_parse_with_defaults_and_old_states_only_warn() {
        let (cfg, issues) = parse("[[states]]\nid = \"in-flight\"\n\n[[hooks]]\nevent = \"worktree.created\"\ncommand = \"echo hi\"\nmode = \"pane\"\n");
        assert_eq!(issue_keys(&issues), vec!["states"]);
        assert_eq!(cfg.hooks[0].mode, HookMode::Pane);
        assert_eq!(cfg.hooks[0].timeout_s, 60);
    }

    #[test]
    fn check_reports_unknown_events_and_a_misplaced_tag_filter() {
        let (cfg, _) = parse("[[hooks]]\nevent = \"nope.event\"\ncommand = \"sh\"\n[[hooks]]\nevent = \"agent.waiting\"\ntag = \"x\"\ncommand = \"sh\"\n");
        let issues = check(&cfg, &[]);
        let messages: Vec<String> = issues.iter().map(|i| i.message.clone()).collect();
        assert!(messages.iter().any(|m| m.contains("tag filter only applies")), "{messages:?}");
        assert!(messages.iter().any(|m| m.contains("unknown event")), "{messages:?}");
    }

    #[test]
    fn a_hook_may_name_an_event_that_an_addon_fires() {
        let (cfg, _) = parse("[[hooks]]\nevent = \"deploy.finished\"\ncommand = \"sh\"\n");
        let unknown = |events: &[&str]| check(&cfg, events).iter().any(|i| i.message.contains("unknown event"));
        assert!(unknown(&[]), "Core alone does not know the event");
        assert!(!unknown(&["deploy.finished"]), "an addon that fires it makes it known");
    }

    #[test]
    fn the_template_lists_every_core_hook_event() {
        let text: String = DEFAULT_CONFIG_TOML
            .lines()
            .skip_while(|l| !l.starts_with("# Events:"))
            .take_while(|l| !l.contains("An addon can add"))
            .map(|l| l.trim_start_matches("# Events:").trim_start_matches('#'))
            .collect();
        let listed: Vec<&str> = text.split(',').map(|e| e.trim().trim_end_matches('.')).collect();
        assert_eq!(listed, HOOK_EVENTS, "the # Events: list in the template must name exactly HOOK_EVENTS, in order");
    }

    #[test]
    fn check_warns_when_an_agent_argument_starts_with_a_unicode_dash() {
        let (cfg, _) =
            parse("[agents.claude]\ncommand = \"sh\"\nargs = [\"\u{2014}dangerously-skip-permissions\", \"--ok\", \"-p\", \"\u{2212}x\", \"plain\"]\n");
        let issues = check(&cfg, &[]);
        let keys: Vec<&str> = issue_keys(&issues).into_iter().filter(|k| k.starts_with("agents.claude.args")).collect();
        assert_eq!(keys, vec!["agents.claude.args[0]", "agents.claude.args[3]"], "{issues:?}");
        let first = issues.iter().find(|i| i.key == "agents.claude.args[0]").unwrap();
        assert_eq!(first.level, IssueLevel::Warning);
        assert!(first.message.contains("Write the flag with --"), "{}", first.message);
    }

    #[test]
    fn valid_theme_table_and_terminal_section() {
        let (cfg, issues) = parse(
            "[theme]\nname = \"Slab Light\"\nlight = \"slab-light\"\ndark = \"slab-dark\"\nbg = \"#0F0F12\"\nsurface = \"#17171c\"\naccent = \"#abc\"\n\n[terminal]\nfont_family = \"Berkeley Mono\"\nfont_size = 15\n",
        );
        assert!(issues.is_empty(), "{issues:?}");
        assert_eq!(cfg.theme.name, "slab-light");
        assert_eq!((cfg.theme.light.as_str(), cfg.theme.dark.as_str()), ("slab-light", "slab-dark"));
        assert_eq!(cfg.theme.colors["bg"], "#0f0f12");
        assert_eq!(cfg.theme.colors["accent"], "#abc");
        assert_eq!((cfg.font_family.as_str(), cfg.font_size), ("Berkeley Mono", 15));
    }

    #[test]
    fn partial_theme_override_keeps_the_base_for_the_rest() {
        let (cfg, issues) = parse("[theme]\naccent = \"#abc\"\n");
        assert!(issues.is_empty(), "{issues:?}");
        assert_eq!(cfg.theme.name, "system");
        assert_eq!(cfg.theme.dark, "slab-dark");
        assert_eq!(cfg.theme.colors.len(), 1);
    }

    #[test]
    fn a_murasaki_config_reads_as_slab_and_its_accent_preset_only_warns() {
        let (cfg, issues) = parse("[theme]\naccent = \"sakura\"\nname = \"murasaki-dark\"\nlight = \"paper\"\ndark = \"ink\"\n");
        assert_eq!((cfg.theme.name.as_str(), cfg.theme.light.as_str(), cfg.theme.dark.as_str()), ("slab-dark", "slab-light", "slab-dark"));
        assert!(cfg.theme.colors.is_empty());
        assert_eq!(issue_keys(&issues), vec!["theme.accent"]);
        assert_eq!(issues[0].level, IssueLevel::Warning);
    }

    #[test]
    fn malformed_theme_falls_back_to_slab_and_keeps_the_rest_of_the_file() {
        let (cfg, issues) = parse("[theme]\nname = \"neon\"\ndark = \"system\"\nbg = \"blue\"\nfg = 5\naccent = \"#12345\"\nsparkle = \"#fff\"\nborder = \"#FFF\"\n\n[terminal]\nfont_size = 400\nligatures = true\n\n[keybindings]\nhome = \"mod+j\"\n");
        assert_eq!(cfg.theme.name, "system");
        assert_eq!(cfg.theme.dark, "slab-dark");
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
        assert_eq!(cfg.theme.name, "slab-dark");
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
        let out = set_value(&out, "theme.name", &json!("slab-light")).unwrap();
        let out = set_value(&out, "terminal.font_size", &json!(15)).unwrap();
        let out = set_value(&out, "notifications.sounds", &json!(true)).unwrap();
        assert!(out.starts_with(&COMMENTED.replace("\"mod+j\"", "\"mod+shift+h\"")), "{out}");
        assert!(out.contains("[theme]\nname = \"slab-light\"\n"), "{out}");
        let (cfg, issues) = parse(&out);
        assert!(issues.is_empty(), "{issues:?}");
        assert_eq!((cfg.theme.name.as_str(), cfg.font_size, cfg.notifications.sounds), ("slab-light", 15, true));
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
        let out = set_value("theme = \"dark\"\n", "theme.danger", &json!("#f00")).unwrap();
        let (cfg, issues) = parse(&out);
        assert!(issues.is_empty(), "{issues:?} in {out}");
        assert_eq!(cfg.theme.name, "slab-dark");
        assert_eq!(cfg.theme.colors["danger"], "#f00");
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
