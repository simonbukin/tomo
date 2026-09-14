use crate::daemon::{Daemon, Summaries};
use notify::{RecursiveMode, Watcher};
use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

fn interesting(event: &notify::Event) -> bool {
    event.paths.iter().any(|p| {
        let s = p.to_string_lossy();
        !s.contains("/objects/") && !s.ends_with(".lock") && !s.contains("/logs/")
    })
}

pub async fn run(daemon: Arc<Daemon>) {
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<()>();
    let mut watcher = match notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        if let Ok(ev) = res {
            if interesting(&ev) {
                let _ = tx.send(());
            }
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
        let repo_dirs: Vec<PathBuf> = daemon.lock().repos.iter().filter(|r| r.exists).map(|r| r.path.join(".git")).collect();
        let fresh: Vec<PathBuf> = repo_dirs.into_iter().filter(|d| d.is_dir() && !watched.contains(d)).collect();
        for dir in fresh {
            if watcher.watch(&dir, RecursiveMode::Recursive).is_ok() {
                watched.insert(dir);
            }
        }
        tokio::select! {
            _ = ticker.tick() => {}
            _ = daemon.repos_changed.notified() => {}
            _ = daemon.refresh.notified() => { debounce(&mut rx).await; let _ = daemon.discover(Summaries::All).await; }
            Some(()) = rx.recv() => { debounce(&mut rx).await; let _ = daemon.discover(Summaries::Cached).await; }
        }
    }
}

async fn debounce(rx: &mut tokio::sync::mpsc::UnboundedReceiver<()>) {
    tokio::time::sleep(Duration::from_millis(400)).await;
    while rx.try_recv().is_ok() {}
}
