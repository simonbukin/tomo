//! Keeps the main worktree of each repository on its upstream: a fetch, then a fast-forward only when nothing can be lost.
//! It runs every five minutes while a client is subscribed, and before a new branch starts from the main worktree.

use crate::daemon::Daemon;
use crate::git;
use std::sync::Arc;
use std::time::Duration;
use tomo_proto::*;

const TICK: Duration = Duration::from_secs(30);
const EVERY_MS: u64 = 5 * 60 * 1000;
/// A worktree create reuses a sync this young, so two creates in a row fetch once.
pub const FRESH_MS: u64 = 30_000;

const DIVERGED: &str = "it has commits that its upstream does not have";
const NO_UPSTREAM: &str = "the branch has no upstream";

#[derive(Debug, PartialEq, Eq)]
enum Plan {
    UpToDate,
    Forward,
    Skip(&'static str),
}

fn plan(ahead: u32, behind: u32, dirty: bool, busy: bool) -> Plan {
    match () {
        _ if behind == 0 => Plan::UpToDate,
        _ if ahead > 0 => Plan::Skip(DIVERGED),
        _ if dirty => Plan::Skip("it has uncommitted changes"),
        _ if busy => Plan::Skip("an agent is working in it"),
        _ => Plan::Forward,
    }
}

/// True when the last sync of `repo_id` is older than `max_age_ms`.
pub fn due(inner: &crate::daemon::Inner, repo_id: &str, max_age_ms: u64, now: u64) -> bool {
    inner.main_synced_ms.get(repo_id).is_none_or(|at| now < *at || now - at >= max_age_ms)
}

/// A problem for diagnostics: only a result that needs a person. A dirty tree, a busy agent, or a local-only branch is a normal state.
fn problem(result: &MainSync) -> Option<String> {
    match result {
        MainSync::Skipped { reason } if reason == DIVERGED => Some(format!("not synced: {reason}")),
        MainSync::Failed { message } => Some(format!("sync failed: {message}")),
        _ => None,
    }
}

async fn attempt(path: &std::path::Path, busy: bool) -> MainSync {
    if git::upstream_drift(path).await.is_err() {
        return MainSync::Skipped { reason: NO_UPSTREAM.into() };
    }
    if let Err(e) = git::fetch(path).await {
        return MainSync::Failed { message: e.to_string() };
    }
    let (ahead, behind) = match git::upstream_drift(path).await {
        Ok(drift) => drift,
        Err(e) => return MainSync::Failed { message: e.to_string() },
    };
    let dirty = match git::tracked_dirty(path).await {
        Ok(dirty) => dirty,
        Err(e) => return MainSync::Failed { message: e.to_string() },
    };
    match plan(ahead, behind, dirty, busy) {
        Plan::UpToDate => MainSync::UpToDate,
        Plan::Skip(reason) => MainSync::Skipped { reason: reason.into() },
        Plan::Forward => match git::fast_forward(path).await {
            Ok(()) => MainSync::Forwarded { commits: behind },
            Err(e) => MainSync::Failed { message: e.to_string() },
        },
    }
}

/// Syncs the main worktree of one repository. A repository with no main worktree on disk is skipped.
/// One sync runs for each repository at a time, because two git runs in one worktree collide on its index lock.
pub async fn sync_repo(daemon: &Arc<Daemon>, repo_id: &str) -> MainSync {
    let main = {
        let mut inner = daemon.lock();
        if !inner.main_syncing.insert(repo_id.to_string()) {
            return MainSync::Skipped { reason: "a sync of this repository is running".into() };
        }
        let repo_name = inner.repos.iter().find(|r| r.id == repo_id).map(|r| r.name.clone()).unwrap_or_default();
        inner.worktrees.values().find(|w| w.repo_id == repo_id && w.is_main && w.exists && w.archived_at_ms.is_none()).map(|w| {
            let busy = inner.agents.values().any(|a| a.worktree_id == w.id && a.state != AgentState::Exited);
            (w.id.clone(), w.path.clone(), busy, repo_name)
        })
    };
    let Some((worktree_id, path, busy, repo_name)) = main else {
        daemon.lock().main_syncing.remove(repo_id);
        return MainSync::Skipped { reason: "the repository has no main worktree".into() };
    };
    let result = attempt(&path, busy).await;
    {
        let mut inner = daemon.lock();
        inner.main_syncing.remove(repo_id);
        inner.main_synced_ms.insert(repo_id.to_string(), now_ms());
        Daemon::diagnostic_on_change(&mut inner, "sync", &format!("main of {repo_name}"), problem(&result));
        if let MainSync::Forwarded { commits } = &result {
            Daemon::diagnostic(&mut inner, DiagnosticLevel::Info, "sync", format!("main of {repo_name}: fast-forwarded {commits} commits"));
        }
    }
    daemon.refresh_git(&worktree_id).await;
    result
}

/// The background sync. It works only while a client is subscribed, one repository at a time.
pub async fn run(daemon: Arc<Daemon>) {
    loop {
        tokio::time::sleep(TICK).await;
        let due_repos: Vec<Id> = {
            let inner = daemon.lock();
            if !inner.clients.values().any(|c| c.subscribed) {
                continue;
            }
            inner.repos.iter().filter(|r| due(&inner, &r.id, EVERY_MS, now_ms())).map(|r| r.id.clone()).collect()
        };
        for repo_id in due_repos {
            sync_repo(&daemon, &repo_id).await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::Paths;
    use std::path::Path;

    #[test]
    fn only_a_failure_or_a_diverged_main_is_a_problem() {
        assert!(problem(&MainSync::Failed { message: "x".into() }).is_some());
        assert!(problem(&MainSync::Skipped { reason: DIVERGED.into() }).is_some());
        assert!(problem(&MainSync::Skipped { reason: NO_UPSTREAM.into() }).is_none());
        assert!(problem(&MainSync::Skipped { reason: "it has uncommitted changes".into() }).is_none());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_repository_without_a_remote_is_skipped_quietly() {
        let dir = std::path::PathBuf::from(format!("/tmp/tomo-sync-test-local-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("repo")).unwrap();
        std::fs::create_dir_all(dir.join("data")).unwrap();
        git(&dir.join("repo"), &["init", "-q"]);
        git(&dir.join("repo"), &["commit", "-q", "--allow-empty", "-m", "init"]);
        let (daemon, repo_id) = daemon_on(&dir, &dir.join("repo")).await;
        assert_eq!(sync_repo(&daemon, &repo_id).await, MainSync::Skipped { reason: NO_UPSTREAM.into() });
        assert!(daemon.lock().problems.is_empty());
        daemon.shutdown();
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn plan_forwards_only_a_clean_idle_branch_that_is_only_behind() {
        assert_eq!(plan(0, 0, true, true), Plan::UpToDate);
        assert_eq!(plan(0, 3, false, false), Plan::Forward);
        assert!(matches!(plan(1, 3, false, false), Plan::Skip(r) if r.contains("upstream")));
        assert!(matches!(plan(0, 3, true, false), Plan::Skip(r) if r.contains("uncommitted")));
        assert!(matches!(plan(0, 3, false, true), Plan::Skip(r) if r.contains("agent")));
    }

    fn git(dir: &Path, args: &[&str]) {
        let out = std::process::Command::new("git").args(["-c", "user.email=t@t", "-c", "user.name=t"]).args(args).current_dir(dir).output().unwrap();
        assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    }

    /// A bare remote, a main clone that Tomo watches, and a second clone that pushes.
    fn fixture(name: &str) -> (std::path::PathBuf, std::path::PathBuf, std::path::PathBuf) {
        let dir = std::path::PathBuf::from(format!("/tmp/tomo-sync-test-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("data")).unwrap();
        git(Path::new("/tmp"), &["init", "-q", "--bare", "-b", "main", dir.join("remote.git").to_str().unwrap()]);
        git(&dir, &["clone", "-q", "remote.git", "main"]);
        git(&dir.join("main"), &["commit", "-q", "--allow-empty", "-m", "init"]);
        git(&dir.join("main"), &["push", "-q", "-u", "origin", "HEAD:main"]);
        git(&dir, &["clone", "-q", "remote.git", "other"]);
        (dir.clone(), dir.join("main"), dir.join("other"))
    }

    fn push_commit(other: &Path, file: &str) {
        std::fs::write(other.join(file), "x").unwrap();
        git(other, &["add", file]);
        git(other, &["commit", "-q", "-m", file]);
        git(other, &["push", "-q", "origin", "HEAD:main"]);
    }

    async fn daemon_on(dir: &Path, main: &Path) -> (Arc<Daemon>, Id) {
        let seams = crate::daemon::Seams { worktree_namer: None, worktree_created: vec![], worktree_rebound: vec![], worktree_files: vec![], pane_exited: vec![], process_polled: vec![], hook_events: vec![] };
        let daemon = Daemon::new(Paths::new(dir.join("data")), seams, Box::new(())).unwrap();
        daemon.handle(0, Call::RepoAdd { path: main.to_path_buf() }).await.unwrap();
        let repo_id = daemon.lock().repos[0].id.clone();
        (daemon, repo_id)
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn sync_fast_forwards_a_clean_main_and_leaves_a_dirty_or_diverged_one() {
        let (dir, main, other) = fixture("ff");
        let (daemon, repo_id) = daemon_on(&dir, &main).await;

        assert_eq!(sync_repo(&daemon, &repo_id).await, MainSync::UpToDate);
        push_commit(&other, "a");
        push_commit(&other, "b");
        assert_eq!(sync_repo(&daemon, &repo_id).await, MainSync::Forwarded { commits: 2 });
        assert!(main.join("b").exists());

        push_commit(&other, "c");
        std::fs::write(main.join("a"), "local edit").unwrap();
        assert!(matches!(sync_repo(&daemon, &repo_id).await, MainSync::Skipped { reason } if reason.contains("uncommitted")));
        assert_eq!(std::fs::read_to_string(main.join("a")).unwrap(), "local edit");
        git(&main, &["checkout", "-q", "--", "a"]);

        git(&main, &["commit", "-q", "--allow-empty", "-m", "local"]);
        assert!(matches!(sync_repo(&daemon, &repo_id).await, MainSync::Skipped { reason } if reason.contains("upstream")));
        assert!(!main.join("c").exists());
        daemon.shutdown();
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_new_branch_starts_from_the_synced_main() {
        let (dir, main, other) = fixture("create");
        let (daemon, repo_id) = daemon_on(&dir, &main).await;
        push_commit(&other, "fresh");
        let spec = WorktreeCreate { repo_id, branch: "feat".into(), new_branch: true, start_ref: None, path: Some(dir.join("feat")), name_hint: None, metadata: None };
        daemon.handle(0, Call::WorktreeCreate(spec)).await.unwrap();
        assert!(dir.join("feat/fresh").exists(), "the new branch has the commit that was pushed before the create");
        daemon.shutdown();
        let _ = std::fs::remove_dir_all(&dir);
    }
}
