use anyhow::Result;
use serde::Deserialize;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use tomo_proto::{AgentCommand, Config};

pub struct Paths {
    pub data_dir: PathBuf,
    pub socket: PathBuf,
    pub db: PathBuf,
    pub config: PathBuf,
    pub scrollback_dir: PathBuf,
    pub integrations_dir: PathBuf,
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
    #[serde(default)]
    keybindings: BTreeMap<String, String>,
    #[serde(default)]
    agents: BTreeMap<String, AgentCommandFile>,
    archive_cleanup: Option<Vec<String>>,
    #[serde(default)]
    hooks: BTreeMap<String, String>,
}

#[derive(Debug, Deserialize)]
struct AgentCommandFile {
    command: String,
    #[serde(default)]
    args: Vec<String>,
}

pub const DEFAULT_CONFIG_TOML: &str = r#"# Tomo configuration. Every key is optional.

# shell = "/bin/zsh"
# editor_command = ["zed", "{path}"]
# worktree_parent_dir = "~/worktrees"
# resource_warning_gb = 2.0
# scrollback_lines = 10000
# font_family = "Geist Mono Variable, Menlo, monospace"
# font_size = 13
# theme = "system"   # system | dark | light

# [keybindings]
# home = "mod+h"
# palette = "mod+k"
# next_attention = "mod+shift+a"
# prev_worktree = "mod+alt+up"
# next_worktree = "mod+alt+down"
# new_terminal = "mod+d"
# new_tab = "mod+t"
# close_pane = "mod+w"
# focus_left = "mod+alt+left"
# focus_right = "mod+alt+right"
# focus_up = "mod+alt+up"
# focus_down = "mod+alt+down"
# toggle_left_sidebar = "mod+b"
# toggle_right_sidebar = "mod+shift+b"

# [agents.claude]
# command = "claude"
# args = []

# Directories removed from a worktree when you archive it.
# archive_cleanup = ["node_modules", "target", "dist", ".next", ".turbo", ".venv", "build"]

# Shell commands that run in the worktree directory. Env: TOMO_WORKTREE_ID,
# TOMO_WORKTREE_PATH, TOMO_REPO_PATH, TOMO_BRANCH.
# [hooks]
# worktree_create = "pnpm install"
# worktree_archive = "docker compose down"
"#;

pub fn default_archive_cleanup() -> Vec<String> {
    ["node_modules", "target", "dist", ".next", ".turbo", ".venv", "build"].into_iter().map(String::from).collect()
}

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
    Config {
        shell: file.shell.or_else(|| std::env::var("SHELL").ok()).unwrap_or_else(|| "/bin/zsh".into()),
        editor_command: file.editor_command.unwrap_or_else(|| vec!["zed".into(), "{path}".into()]),
        worktree_parent_dir: file.worktree_parent_dir.map(|p| expand_tilde(&p)),
        resource_warning_bytes: (file.resource_warning_gb.unwrap_or(2.0) * 1024.0 * 1024.0 * 1024.0) as u64,
        scrollback_lines: file.scrollback_lines.unwrap_or(10_000),
        font_family: file.font_family.unwrap_or_else(|| "Geist Mono Variable, Menlo, monospace".into()),
        font_size: file.font_size.unwrap_or(13),
        theme: file.theme.unwrap_or_else(|| "system".into()),
        keybindings,
        agents,
        archive_cleanup: file.archive_cleanup.unwrap_or_else(default_archive_cleanup),
        hooks: file.hooks,
    }
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
        assert!(cfg.archive_cleanup.contains(&"node_modules".to_string()));
        assert!(cfg.hooks.is_empty());
    }

    #[test]
    fn default_config_text_parses() {
        let file: FileConfig = toml::from_str(DEFAULT_CONFIG_TOML).unwrap();
        assert!(file.shell.is_none());
    }
}
