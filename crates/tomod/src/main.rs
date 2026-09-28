mod activity;
mod addons;
mod agents;
mod config;
mod daemon;
mod dispatch;
mod events;
mod features;
mod git;
mod holder;
mod identity;
mod layout;
mod login_env;
mod monitor;
mod moves;
mod procs;
mod providers;
mod pty;
mod server;
mod settings;
mod store;
mod subagents;
mod sync;
mod system;
mod vt;
mod watch;

use anyhow::{Context, Result};
use clap::Parser;
use std::path::PathBuf;
use tokio::net::{UnixListener, UnixStream};

#[derive(Parser)]
#[command(name = "tomod", about = "Tomo daemon: owns terminals, worktree state, and agent signals")]
struct Args {
    #[arg(long, env = "TOMO_DATA_DIR")]
    data_dir: Option<PathBuf>,
    #[arg(long, env = "TOMO_SOCKET")]
    socket: Option<PathBuf>,
}

/// Replays the hook events that `tomo hook` kept while no daemon ran, oldest first. The spool moves aside first,
/// so a hook that writes during the replay starts a new one. `merge` ignores an event older than the state it meets.
async fn replay_hook_spool(daemon: &std::sync::Arc<daemon::Daemon>) {
    const MAX_AGE_MS: u64 = 24 * 60 * 60 * 1000;
    let spool = daemon.paths.data_dir.join(tomo_proto::HOOK_SPOOL);
    let taken = spool.with_extension("replaying");
    if std::fs::rename(&spool, &taken).is_err() {
        return;
    }
    let text = std::fs::read_to_string(&taken).unwrap_or_default();
    let now = tomo_proto::now_ms();
    let mut calls: Vec<(u64, tomo_proto::Call)> = text
        .lines()
        .filter_map(|line| serde_json::from_str::<tomo_proto::Call>(line).ok())
        .filter_map(|call| match &call {
            tomo_proto::Call::AgentHook { at_ms, .. } if now.saturating_sub(*at_ms) < MAX_AGE_MS => Some((*at_ms, call)),
            _ => None,
        })
        .collect();
    calls.sort_by_key(|(at_ms, _)| *at_ms);
    let count = calls.len();
    for (_, call) in calls {
        let _ = dispatch::handle(daemon, 0, call).await;
    }
    let _ = std::fs::remove_file(&taken);
    if count > 0 {
        tracing::info!("replayed {count} hook events that arrived while no daemon ran");
    }
}

fn try_lock(file: &std::fs::File) -> bool {
    use std::os::unix::io::AsRawFd;
    unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) == 0 }
}

fn main() -> Result<()> {
    if std::env::args().nth(1).as_deref() == Some("pty-holder") {
        holder::main();
    }
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()))
        .with_writer(std::io::stderr)
        .init();
    let args = Args::parse();
    login_env::apply();
    tokio::runtime::Builder::new_multi_thread().enable_all().build()?.block_on(run(args))
}

async fn run(args: Args) -> Result<()> {
    let data_dir = args.data_dir.unwrap_or_else(config::default_data_dir);
    std::fs::create_dir_all(&data_dir).with_context(|| format!("create {}", data_dir.display()))?;
    let mut paths = config::Paths::new(data_dir);
    if let Some(s) = args.socket {
        paths.socket = s;
    }

    let lock = std::fs::OpenOptions::new().create(true).write(true).truncate(false).open(paths.data_dir.join("tomod.lock"))?;
    if !try_lock(&lock) || UnixStream::connect(&paths.socket).await.is_ok() {
        eprintln!("tomod already running at {}", paths.socket.display());
        return Ok(());
    }
    let _ = std::fs::remove_file(&paths.socket);
    let listener = UnixListener::bind(&paths.socket).with_context(|| format!("bind {}", paths.socket.display()))?;

    let daemon = daemon::Daemon::new(paths, addons::seams(), Box::new(addons::State::default()))?;
    addons::migrate(&daemon.lock().store)?;
    daemon.restore()?;
    tracing::info!("tomod {} listening on {}", daemon::VERSION, daemon.paths.socket.display());

    tokio::spawn(server::serve(daemon.clone(), listener));
    replay_hook_spool(&daemon).await;
    {
        let d = daemon.clone();
        tokio::spawn(async move {
            if let Err(e) = d.discover(daemon::Summaries::Cached).await {
                tracing::warn!("initial discovery: {e}");
            }
            let _ = d.discover(daemon::Summaries::All).await;
            let parents: std::collections::BTreeSet<std::path::PathBuf> = d.lock().worktrees.values().filter_map(|w| w.path.parent().map(std::path::Path::to_path_buf)).collect();
            let swept = git::sweep_trash(&parents.into_iter().collect::<Vec<_>>());
            if swept > 0 {
                tracing::info!("deleting {swept} archived trees that an earlier delete left");
            }
        });
    }
    tokio::spawn(monitor::run(daemon.clone()));
    addons::start(&daemon);
    tokio::spawn(system::run(daemon.clone()));
    tokio::spawn(sync::run(daemon.clone()));
    tokio::spawn(watch::run(daemon.clone()));
    tokio::spawn(features::editor_pane::watch(daemon.clone()));
    tokio::spawn(settings::watch(daemon.clone()));

    let mut sigterm = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
    tokio::select! {
        _ = daemon.stop.notified() => tracing::info!("stop requested"),
        _ = tokio::signal::ctrl_c() => tracing::info!("interrupted"),
        _ = sigterm.recv() => tracing::info!("terminated"),
    }
    match daemon.kill_panes_on_stop.load(std::sync::atomic::Ordering::SeqCst) {
        true => daemon.shutdown(),
        false => daemon.detach_panes(),
    }
    let _ = std::fs::remove_file(&daemon.paths.socket);
    drop(lock);
    Ok(())
}
