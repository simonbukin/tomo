//! Repo-defined Actions: `[[actions]]` in `.tomo.toml`.
//!
//! The file belongs to the repository. A worktree reads its own file, and the
//! repository file when it has none. An Action is a named command that runs in
//! the context of one worktree, either in a Tomo pane or as an external
//! program. Nothing here runs by itself; the daemon executes an Action only on
//! an explicit request.

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
/// A problem in one entry drops that entry and keeps the rest. Each problem
/// names `source`, because a repository file serves every worktree of the repo.
pub fn parse(text: &str, source: &Path) -> (Vec<ActionDef>, Option<String>) {
    let source = source.display();
    let file: File = match toml::from_str(text) {
        Ok(f) => f,
        Err(e) => return (Vec::new(), Some(format!("{source}: {}", e.message()))),
    };
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    let mut first_error = None;
    for (i, e) in file.actions.into_iter().enumerate() {
        let mut fail = |msg: String| {
            if first_error.is_none() {
                first_error = Some(format!("{source}: actions[{i}] {msg}"));
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

/// Reads one file. `None` means the file is not there.
fn read(file: &Path) -> Option<(Vec<ActionDef>, Option<String>)> {
    match std::fs::read_to_string(file) {
        Ok(text) => Some(parse(&text, file)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => Some((Vec::new(), Some(format!("{}: {e}", file.display())))),
    }
}

/// Reads `<worktree>/.tomo.toml`, or `<repo>/.tomo.toml` when the worktree has
/// no file of its own. The worktree file wins whole: the two are never merged,
/// which would need a conflict rule for each id. The third value is true when
/// the actions come from the repository file. No file at either place means no
/// actions and no error.
pub fn load(worktree: &Path, repo: Option<&Path>) -> (Vec<ActionDef>, Option<String>, bool) {
    if let Some((actions, error)) = read(&worktree.join(FILE_NAME)) {
        return (actions, error, false);
    }
    match repo.filter(|r| *r != worktree).and_then(|r| read(&r.join(FILE_NAME))) {
        Some((actions, error)) => (actions, error, true),
        None => (Vec::new(), None, false),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn temp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("tomo-actions-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    fn write(dir: &Path, text: &str) {
        std::fs::create_dir_all(dir).unwrap();
        std::fs::write(dir.join(FILE_NAME), text).unwrap();
    }

    const BUILD: &str = "[[actions]]\nid = \"build\"\ncommand = \"make\"\n";

    #[test]
    fn parses_defaults_and_reports_first_problem_without_dropping_the_rest() {
        let (actions, err) = parse(
            "[[actions]]\nid = \"zed\"\nlabel = \"Zed\"\ncommand = \"zed .\"\nmode = \"external\"\nshow = \"topbar\"\n\n[[actions]]\nid = \"test\"\ncommand = \"pnpm test\"\n\n[[actions]]\nlabel = \"broken\"\ncommand = \"x\"\n\n[[actions]]\nid = \"test\"\ncommand = \"dup\"\n",
            Path::new(FILE_NAME),
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
        let (actions, err) = parse("[[actions]\nid = 1", Path::new(FILE_NAME));
        assert!(actions.is_empty() && err.unwrap().starts_with(".tomo.toml:"));
        let (actions, err) = parse("[[actions]]\nid = \"a\"\ncommand = \"x\"\nmode = \"service\"\n", Path::new(FILE_NAME));
        assert!(actions.is_empty());
        assert!(err.unwrap().contains("must be pane or external"));
    }

    #[test]
    fn missing_file_is_not_an_error() {
        let dir = temp("missing");
        std::fs::create_dir_all(&dir).unwrap();
        assert_eq!(load(&dir, None), (Vec::new(), None, false));
        assert_eq!(load(&dir, Some(&dir.join("no-such-repo"))), (Vec::new(), None, false), "a missing repository file is no error either");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_repo_file_applies_and_a_worktree_file_wins_whole() {
        let dir = temp("fallback");
        let (repo, worktree) = (dir.join("repo"), dir.join("feat-x"));
        write(&repo, BUILD);
        std::fs::create_dir_all(&worktree).unwrap();

        let (actions, error, from_repo) = load(&worktree, Some(&repo));
        assert_eq!((actions.iter().map(|a| a.id.as_str()).collect::<Vec<_>>(), error, from_repo), (vec!["build"], None, true));

        write(&worktree, "[[actions]]\nid = \"test\"\ncommand = \"pnpm test\"\n");
        let (actions, _, from_repo) = load(&worktree, Some(&repo));
        assert_eq!((actions.iter().map(|a| a.id.as_str()).collect::<Vec<_>>(), from_repo), (vec!["test"], false), "the worktree file wins whole; the two never merge");

        let (actions, _, from_repo) = load(&repo, Some(&repo));
        assert_eq!((actions.len(), from_repo), (1, false), "the repository root reads its own file as a worktree");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_bad_repo_file_names_its_own_path() {
        let dir = temp("bad-repo");
        let (repo, worktree) = (dir.join("repo"), dir.join("feat-x"));
        write(&repo, "[[actions]]\ncommand = \"make\"\n");
        std::fs::create_dir_all(&worktree).unwrap();
        let (_, error, from_repo) = load(&worktree, Some(&repo));
        let error = error.unwrap();
        assert_eq!(error, format!("{}: actions[0] id is required", repo.join(FILE_NAME).display()));
        assert!(from_repo && !error.contains("feat-x"), "the problem names the repository file, not the worktree");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
