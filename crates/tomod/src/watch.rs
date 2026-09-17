use crate::daemon::{Daemon, Summaries, WorktreeFile};
use notify::{RecursiveMode, Watcher};
use std::collections::{BTreeSet, HashSet};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

enum Change {
    Git,
    /// The index of the changed file in `Seams::worktree_files`.
    File(usize),
}

fn classify(files: &[WorktreeFile], event: &notify::Event) -> Option<Change> {
    if let Some(i) = event.paths.iter().find_map(|p| files.iter().position(|f| p.file_name().is_some_and(|n| n == f.name))) {
        return Some(Change::File(i));
    }
    event
        .paths
        .iter()
        .any(|p| {
            let s = p.to_string_lossy();
            s.contains("/.git/") && !s.contains("/objects/") && !s.ends_with(".lock") && !s.contains("/logs/")
        })
        .then_some(Change::Git)
}

pub async fn run(daemon: Arc<Daemon>) {
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<Change>();
    let files = daemon.seams.worktree_files.clone();
    let mut watcher = match notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        if let Some(change) = res.ok().as_ref().and_then(|e| classify(&files, e)) {
            let _ = tx.send(change);
        }
    }) {
        Ok(w) => w,
        Err(e) => {
            tracing::warn!("git watcher unavailable: {e}");
            return;
        }
    };
    let mut watched: HashSet<PathBuf> = HashSet::new();
    let mut ticker = tokio::time::interval(Duration::from_secs(30));
    loop {
        // The repository root joins the flat list because a `worktree_files` file can live there
        // for the whole repository, and the root is not always an open worktree.
        let (repo_dirs, flat_dirs): (Vec<PathBuf>, Vec<PathBuf>) = {
            let inner = daemon.lock();
            (
                inner.repos.iter().filter(|r| r.exists).map(|r| r.path.join(".git")).collect(),
                inner
                    .worktrees
                    .values()
                    .filter(|w| w.exists)
                    .map(|w| w.path.clone())
                    .chain(inner.repos.iter().filter(|r| r.exists).map(|r| r.path.clone()))
                    .collect(),
            )
        };
        for (dir, mode) in repo_dirs.into_iter().map(|d| (d, RecursiveMode::Recursive)).chain(flat_dirs.into_iter().map(|d| (d, RecursiveMode::NonRecursive))) {
            if dir.is_dir() && !watched.contains(&dir) && watcher.watch(&dir, mode).is_ok() {
                watched.insert(dir);
            }
        }
        tokio::select! {
            _ = ticker.tick() => {}
            _ = daemon.repos_changed.notified() => {}
            _ = daemon.refresh.notified() => { drain(&mut rx).await; let _ = daemon.discover(Summaries::All).await; }
            Some(change) = rx.recv() => {
                let burst: Vec<Change> = std::iter::once(change).chain(drain(&mut rx).await).collect();
                let files: BTreeSet<usize> = burst.iter().filter_map(|c| match c { Change::File(i) => Some(*i), Change::Git => None }).collect();
                if burst.iter().any(|c| matches!(c, Change::Git)) {
                    let _ = daemon.discover(Summaries::Cached).await;
                } else {
                    for i in files {
                        (daemon.seams.worktree_files[i].reload)(&daemon);
                    }
                }
            }
        }
    }
}

/// Waits out a burst of changes and returns the rest of it.
async fn drain(rx: &mut tokio::sync::mpsc::UnboundedReceiver<Change>) -> Vec<Change> {
    tokio::time::sleep(Duration::from_millis(400)).await;
    std::iter::from_fn(|| rx.try_recv().ok()).collect()
}
