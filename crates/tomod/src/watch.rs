use crate::daemon::{Daemon, Summaries};
use notify::{RecursiveMode, Watcher};
use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

#[derive(Clone, Copy, PartialEq)]
enum Change {
    Git,
    Actions,
}

fn classify(event: &notify::Event) -> Option<Change> {
    if event.paths.iter().any(|p| p.file_name().map_or(false, |n| n == crate::features::actions::FILE_NAME)) {
        return Some(Change::Actions);
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
    let mut watcher = match notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        if let Some(change) = res.ok().as_ref().and_then(classify) {
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
        let (repo_dirs, worktree_dirs): (Vec<PathBuf>, Vec<PathBuf>) = {
            let inner = daemon.lock();
            (
                inner.repos.iter().filter(|r| r.exists).map(|r| r.path.join(".git")).collect(),
                inner.worktrees.values().filter(|w| w.exists).map(|w| w.path.clone()).collect(),
            )
        };
        for (dir, mode) in repo_dirs.into_iter().map(|d| (d, RecursiveMode::Recursive)).chain(worktree_dirs.into_iter().map(|d| (d, RecursiveMode::NonRecursive))) {
            if dir.is_dir() && !watched.contains(&dir) && watcher.watch(&dir, mode).is_ok() {
                watched.insert(dir);
            }
        }
        tokio::select! {
            _ = ticker.tick() => {}
            _ = daemon.repos_changed.notified() => {}
            _ = daemon.refresh.notified() => { debounce(&mut rx).await; let _ = daemon.discover(Summaries::All).await; }
            Some(change) = rx.recv() => {
                let git = debounce(&mut rx).await || change == Change::Git;
                if git { let _ = daemon.discover(Summaries::Cached).await; } else { daemon.reload_actions(); }
            }
        }
    }
}

/// Drains the burst; returns true when any git change was in it.
async fn debounce(rx: &mut tokio::sync::mpsc::UnboundedReceiver<Change>) -> bool {
    tokio::time::sleep(Duration::from_millis(400)).await;
    let mut git = false;
    while let Ok(c) = rx.try_recv() {
        git |= c == Change::Git;
    }
    git
}
