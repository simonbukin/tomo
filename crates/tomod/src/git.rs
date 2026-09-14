use anyhow::{anyhow, Context, Result};
use std::path::{Path, PathBuf};
use tokio::process::Command;
use tomo_proto::GitSummary;

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
            let mut entry = WorktreeEntry {
                path: PathBuf::new(),
                head: String::new(),
                branch: None,
                detached: false,
                bare: false,
                prunable: false,
            };
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
        } else if line.starts_with("1 ") || line.starts_with("2 ") || line.starts_with("u ") {
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
    if let Ok(numstat) = git(worktree, &["diff", "HEAD", "--numstat"]).await {
        let (ins, del) = parse_numstat(&numstat);
        s.insertions = ins;
        s.deletions = del;
    }
    Ok(s)
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

pub async fn worktree_remove(repo: &Path, path: &Path) -> Result<()> {
    git(repo, &["worktree", "remove", "--force", &path.to_string_lossy()]).await.map(|_| ())
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
        let text = "# branch.oid abc\n# branch.head main\n# branch.upstream origin/main\n# branch.ab +2 -1\n1 .M N... 100644 100644 100644 a b src/x.rs\n? new.txt\n";
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
}
