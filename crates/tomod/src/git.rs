use anyhow::{anyhow, Context, Result};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::Duration;
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

/// git reads the worktree, and a worktree can be on a mount that has gone away. Without this a
/// read of a dead path never returns and the caller waits for ever.
const GIT_TIMEOUT: Duration = Duration::from_secs(20);

async fn git(cwd: &Path, args: &[&str]) -> Result<String> {
    let child = Command::new("git")
        .arg("-C")
        .arg(cwd)
        .args(args)
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .with_context(|| format!("run git {}", args.join(" ")))?;
    let out = match tokio::time::timeout(GIT_TIMEOUT, child.wait_with_output()).await {
        Ok(result) => result.with_context(|| format!("run git {}", args.join(" ")))?,
        Err(_) => return Err(anyhow!("git {} did not answer in {}s", args.join(" "), GIT_TIMEOUT.as_secs())),
    };
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

/// Tracked files and untracked files that `.gitignore` does not exclude.
pub async fn files(path: &Path) -> Result<Vec<String>> {
    Ok(git(path, &["ls-files", "-z", "--cached", "--others", "--exclude-standard"]).await?.split('\0').filter(|f| !f.is_empty()).map(str::to_owned).collect())
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

/// The same summary without spawning git. A stale or missing worktree fails here at once,
/// where a subprocess can sit on a dead mount until something kills it.
fn summary_gix(worktree: &Path) -> Result<GitSummary> {
    use gix::bstr::ByteSlice;
    let repo = gix::open(worktree)?;
    let head = repo.head()?;
    let detached = head.referent_name().is_none();
    let branch = head.referent_name().map(|n| n.shorten().to_str_lossy().into_owned());
    let head_id = repo.head_id().map(|id| id.to_hex().to_string()).unwrap_or_default();

    let mut s = GitSummary {
        branch: branch.clone(),
        head: head_id,
        detached,
        dirty: false,
        files_changed: 0,
        untracked: 0,
        conflicts: 0,
        insertions: 0,
        deletions: 0,
        ahead: None,
        behind: None,
        upstream: None,
    };

    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    let status = repo.status(gix::progress::Discard)?.index_worktree_rewrites(None).into_iter(None)?;
    for item in status {
        let item = item?;
        match item {
            gix::status::Item::IndexWorktree(entry) => match entry {
                gix::status::index_worktree::Item::DirectoryContents { entry, .. } => {
                    if matches!(entry.status, gix::dir::entry::Status::Untracked) {
                        s.untracked += 1;
                    }
                }
                gix::status::index_worktree::Item::Modification { rela_path, status, .. } => {
                    if seen.insert(rela_path.to_str_lossy().into_owned()) {
                        s.files_changed += 1;
                        if matches!(status, gix::status::plumbing::index_as_worktree::EntryStatus::Conflict { .. }) {
                            s.conflicts += 1;
                        }
                    }
                }
                gix::status::index_worktree::Item::Rewrite { dirwalk_entry, .. } => {
                    if seen.insert(dirwalk_entry.rela_path.to_str_lossy().into_owned()) {
                        s.files_changed += 1;
                    }
                }
            },
            gix::status::Item::TreeIndex(change) => {
                let path = change.location().to_str_lossy().into_owned();
                if seen.insert(path) {
                    s.files_changed += 1;
                }
            }
        }
    }

    if let Some(name) = head.referent_name() {
        if let Some(Ok(upstream)) = repo.branch_remote_tracking_ref_name(name, gix::remote::Direction::Fetch) {
            s.upstream = Some(upstream.shorten().to_str_lossy().into_owned());
            let remote_id = repo.find_reference(upstream.as_ref()).ok().and_then(|mut r| r.peel_to_id().ok()).map(|id| id.detach());
            if let (Ok(local), Some(remote)) = (repo.head_id(), remote_id) {
                if let Ok((ahead, behind)) = count_ahead_behind(&repo, local.detach(), remote) {
                    s.ahead = Some(ahead);
                    s.behind = Some(behind);
                }
            }
        }
    }

    s.dirty = s.files_changed > 0 || s.untracked > 0;
    Ok(s)
}

/// `with_hidden` stops each walk where the histories meet, so the cost is the distance between
/// the two tips. Walking both to the root and subtracting costs the whole history instead, on a
/// branch that is three commits ahead as much as on one that has diverged for a year.
fn count_ahead_behind(repo: &gix::Repository, local: gix::ObjectId, remote: gix::ObjectId) -> Result<(u32, u32)> {
    if local == remote {
        return Ok((0, 0));
    }
    let only_on = |tip: gix::ObjectId, hidden: gix::ObjectId| -> Result<u32> {
        Ok(repo.rev_walk([tip]).with_hidden([hidden]).all()?.filter(|c| c.is_ok()).count() as u32)
    };
    Ok((only_on(local, remote)?, only_on(remote, local)?))
}

pub async fn summary(worktree: &Path) -> Result<GitSummary> {
    let dir = worktree.to_path_buf();
    let gix = tokio::task::spawn_blocking(move || summary_gix(&dir)).await;
    let mut s = match gix {
        Ok(Ok(s)) => s,
        other => {
            if let Ok(Err(e)) = other {
                tracing::debug!("gix summary for {}: {e}; falling back to git", worktree.display());
            }
            let status = git(worktree, &["status", "--porcelain=v2", "--branch", "--untracked-files=normal"]).await?;
            parse_status(&status)
        }
    };
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

/// Fetches the remote of the checked-out branch. Auto maintenance is off, so a fetch never starts a long `gc`.
pub async fn fetch(worktree: &Path) -> Result<()> {
    git(worktree, &["-c", "gc.auto=0", "-c", "maintenance.auto=false", "fetch", "--quiet"]).await.map(|_| ())
}

/// Commits on HEAD that its upstream lacks, and commits on the upstream that HEAD lacks. An error means no upstream.
pub async fn upstream_drift(worktree: &Path) -> Result<(u32, u32)> {
    let out = git(worktree, &["rev-list", "--left-right", "--count", "HEAD...@{u}"]).await?;
    let mut counts = out.split_whitespace().map(str::parse::<u32>);
    match (counts.next(), counts.next()) {
        (Some(Ok(ahead)), Some(Ok(behind))) => Ok((ahead, behind)),
        _ => Err(anyhow!("git rev-list gave {out:?}")),
    }
}

/// True when a tracked file has a change. Untracked files do not block a fast-forward.
pub async fn tracked_dirty(worktree: &Path) -> Result<bool> {
    Ok(!git(worktree, &["status", "--porcelain", "--untracked-files=no"]).await?.trim().is_empty())
}

pub async fn fast_forward(worktree: &Path) -> Result<()> {
    git(worktree, &["merge", "--ff-only", "--quiet", "@{u}"]).await.map(|_| ())
}

/// Commits every non-ignored change as one checkpoint. Returns the new commit id,
/// or `None` when the tree was already clean.
pub async fn checkpoint(worktree: &Path, message: &str) -> Result<Option<String>> {
    let status = parse_status(&git(worktree, &["status", "--porcelain=v2", "--branch", "--untracked-files=normal"]).await?);
    if !status.dirty {
        return Ok(None);
    }
    git(worktree, &["add", "-A"]).await?;
    // The checkpoint is a snapshot, not a commit that a person wrote, so the repository's hooks do not gate it.
    // A hook such as a full typecheck is slower than GIT_TIMEOUT, and a lint hook refuses work in progress.
    git(worktree, &["-c", "core.hooksPath=/dev/null", "commit", "--no-verify", "-m", message]).await?;
    Ok(Some(git(worktree, &["rev-parse", "HEAD"]).await?.trim().to_string()))
}

pub async fn branch_exists(repo: &Path, branch: &str) -> bool {
    git(repo, &["rev-parse", "--verify", "--quiet", &format!("refs/heads/{branch}")]).await.is_ok()
}

/// A hidden sibling of `path` on the same volume, so a rename to it is instant.
fn trash_path(path: &Path, now_ms: u64) -> PathBuf {
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    path.with_file_name(format!(".{name}.tomo-trash-{now_ms}"))
}

/// Deletes `path` in a process that outlives the daemon: `sh` starts `rm` in the background and exits at once.
fn delete_detached(path: &Path) {
    let started = std::process::Command::new("/bin/sh")
        .args(["-c", "rm -rf -- \"$1\" &", "sh"])
        .arg(path)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status();
    if let Err(e) = started {
        tracing::warn!("delete {}: {e}", path.display());
    }
}

/// Deletes the trash in `dirs` that an earlier background delete did not finish, such as one that a reboot stopped.
/// Returns how many it started to delete.
pub fn sweep_trash(dirs: &[PathBuf]) -> usize {
    let trash: Vec<PathBuf> = dirs
        .iter()
        .filter_map(|dir| std::fs::read_dir(dir).ok())
        .flatten()
        .flatten()
        .filter(|e| e.file_name().to_string_lossy().starts_with('.') && e.file_name().to_string_lossy().contains(".tomo-trash-"))
        .map(|e| e.path())
        .collect();
    trash.iter().for_each(|t| delete_detached(t));
    trash.len()
}

/// Removes a worktree without a long delete under `GIT_TIMEOUT`: the tree moves aside, Git forgets only this
/// worktree, and the files go in the background. A repository worktree has about 240,000 files, and
/// `git worktree remove` deletes them inline. It also handles a tree that an earlier remove left half deleted.
pub async fn worktree_remove(repo: &Path, path: &Path) -> Result<()> {
    let trash = trash_path(path, tomo_proto::now_ms());
    let moved_aside = path.exists() && std::fs::rename(path, &trash).is_ok();
    let removed = match git(repo, &["worktree", "remove", "--force", &path.to_string_lossy()]).await {
        Err(_) if !list_worktrees(repo).await?.iter().any(|w| w.path == path) => Ok(()),
        other => other.map(|_| ()),
    };
    match (moved_aside, &removed) {
        (true, Ok(())) => delete_detached(&trash),
        (true, Err(_)) => std::fs::rename(&trash, path).with_context(|| format!("put {} back", path.display()))?,
        (false, _) => {}
    }
    removed
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
mod compare {
    use super::*;

    /// Names the worktrees to compare in `TOMO_GIT_COMPARE`, so it is run on purpose:
    /// `TOMO_GIT_COMPARE=/a:/b cargo test -p tomod git::compare -- --ignored --nocapture`
    #[tokio::test]
    #[ignore = "needs real worktrees named in TOMO_GIT_COMPARE"]
    async fn gix_agrees_with_git_on_every_worktree_it_is_given() {
        let Ok(list) = std::env::var("TOMO_GIT_COMPARE") else {
            eprintln!("set TOMO_GIT_COMPARE to a colon separated list of worktrees");
            return;
        };
        let mut checked = 0;
        let mut mismatch = Vec::new();
        for dir in list.split(':').filter(|d| !d.is_empty()) {
            let path = Path::new(dir);
            if !path.is_dir() {
                continue;
            }
            let Ok(want) = summary(path).await else { continue };
            let got = match summary_gix(path) {
                Ok(g) => g,
                Err(e) => {
                    mismatch.push(format!("{dir}: gix failed: {e}"));
                    continue;
                }
            };
            checked += 1;
            let same = want.branch == got.branch
                && want.detached == got.detached
                && want.dirty == got.dirty
                && want.files_changed == got.files_changed
                && want.untracked == got.untracked
                && want.upstream == got.upstream
                && want.ahead == got.ahead
                && want.behind == got.behind;
            if !same {
                mismatch.push(format!(
                    "{dir}\n  git: branch={:?} dirty={} changed={} untracked={} up={:?} ahead={:?} behind={:?}\n  gix: branch={:?} dirty={} changed={} untracked={} up={:?} ahead={:?} behind={:?}",
                    want.branch, want.dirty, want.files_changed, want.untracked, want.upstream, want.ahead, want.behind,
                    got.branch, got.dirty, got.files_changed, got.untracked, got.upstream, got.ahead, got.behind
                ));
            }
        }
        let dirs: Vec<&Path> = list.split(':').filter(|d| !d.is_empty()).map(Path::new).filter(|p| p.is_dir()).collect();
        let t0 = std::time::Instant::now();
        for d in &dirs {
            let _ = summary_gix(d);
        }
        let gix_ms = t0.elapsed().as_secs_f64() * 1000.0;
        let t1 = std::time::Instant::now();
        for d in &dirs {
            let _ = git(d, &["status", "--porcelain=v2", "--branch", "--untracked-files=normal"]).await;
        }
        let git_ms = t1.elapsed().as_secs_f64() * 1000.0;
        println!("timing over {} worktrees: gix {gix_ms:.0} ms, git {git_ms:.0} ms ({:.1}x)", dirs.len(), git_ms / gix_ms.max(0.001));
        println!("compared {checked} worktrees, {} disagreed", mismatch.len());
        for m in &mismatch {
            println!("{m}");
        }
        assert!(mismatch.is_empty(), "{} of {checked} disagreed", mismatch.len());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run_git(cwd: &Path, args: &[&str]) {
        let out = std::process::Command::new("git").args(["-c", "user.email=t@t", "-c", "user.name=t"]).args(args).current_dir(cwd).output().unwrap();
        assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    }

    fn repo_with_worktrees(name: &str, worktrees: &[&str]) -> PathBuf {
        let dir = PathBuf::from(format!("/private/tmp/tomo-git-test-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        run_git(&dir, &["init", "-q", "repo"]);
        run_git(&dir.join("repo"), &["commit", "-q", "--allow-empty", "-m", "init"]);
        for w in worktrees {
            run_git(&dir.join("repo"), &["worktree", "add", "-q", "-b", w, dir.join(w).to_str().unwrap()]);
        }
        dir
    }

    async fn gone_within(path: &Path, secs: u64) -> bool {
        for _ in 0..secs * 10 {
            if !path.exists() {
                return true;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        false
    }

    #[tokio::test]
    async fn worktree_remove_forgets_only_that_worktree_and_deletes_it_in_the_background() {
        let dir = repo_with_worktrees("remove", &["a", "b"]);
        std::fs::create_dir_all(dir.join("a/node_modules/pkg")).unwrap();
        std::fs::write(dir.join("a/node_modules/pkg/index.js"), "x").unwrap();
        std::fs::rename(dir.join("b"), dir.join("b-moved-by-hand")).unwrap();

        worktree_remove(&dir.join("repo"), &dir.join("a")).await.unwrap();

        let listed: Vec<PathBuf> = list_worktrees(&dir.join("repo")).await.unwrap().into_iter().map(|w| w.path).collect();
        assert!(!listed.contains(&dir.join("a")));
        assert!(listed.contains(&dir.join("b")), "a stale sibling is not pruned by accident");
        assert!(!dir.join("a").exists());
        let trash: Vec<_> = std::fs::read_dir(&dir).unwrap().flatten().filter(|e| e.file_name().to_string_lossy().contains("tomo-trash")).map(|e| e.path()).collect();
        for t in &trash {
            assert!(gone_within(t, 10).await, "the trash is deleted");
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn worktree_remove_finishes_a_tree_that_an_earlier_remove_left_half_deleted() {
        let dir = repo_with_worktrees("half", &["a"]);
        std::fs::remove_file(dir.join("a/.git")).unwrap();
        std::fs::create_dir_all(dir.join("a/apps/web")).unwrap();

        worktree_remove(&dir.join("repo"), &dir.join("a")).await.unwrap();

        assert!(list_worktrees(&dir.join("repo")).await.unwrap().iter().all(|w| w.path != dir.join("a")));
        assert!(!dir.join("a").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn worktree_remove_accepts_a_worktree_that_git_already_forgot() {
        let dir = repo_with_worktrees("forgotten", &["a"]);
        std::fs::remove_dir_all(dir.join("a")).unwrap();
        run_git(&dir.join("repo"), &["worktree", "prune"]);

        worktree_remove(&dir.join("repo"), &dir.join("a")).await.unwrap();
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn summary_counts_a_merge_conflict() {
        let dir = repo_with_worktrees("conflict", &["feat"]);
        std::fs::write(dir.join("feat/c.txt"), "a").unwrap();
        run_git(&dir.join("feat"), &["add", "c.txt"]);
        run_git(&dir.join("feat"), &["commit", "-q", "-m", "a"]);
        std::fs::write(dir.join("repo/c.txt"), "b").unwrap();
        run_git(&dir.join("repo"), &["add", "c.txt"]);
        run_git(&dir.join("repo"), &["commit", "-q", "-m", "b"]);
        let main = String::from_utf8(std::process::Command::new("git").args(["-C", dir.join("repo").to_str().unwrap(), "branch", "--show-current"]).output().unwrap().stdout).unwrap();
        let merged = std::process::Command::new("git").args(["-C", dir.join("feat").to_str().unwrap(), "merge", "-q", main.trim()]).output().unwrap();
        assert!(!merged.status.success(), "the fixture makes a conflict");

        let s = summary(&dir.join("feat")).await.unwrap();
        assert_eq!(s.conflicts, 1, "{s:?}");
        assert!(s.dirty);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn sweep_deletes_only_tomo_trash() {
        let dir = PathBuf::from(format!("/private/tmp/tomo-git-test-sweep-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join(".kashiba.tomo-trash-1/apps")).unwrap();
        std::fs::create_dir_all(dir.join("kashiba")).unwrap();
        std::fs::create_dir_all(dir.join(".not-trash")).unwrap();

        assert_eq!(sweep_trash(&[dir.clone(), dir.join("missing")]), 1);

        assert!(gone_within(&dir.join(".kashiba.tomo-trash-1"), 10).await);
        assert!(dir.join("kashiba").exists() && dir.join(".not-trash").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn a_checkpoint_does_not_run_the_repository_hooks() {
        let dir = repo_with_worktrees("hooks", &["a"]);
        let hooks = dir.join("a/.hooks");
        std::fs::create_dir_all(&hooks).unwrap();
        std::fs::write(hooks.join("pre-commit"), "#!/bin/sh\necho lint failed >&2\nexit 1\n").unwrap();
        std::process::Command::new("chmod").arg("+x").arg(hooks.join("pre-commit")).status().unwrap();
        run_git(&dir.join("repo"), &["config", "core.hooksPath", ".hooks"]);
        std::fs::write(dir.join("a/wip.ts"), "work in progress").unwrap();

        assert!(checkpoint(&dir.join("a"), "tomo: archive checkpoint").await.unwrap().is_some());
        let _ = std::fs::remove_dir_all(&dir);
    }

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
