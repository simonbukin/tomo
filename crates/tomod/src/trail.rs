//! The branches that a worktree had checked out, read from the reflog of its HEAD.
//! Each worktree has its own HEAD reflog, so the trail of one worktree never shows the work of another.
//! An addon reads the trail to find the tickets and the pull requests of a worktree, not only of its branch now.

use std::collections::BTreeMap;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

/// The most recent part of a reflog that the trail reads. An old worktree has years of entries.
const TAIL_BYTES: u64 = 256 * 1024;
/// How far back and how many branches of a worktree's trail name its tickets and pull requests.
const WINDOW_MS: u64 = 30 * 24 * 60 * 60 * 1000;
const BRANCHES: usize = 6;
/// The subjects that the trail keeps for one branch, newest first.
const SUBJECTS_PER_BRANCH: usize = 20;

#[derive(Debug, Clone, PartialEq)]
pub struct BranchTouch {
    pub branch: String,
    /// The last checkout of the branch or commit on it in this worktree. 0 for a branch with no entry.
    pub touched_ms: u64,
    /// The subjects of the commits made on the branch in this worktree, newest first.
    pub subjects: Vec<String>,
}

struct Entry<'a> {
    at_ms: u64,
    message: &'a str,
}

fn entry(line: &str) -> Option<Entry<'_>> {
    let (head, message) = line.split_once('\t')?;
    let mut fields = head.rsplitn(3, ' ');
    let _zone = fields.next()?;
    let seconds: u64 = fields.next()?.parse().ok()?;
    Some(Entry { at_ms: seconds * 1000, message })
}

/// A name that `checkout: moving from X to Y` gives for a detached HEAD: a hash, or a revision such as `HEAD~2`.
fn branch_name(name: &str) -> Option<&str> {
    let hash = name.len() >= 7 && name.chars().all(|c| c.is_ascii_hexdigit());
    (!hash && !name.contains('~') && !name.contains('^') && name != "HEAD").then_some(name)
}

fn commit_subject(message: &str) -> Option<&str> {
    let rest = message.strip_prefix("commit")?;
    let subject = rest.strip_prefix(": ").or_else(|| rest.strip_prefix(" (").and_then(|r| r.split_once("): ")).map(|(_, s)| s))?;
    Some(subject.trim()).filter(|s| !s.is_empty())
}

fn touch<'a>(touches: &'a mut BTreeMap<String, BranchTouch>, branch: &str, at_ms: u64) -> &'a mut BranchTouch {
    let t = touches.entry(branch.to_string()).or_insert_with(|| BranchTouch { branch: branch.to_string(), touched_ms: 0, subjects: vec![] });
    t.touched_ms = t.touched_ms.max(at_ms);
    t
}

/// The trail of one reflog, the most recently touched branch first. `current` is the branch that HEAD is on now.
/// The walk goes from the newest entry back. A checkout touches the branch that it leaves and the branch that it
/// enters, and says which branch HEAD was on before it. Every other entry touches the branch that HEAD was on.
pub fn branch_trail(reflog: &str, current: Option<&str>, since_ms: u64, limit: usize) -> Vec<BranchTouch> {
    let mut touches: BTreeMap<String, BranchTouch> = BTreeMap::new();
    if let Some(branch) = current {
        touch(&mut touches, branch, 0);
    }
    let mut on: Option<String> = current.map(str::to_string);
    for e in reflog.lines().rev().filter_map(entry).filter(|e| e.at_ms >= since_ms) {
        if let Some((from, to)) = e.message.strip_prefix("checkout: moving from ").and_then(|m| m.split_once(" to ")) {
            for branch in [from, to.trim()].into_iter().filter_map(branch_name) {
                touch(&mut touches, branch, e.at_ms);
            }
            on = branch_name(from).map(str::to_string);
            continue;
        }
        if let Some(rebased) = e.message.strip_prefix("rebase (finish): returning to refs/heads/") {
            on = Some(rebased.trim().to_string());
        }
        if let Some(branch) = on.clone() {
            let t = touch(&mut touches, &branch, e.at_ms);
            if let Some(subject) = commit_subject(e.message).filter(|_| t.subjects.len() < SUBJECTS_PER_BRANCH) {
                t.subjects.push(subject.to_string());
            }
        }
    }
    let mut list: Vec<BranchTouch> = touches.into_values().filter(|t| t.touched_ms > 0 || Some(t.branch.as_str()) == current).collect();
    list.sort_by(|a, b| (Some(b.branch.as_str()) == current).cmp(&(Some(a.branch.as_str()) == current)).then(b.touched_ms.cmp(&a.touched_ms)));
    list.truncate(limit);
    list
}

/// The gitdir of a worktree: `.git` for the main worktree, the linked gitdir for another.
fn gitdir(worktree: &Path) -> Option<PathBuf> {
    let dotgit = worktree.join(".git");
    if dotgit.is_dir() {
        return Some(dotgit);
    }
    let text = std::fs::read_to_string(&dotgit).ok()?;
    let gitdir = PathBuf::from(text.trim().strip_prefix("gitdir:")?.trim());
    Some(if gitdir.is_absolute() { gitdir } else { worktree.join(gitdir) })
}

/// The gitdir that the worktrees of a repository share. A linked gitdir names it in its `commondir` file.
fn common_dir(gitdir: &Path) -> PathBuf {
    match std::fs::read_to_string(gitdir.join("commondir")) {
        Ok(text) => gitdir.join(text.trim()),
        Err(_) => gitdir.to_path_buf(),
    }
}

/// The branch that every work branch leaves: the one that `origin/HEAD` names. With no `origin/HEAD`, `main` and
/// `master`. A checkout touches the branch that it leaves, so without this rule the base would be in every trail,
/// and a pull request whose head is the base, such as a release from `develop`, would show on every worktree.
fn base_branches(gitdir: &Path) -> Vec<String> {
    let head = std::fs::read_to_string(common_dir(gitdir).join("refs/remotes/origin/HEAD")).unwrap_or_default();
    match head.trim().strip_prefix("ref: refs/remotes/origin/") {
        Some(base) => vec![base.to_string()],
        None => vec!["main".to_string(), "master".to_string()],
    }
}

/// The trail of a worktree now: its branch from the HEAD file, then the other branches of the last 30 days, without
/// the base branch unless HEAD is on it.
pub fn worktree_trail(worktree: &Path, now_ms: u64) -> (Option<String>, Vec<BranchTouch>) {
    let current = head_branch(worktree);
    let base = gitdir(worktree).map(|g| base_branches(&g)).unwrap_or_default();
    let all = branch_trail(&read_reflog(worktree), current.as_deref(), now_ms.saturating_sub(WINDOW_MS), usize::MAX);
    let touches = all.into_iter().filter(|t| Some(&t.branch) == current.as_ref() || !base.contains(&t.branch)).take(BRANCHES).collect();
    (current, touches)
}

pub fn head_reflog_path(worktree: &Path) -> Option<PathBuf> {
    gitdir(worktree).map(|g| g.join("logs/HEAD"))
}

/// The branch that HEAD is on now, read from the HEAD file. None for a detached HEAD. The daemon's own branch of a
/// worktree comes from a poll, so right after a checkout only this file is sure.
pub fn head_branch(worktree: &Path) -> Option<String> {
    let head = std::fs::read_to_string(gitdir(worktree)?.join("HEAD")).ok()?;
    head.trim().strip_prefix("ref: refs/heads/").map(str::to_string)
}

/// The newest `TAIL_BYTES` of the reflog, cut at a line start. An empty text when there is no reflog.
pub fn read_reflog(worktree: &Path) -> String {
    let Some(mut file) = head_reflog_path(worktree).and_then(|p| std::fs::File::open(p).ok()) else { return String::new() };
    let len = file.metadata().map(|m| m.len()).unwrap_or(0);
    let start = len.saturating_sub(TAIL_BYTES);
    let mut bytes = Vec::new();
    if file.seek(SeekFrom::Start(start)).and_then(|_| file.read_to_end(&mut bytes)).is_err() {
        return String::new();
    }
    let text = String::from_utf8_lossy(&bytes);
    match (start > 0).then(|| text.split_once('\n')).flatten() {
        Some((_, rest)) => rest.to_string(),
        None => text.into_owned(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const A: &str = "0000000000000000000000000000000000000000";
    const B: &str = "1111111111111111111111111111111111111111";

    fn line(seconds: u64, message: &str) -> String {
        format!("{A} {B} You <you@example.com> {seconds} +0200\t{message}\n")
    }

    fn names(trail: &[BranchTouch]) -> Vec<(&str, u64)> {
        trail.iter().map(|t| (t.branch.as_str(), t.touched_ms / 1000)).collect()
    }

    #[test]
    fn each_checkout_and_commit_touches_the_branch_that_head_was_on() {
        let log = [
            line(100, "checkout: moving from main to you/eng-29-status"),
            line(110, "commit: ENG-29 show the status"),
            line(200, "checkout: moving from you/eng-29-status to you/eng-31-retry"),
            line(210, "commit: Retry the sync"),
            line(220, "commit (amend): Retry the sync, ENG-33 too"),
        ]
        .concat();
        let trail = branch_trail(&log, Some("you/eng-31-retry"), 0, 10);
        assert_eq!(names(&trail), vec![("you/eng-31-retry", 220), ("you/eng-29-status", 200), ("main", 100)]);
        assert_eq!(trail[0].subjects, vec!["Retry the sync, ENG-33 too", "Retry the sync"]);
        assert_eq!(trail[1].subjects, vec!["ENG-29 show the status"]);
    }

    #[test]
    fn the_current_branch_comes_first_even_with_no_entry() {
        let log = line(100, "checkout: moving from main to old");
        assert_eq!(names(&branch_trail(&log, Some("fresh"), 0, 10)), vec![("fresh", 0), ("main", 100), ("old", 100)]);
    }

    #[test]
    fn a_detached_head_touches_no_branch_and_a_rebase_belongs_to_its_branch() {
        let log = [
            line(100, &format!("checkout: moving from main to {B}")),
            line(110, "commit: on a detached head"),
            line(120, &format!("checkout: moving from {B} to feat")),
            line(130, "rebase (start): checkout origin/main"),
            line(140, "rebase (pick): ENG-7 keep me"),
            line(150, "rebase (finish): returning to refs/heads/feat"),
        ]
        .concat();
        let trail = branch_trail(&log, Some("feat"), 0, 10);
        assert_eq!(names(&trail), vec![("feat", 150), ("main", 100)]);
        assert!(trail.iter().all(|t| !t.subjects.iter().any(|s| s.contains("detached"))));
    }

    #[test]
    fn old_entries_and_the_limit_drop_branches() {
        let log = [line(10, "checkout: moving from a to b"), line(20, "checkout: moving from b to c"), line(30, "checkout: moving from c to d")].concat();
        assert_eq!(names(&branch_trail(&log, Some("d"), 25_000, 10)), vec![("d", 30), ("c", 30)]);
        assert_eq!(names(&branch_trail(&log, Some("d"), 0, 3)), vec![("d", 30), ("c", 30), ("b", 20)]);
    }

    #[test]
    fn a_line_of_another_shape_is_skipped() {
        let log = format!("not a reflog line\n{}", line(50, "commit: ok"));
        assert_eq!(names(&branch_trail(&log, Some("x"), 0, 10)), vec![("x", 50)]);
    }

    #[test]
    fn the_reflog_of_a_linked_worktree_is_in_its_gitdir() {
        let dir = std::env::temp_dir().join(format!("tomo-trail-{}", std::process::id()));
        let gitdir = dir.join("repo/.git/worktrees/w");
        std::fs::create_dir_all(gitdir.join("logs")).unwrap();
        std::fs::create_dir_all(dir.join("w")).unwrap();
        std::fs::write(dir.join("w/.git"), format!("gitdir: {}\n", gitdir.display())).unwrap();
        std::fs::write(gitdir.join("logs/HEAD"), line(5, "commit: hi")).unwrap();
        std::fs::write(gitdir.join("HEAD"), "ref: refs/heads/you/eng-1\n").unwrap();
        assert_eq!(head_reflog_path(&dir.join("w")), Some(gitdir.join("logs/HEAD")));
        assert_eq!(head_branch(&dir.join("w")).as_deref(), Some("you/eng-1"));
        std::fs::write(gitdir.join("HEAD"), format!("{B}\n")).unwrap();
        assert_eq!(head_branch(&dir.join("w")), None, "a detached HEAD has no branch");
        assert!(read_reflog(&dir.join("w")).contains("commit: hi"));
        assert_eq!(read_reflog(&dir.join("missing")), "");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_trail_of_a_worktree_leaves_out_the_base_branch_unless_head_is_on_it() {
        let dir = std::env::temp_dir().join(format!("tomo-trail-base-{}", std::process::id()));
        let common = dir.join("repo/.git");
        let gitdir = common.join("worktrees/w");
        std::fs::create_dir_all(gitdir.join("logs")).unwrap();
        std::fs::create_dir_all(common.join("refs/remotes/origin")).unwrap();
        std::fs::create_dir_all(dir.join("w")).unwrap();
        std::fs::write(dir.join("w/.git"), format!("gitdir: {}\n", gitdir.display())).unwrap();
        std::fs::write(gitdir.join("commondir"), "../..\n").unwrap();
        std::fs::write(common.join("refs/remotes/origin/HEAD"), "ref: refs/remotes/origin/develop\n").unwrap();
        std::fs::write(gitdir.join("HEAD"), "ref: refs/heads/eng-32\n").unwrap();
        let now = 1_000_000;
        let log = [line(900, "checkout: moving from develop to eng-31"), line(950, "checkout: moving from eng-31 to develop"), line(960, "checkout: moving from develop to eng-32")].concat();
        std::fs::write(gitdir.join("logs/HEAD"), &log).unwrap();
        let (current, trail) = worktree_trail(&dir.join("w"), now * 1000);
        assert_eq!(current.as_deref(), Some("eng-32"));
        assert_eq!(names(&trail), vec![("eng-32", 960), ("eng-31", 950)]);
        std::fs::write(gitdir.join("HEAD"), "ref: refs/heads/develop\n").unwrap();
        assert_eq!(names(&worktree_trail(&dir.join("w"), now * 1000).1)[0], ("develop", 960), "HEAD on the base keeps it");
        std::fs::remove_file(common.join("refs/remotes/origin/HEAD")).unwrap();
        std::fs::write(gitdir.join("logs/HEAD"), line(900, "checkout: moving from main to eng-40")).unwrap();
        std::fs::write(gitdir.join("HEAD"), "ref: refs/heads/eng-40\n").unwrap();
        assert_eq!(names(&worktree_trail(&dir.join("w"), now * 1000).1), vec![("eng-40", 900)], "with no origin/HEAD, main is the base");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
