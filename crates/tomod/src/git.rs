use anyhow::{anyhow, Context, Result};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use tokio::process::Command;
use tomo_proto::{Branch, GitSummary};

/// How many branches one listing returns. A repository with more branches keeps the newest.
pub const BRANCH_LIMIT: usize = 200;

const BRANCH_FORMAT: &str = "%(refname:short)\t%(committerdate:unix)\t%(upstream:short)\t%(refname)";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorktreeEntry {
    pub path: PathBuf,
    pub head: String,
    pub branch: Option<String>,
    pub detached: bool,
    pub bare: bool,
    pub prunable: bool,
}

pub fn parse_worktree_list(text: &str) -> Vec<WorktreeEntry> {
    text.split("\n\n")
        .filter(|block| !block.trim().is_empty())
        .filter_map(|block| {
            let mut entry = WorktreeEntry { path: PathBuf::new(), head: String::new(), branch: None, detached: false, bare: false, prunable: false };
            for line in block.lines() {
                if let Some(p) = line.strip_prefix("worktree ") {
                    entry.path = PathBuf::from(p);
                } else if let Some(h) = line.strip_prefix("HEAD ") {
                    entry.head = h.to_string();
                } else if let Some(b) = line.strip_prefix("branch ") {
                    entry.branch = Some(b.strip_prefix("refs/heads/").unwrap_or(b).to_string());
                } else if line == "detached" {
                    entry.detached = true;
                } else if line == "bare" {
                    entry.bare = true;
                } else if line.starts_with("prunable") {
                    entry.prunable = true;
                }
            }
            (!entry.path.as_os_str().is_empty()).then_some(entry)
        })
        .collect()
}

async fn git(cwd: &Path, args: &[&str]) -> Result<String> {
    let out = Command::new("git")
        .arg("-C")
        .arg(cwd)
        .args(args)
        .env("GIT_OPTIONAL_LOCKS", "0")
        .output()
        .await
        .with_context(|| format!("run git {}", args.join(" ")))?;
    if !out.status.success() {
        return Err(anyhow!("git {}: {}", args.join(" "), String::from_utf8_lossy(&out.stderr).trim()));
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

pub async fn toplevel(path: &Path) -> Result<PathBuf> {
    Ok(PathBuf::from(git(path, &["rev-parse", "--show-toplevel"]).await?.trim()))
}

pub async fn common_dir(path: &Path) -> Result<PathBuf> {
    let raw = PathBuf::from(git(path, &["rev-parse", "--git-common-dir"]).await?.trim());
    let abs = if raw.is_absolute() { raw } else { path.join(raw) };
    Ok(std::fs::canonicalize(&abs).unwrap_or(abs))
}

pub async fn list_worktrees(repo: &Path) -> Result<Vec<WorktreeEntry>> {
    Ok(parse_worktree_list(&git(repo, &["worktree", "list", "--porcelain"]).await?))
}

/// The name Git gives a linked worktree under `<common>/worktrees/<name>`.
/// Stable when the worktree directory moves and Git is told about it.
pub fn gitdir_name(worktree_path: &Path) -> Option<String> {
    let dotgit = worktree_path.join(".git");
    let text = std::fs::read_to_string(dotgit).ok()?;
    let target = text.trim().strip_prefix("gitdir:")?.trim();
    Path::new(target).file_name().map(|n| n.to_string_lossy().into_owned())
}

pub fn parse_status(text: &str) -> GitSummary {
    let mut s = GitSummary::default();
    for line in text.lines() {
        if let Some(rest) = line.strip_prefix("# branch.oid ") {
            s.head = rest.to_string();
        } else if let Some(rest) = line.strip_prefix("# branch.head ") {
            if rest == "(detached)" {
                s.detached = true;
            } else {
                s.branch = Some(rest.to_string());
            }
        } else if let Some(rest) = line.strip_prefix("# branch.upstream ") {
            s.upstream = Some(rest.to_string());
        } else if let Some(rest) = line.strip_prefix("# branch.ab ") {
            let mut parts = rest.split_whitespace();
            s.ahead = parts.next().and_then(|a| a.trim_start_matches('+').parse().ok());
            s.behind = parts.next().and_then(|b| b.trim_start_matches('-').parse().ok());
        } else if line.starts_with("u ") {
            s.files_changed += 1;
            s.conflicts += 1;
        } else if line.starts_with("1 ") || line.starts_with("2 ") {
            s.files_changed += 1;
        } else if line.starts_with("? ") {
            s.untracked += 1;
        }
    }
    s.dirty = s.files_changed > 0 || s.untracked > 0;
    s
}

pub fn parse_numstat(text: &str) -> (u32, u32) {
    text.lines().fold((0, 0), |(ins, del), line| {
        let mut parts = line.split('\t');
        let i = parts.next().and_then(|v| v.parse::<u32>().ok()).unwrap_or(0);
        let d = parts.next().and_then(|v| v.parse::<u32>().ok()).unwrap_or(0);
        (ins + i, del + d)
    })
}

pub async fn summary(worktree: &Path) -> Result<GitSummary> {
    let status = git(worktree, &["status", "--porcelain=v2", "--branch", "--untracked-files=normal"]).await?;
    let mut s = parse_status(&status);
    if s.files_changed == 0 {
        return Ok(s);
    }
    if let Ok(numstat) = git(worktree, &["diff", "HEAD", "--numstat"]).await {
        let (ins, del) = parse_numstat(&numstat);
        s.insertions = ins;
        s.deletions = del;
    }
    Ok(s)
}

/// Folds the `for-each-ref` rows into one row for each branch name, newest commit first.
/// A local branch wins over the remote branch of the same name, and `origin/HEAD` is not a branch.
pub fn parse_branches(text: &str, limit: usize) -> Vec<Branch> {
    let mut rows: Vec<Branch> = Vec::new();
    let mut at: HashMap<String, usize> = HashMap::new();
    for line in text.lines() {
        let mut fields = line.split('\t');
        let short = fields.next().unwrap_or("").trim();
        let seconds: u64 = fields.next().unwrap_or("").trim().parse().unwrap_or(0);
        let upstream = fields.next().unwrap_or("").trim();
        let refname = fields.next().unwrap_or("").trim();
        if short.is_empty() || refname.ends_with("/HEAD") {
            continue;
        }
        let (name, remote) = match refname.starts_with("refs/remotes/") {
            true => match short.split_once('/') {
                Some((remote, name)) if !name.is_empty() => (name.to_string(), Some(remote.to_string())),
                _ => continue,
            },
            false => (short.to_string(), None),
        };
        let branch = Branch { name, remote, upstream: (!upstream.is_empty()).then(|| upstream.to_string()), committed_at_ms: seconds * 1000 };
        match at.get(&branch.name) {
            Some(&i) if rows[i].remote.is_some() && branch.remote.is_none() => rows[i] = branch,
            Some(_) => {}
            None => {
                at.insert(branch.name.clone(), rows.len());
                rows.push(branch);
            }
        }
    }
    rows.sort_by(|a, b| b.committed_at_ms.cmp(&a.committed_at_ms).then_with(|| a.name.cmp(&b.name)));
    rows.truncate(limit);
    rows
}

pub async fn list_branches(repo: &Path, limit: usize) -> Result<Vec<Branch>> {
    let format = format!("--format={BRANCH_FORMAT}");
    Ok(parse_branches(&git(repo, &["for-each-ref", &format, "refs/heads", "refs/remotes"]).await?, limit))
}

pub async fn worktree_add(repo: &Path, path: &Path, branch: &str, new_branch: bool, start_ref: Option<&str>) -> Result<()> {
    let path_s = path.to_string_lossy().into_owned();
    let mut args: Vec<&str> = vec!["worktree", "add"];
    if new_branch {
        args.extend(["-b", branch, &path_s]);
        if let Some(r) = start_ref {
            args.push(r);
        }
    } else {
        args.extend([&path_s, branch]);
    }
    git(repo, &args).await.map(|_| ())
}

/// Commits every non-ignored change as one checkpoint. Returns the new commit id,
/// or `None` when the tree was already clean.
pub async fn checkpoint(worktree: &Path, message: &str) -> Result<Option<String>> {
    let status = parse_status(&git(worktree, &["status", "--porcelain=v2", "--branch", "--untracked-files=normal"]).await?);
    if !status.dirty {
        return Ok(None);
    }
    git(worktree, &["add", "-A"]).await?;
    git(worktree, &["commit", "-m", message]).await?;
    Ok(Some(git(worktree, &["rev-parse", "HEAD"]).await?.trim().to_string()))
}

pub async fn branch_exists(repo: &Path, branch: &str) -> bool {
    git(repo, &["rev-parse", "--verify", "--quiet", &format!("refs/heads/{branch}")]).await.is_ok()
}

pub async fn worktree_remove(repo: &Path, path: &Path) -> Result<()> {
    git(repo, &["worktree", "remove", "--force", &path.to_string_lossy()]).await.map(|_| ())
}

pub async fn remote_url(repo: &Path) -> Option<String> {
    git(repo, &["remote", "get-url", "origin"]).await.ok().map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

pub async fn clone(url: &str, dest: &Path) -> Result<()> {
    let out = Command::new("git").arg("clone").arg(url).arg(dest).output().await.context("run git clone")?;
    if !out.status.success() {
        return Err(anyhow!("git clone: {}", String::from_utf8_lossy(&out.stderr).trim()));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_porcelain_with_detached_and_branch_entries() {
        let text = "worktree /repo\nHEAD abc\nbranch refs/heads/main\n\nworktree /repo-wt\nHEAD def\ndetached\n\nworktree /gone\nHEAD 000\nbranch refs/heads/feat/x y\nprunable gitdir file points to non-existent location\n";
        let entries = parse_worktree_list(text);
        assert_eq!(entries.len(), 3);
        assert_eq!(entries[0].branch.as_deref(), Some("main"));
        assert!(entries[1].detached);
        assert_eq!(entries[2].branch.as_deref(), Some("feat/x y"));
        assert!(entries[2].prunable);
    }

    #[test]
    fn parses_status_v2_headers_and_counts() {
        let text =
            "# branch.oid abc\n# branch.head main\n# branch.upstream origin/main\n# branch.ab +2 -1\n1 .M N... 100644 100644 100644 a b src/x.rs\n? new.txt\n";
        let s = parse_status(text);
        assert_eq!(s.branch.as_deref(), Some("main"));
        assert_eq!(s.ahead, Some(2));
        assert_eq!(s.behind, Some(1));
        assert_eq!(s.files_changed, 1);
        assert_eq!(s.untracked, 1);
        assert!(s.dirty);
        let d = parse_status("# branch.oid abc\n# branch.head (detached)\n");
        assert!(d.detached && !d.dirty);
    }

    #[test]
    fn numstat_ignores_binary_rows() {
        assert_eq!(parse_numstat("3\t1\ta.rs\n-\t-\tbin.png\n10\t0\tb.rs\n"), (13, 1));
    }

    #[test]
    fn a_remote_branch_folds_into_its_local_branch_and_the_newest_comes_first() {
        let text = "main\t100\torigin/main\trefs/heads/main\n\
                    old\t50\t\trefs/heads/old\n\
                    origin\t300\t\trefs/remotes/origin/HEAD\n\
                    origin/main\t100\t\trefs/remotes/origin/main\n\
                    origin/fresh\t300\t\trefs/remotes/origin/fresh\n\
                    upstream/fresh\t400\t\trefs/remotes/upstream/fresh\n";
        let rows = parse_branches(text, 10);
        assert_eq!(rows.iter().map(|b| b.name.as_str()).collect::<Vec<_>>(), ["fresh", "main", "old"], "one row for each name, newest first");
        assert_eq!(rows[0].remote.as_deref(), Some("origin"), "the first remote of a name with no local branch wins");
        assert_eq!((rows[1].remote.as_deref(), rows[1].upstream.as_deref()), (None, Some("origin/main")), "the local branch keeps its upstream");
        assert_eq!(rows[1].committed_at_ms, 100_000);
        assert_eq!(parse_branches(text, 2).len(), 2, "the limit keeps the newest");
    }

    #[tokio::test]
    async fn lists_the_branches_of_a_repository_with_a_remote() {
        let dir = PathBuf::from(format!("/tmp/tomo-branch-list-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let origin = dir.join("origin");
        let clone = dir.join("clone");
        let run = |cwd: &Path, args: &[&str]| {
            let ok = std::process::Command::new("git")
                .args(["-c", "user.email=t@t", "-c", "user.name=t", "-c", "init.defaultBranch=main"])
                .args(args)
                .current_dir(cwd)
                .output()
                .unwrap()
                .status
                .success();
            assert!(ok, "git {args:?}");
        };
        std::fs::create_dir_all(&origin).unwrap();
        run(&origin, &["init", "-q"]);
        run(&origin, &["commit", "-q", "--allow-empty", "-m", "init"]);
        run(&origin, &["branch", "feat/remote-only"]);
        run(&dir, &["clone", "-q", "origin", "clone"]);
        run(&clone, &["checkout", "-q", "-b", "feat/local"]);
        run(&clone, &["commit", "-q", "--allow-empty", "-m", "local work"]);

        let rows = list_branches(&clone, BRANCH_LIMIT).await.unwrap();
        let names: Vec<&str> = rows.iter().map(|b| b.name.as_str()).collect();
        assert_eq!(names[0], "feat/local", "the newest commit comes first");
        assert_eq!(names.iter().filter(|n| **n == "main").count(), 1, "origin/main folds into main");
        let remote_only = rows.iter().find(|b| b.name == "feat/remote-only").expect("the remote branch is in the list");
        assert_eq!(remote_only.remote.as_deref(), Some("origin"));
        assert!(rows.iter().all(|b| b.name != "origin"), "origin/HEAD is not a branch");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
