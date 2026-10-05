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

/// The package script that an Action's command runs, and the package when the command names one.
#[derive(Debug, PartialEq, Eq)]
pub struct ScriptRun {
    pub package: Option<String>,
    pub script: String,
}

const RUNNERS: [&str; 4] = ["pnpm", "npm", "yarn", "bun"];
const NOT_A_SCRIPT: [&str; 8] = ["exec", "dlx", "x", "install", "i", "add", "ci", "create"];
const TAKES_A_VALUE: [&str; 4] = ["-C", "--dir", "--prefix", "--cwd"];

/// `pnpm --filter=@acme/web run app` runs `app` of `@acme/web`, and `pnpm storybook:dev` runs `storybook:dev`. The last
/// runner call counts, because the lines before it often prepare the run.
pub fn script_run(command: &str) -> Option<ScriptRun> {
    command.lines().rev().find_map(|line| {
        let words: Vec<&str> = line.split_whitespace().collect();
        let at = words.iter().rposition(|w| RUNNERS.contains(&w.rsplit('/').next().unwrap_or(w)))?;
        let mut package = None;
        let mut rest = words[at + 1..].iter();
        while let Some(&word) = rest.next() {
            match word {
                "run" | "run-script" => {}
                "--filter" | "-F" | "--workspace" => package = rest.next().map(|p| p.to_string()),
                w if TAKES_A_VALUE.contains(&w) => {
                    rest.next();
                }
                w if w.starts_with("--filter=") || w.starts_with("--workspace=") => package = w.split_once('=').map(|(_, p)| p.to_string()),
                w if w.starts_with('-') => {}
                w if NOT_A_SCRIPT.contains(&w) => return None,
                w => return Some(ScriptRun { package, script: w.trim_matches(['"', '\'']).to_string() }),
            }
        }
        None
    })
}

impl ScriptRun {
    /// True for a process that this run started: the same script, of the named package when the command names one.
    pub fn started(&self, script: Option<&str>, package: Option<&str>) -> bool {
        script == Some(self.script.as_str()) && self.package.as_deref().is_none_or(|want| package == Some(want))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_package_script_of_a_command() {
        let run = |c: &str| script_run(c).map(|r| (r.package, r.script));
        let s = |p: Option<&str>, x: &str| Some((p.map(str::to_string), x.to_string()));
        assert_eq!(run("pnpm storybook:dev"), s(None, "storybook:dev"));
        assert_eq!(run("pnpm --filter=@acme/web run seed -- up\nPORT=3 pnpm --filter=@acme/web run app"), s(Some("@acme/web"), "app"));
        assert_eq!(run("npm run dev --workspace web"), s(None, "dev"));
        assert_eq!(run("npm --workspace web run dev"), s(Some("web"), "dev"));
        assert_eq!(run("cd app && yarn -F web start"), s(Some("web"), "start"));
        assert_eq!(run("pnpm -C apps/web dev"), s(None, "dev"));
        assert_eq!(run("/opt/homebrew/bin/bun run serve"), s(None, "serve"));
        assert_eq!(run("pnpm exec vite"), None);
        assert_eq!(run("cargo run"), None);
        assert_eq!(run("pnpm"), None);
    }

    #[test]
    fn a_run_knows_the_processes_it_started() {
        let filtered = ScriptRun { package: Some("@acme/web".into()), script: "app".into() };
        assert!(filtered.started(Some("app"), Some("@acme/web")));
        assert!(!filtered.started(Some("app"), Some("@acme/docs")));
        assert!(!filtered.started(Some("dev"), Some("@acme/web")));
        let any = ScriptRun { package: None, script: "storybook:dev".into() };
        assert!(any.started(Some("storybook:dev"), Some("acme")));
        assert!(!any.started(None, None));
    }
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
        assert_eq!(
            (actions.iter().map(|a| a.id.as_str()).collect::<Vec<_>>(), from_repo),
            (vec!["test"], false),
            "the worktree file wins whole; the two never merge"
        );

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
