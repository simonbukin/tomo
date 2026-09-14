//! Repo-defined Actions: `[[actions]]` in `<worktree>/.tomo.toml`.
//!
//! An Action is a named command that runs in the context of one worktree,
//! either in a Tomo pane or as an external program. Nothing here runs by
//! itself; the daemon executes an Action only on an explicit request.

use serde::Deserialize;
use std::collections::HashSet;
use std::path::Path;
use tomo_proto::{ActionDef, ActionMode, ActionShow};

pub const FILE_NAME: &str = ".tomo.toml";

#[derive(Debug, Default, Deserialize)]
struct File {
    #[serde(default)]
    actions: Vec<Entry>,
}

#[derive(Debug, Deserialize)]
struct Entry {
    id: Option<String>,
    label: Option<String>,
    command: Option<String>,
    mode: Option<String>,
    show: Option<String>,
    shortcut: Option<String>,
}

/// Parses the file text. Returns the actions and the first problem, if any.
/// A problem in one entry drops that entry and keeps the rest.
pub fn parse(text: &str) -> (Vec<ActionDef>, Option<String>) {
    let file: File = match toml::from_str(text) {
        Ok(f) => f,
        Err(e) => return (Vec::new(), Some(format!("{FILE_NAME}: {}", e.message()))),
    };
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    let mut first_error = None;
    for (i, e) in file.actions.into_iter().enumerate() {
        let mut fail = |msg: String| {
            if first_error.is_none() {
                first_error = Some(format!("{FILE_NAME}: actions[{i}] {msg}"));
            }
        };
        let Some(id) = e.id.filter(|s| !s.trim().is_empty()) else {
            fail("id is required".into());
            continue;
        };
        if id.contains(char::is_whitespace) {
            fail(format!("id {id:?} must be a single word"));
            continue;
        }
        if !seen.insert(id.clone()) {
            fail(format!("duplicate id {id:?}"));
            continue;
        }
        let Some(command) = e.command.filter(|s| !s.trim().is_empty()) else {
            fail(format!("{id}: command is required"));
            continue;
        };
        let mode = match e.mode.as_deref() {
            None | Some("pane") => ActionMode::Pane,
            Some("external") => ActionMode::External,
            Some(other) => {
                fail(format!("{id}: mode {other:?} must be pane or external"));
                continue;
            }
        };
        let show = match e.show.as_deref() {
            None | Some("menu") => ActionShow::Menu,
            Some("topbar") => ActionShow::Topbar,
            Some(other) => {
                fail(format!("{id}: show {other:?} must be topbar or menu"));
                continue;
            }
        };
        out.push(ActionDef {
            label: e.label.filter(|s| !s.trim().is_empty()).unwrap_or_else(|| id.clone()),
            id,
            command,
            mode,
            show,
            shortcut: e.shortcut.filter(|s| !s.trim().is_empty()),
        });
    }
    (out, first_error)
}

/// Reads `<worktree>/.tomo.toml`. A missing file means no actions and no error.
pub fn load(worktree: &Path) -> (Vec<ActionDef>, Option<String>) {
    match std::fs::read_to_string(worktree.join(FILE_NAME)) {
        Ok(text) => parse(&text),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => (Vec::new(), None),
        Err(e) => (Vec::new(), Some(format!("{FILE_NAME}: {e}"))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_defaults_and_reports_first_problem_without_dropping_the_rest() {
        let (actions, err) = parse(
            "[[actions]]\nid = \"zed\"\nlabel = \"Zed\"\ncommand = \"zed .\"\nmode = \"external\"\nshow = \"topbar\"\n\n[[actions]]\nid = \"test\"\ncommand = \"pnpm test\"\n\n[[actions]]\nlabel = \"broken\"\ncommand = \"x\"\n\n[[actions]]\nid = \"test\"\ncommand = \"dup\"\n",
        );
        assert_eq!(actions.len(), 2);
        assert_eq!(actions[0].mode, ActionMode::External);
        assert_eq!(actions[0].show, ActionShow::Topbar);
        assert_eq!(actions[1].label, "test");
        assert_eq!(actions[1].mode, ActionMode::Pane);
        assert_eq!(actions[1].show, ActionShow::Menu);
        assert!(err.unwrap().contains("actions[2] id is required"));
    }

    #[test]
    fn invalid_toml_and_bad_mode_are_reported() {
        let (actions, err) = parse("[[actions]\nid = 1");
        assert!(actions.is_empty() && err.unwrap().starts_with(".tomo.toml:"));
        let (actions, err) = parse("[[actions]]\nid = \"a\"\ncommand = \"x\"\nmode = \"service\"\n");
        assert!(actions.is_empty());
        assert!(err.unwrap().contains("must be pane or external"));
    }

    #[test]
    fn missing_file_is_not_an_error() {
        let dir = std::env::temp_dir().join(format!("tomo-actions-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        assert_eq!(load(&dir), (Vec::new(), None));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
