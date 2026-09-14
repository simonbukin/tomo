mod activity;
mod agents;
mod config;
mod daemon;
mod events;
mod features;
mod git;
mod github;
mod integrations;
mod layout;
mod monitor;
mod procs;
mod pty;
mod server;
mod store;
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

fn try_lock(file: &std::fs::File) -> bool {
    use std::os::unix::io::AsRawFd;
    unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) == 0 }
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()))
        .with_writer(std::io::stderr)
        .init();
    let args = Args::parse();
    let data_dir = args.data_dir.unwrap_or_else(config::default_data_dir);
    std::fs::create_dir_all(&data_dir).with_context(|| format!("create {}", data_dir.display()))?;
    let mut paths = config::Paths::new(data_dir);
    if let Some(s) = args.socket {
        paths.socket = s;
    }

    let lock = std::fs::OpenOptions::new().create(true).write(true).open(paths.data_dir.join("tomod.lock"))?;
    if !try_lock(&lock) || UnixStream::connect(&paths.socket).await.is_ok() {
        eprintln!("tomod already running at {}", paths.socket.display());
        return Ok(());
    }
    let _ = std::fs::remove_file(&paths.socket);
    let listener = UnixListener::bind(&paths.socket).with_context(|| format!("bind {}", paths.socket.display()))?;

    let daemon = daemon::Daemon::new(paths)?;
    daemon.restore()?;
    tracing::info!("tomod {} listening on {}", daemon::VERSION, daemon.paths.socket.display());

    tokio::spawn(server::serve(daemon.clone(), listener));
    {
        let d = daemon.clone();
        tokio::spawn(async move {
            if let Err(e) = d.discover(daemon::Summaries::Cached).await {
                tracing::warn!("initial discovery: {e}");
            }
            let _ = d.discover(daemon::Summaries::All).await;
        });
    }
    tokio::spawn(monitor::run(daemon.clone()));
    tokio::spawn(watch::run(daemon.clone()));

    let mut sigterm = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
    tokio::select! {
        _ = daemon.stop.notified() => tracing::info!("stop requested"),
        _ = tokio::signal::ctrl_c() => tracing::info!("interrupted"),
        _ = sigterm.recv() => tracing::info!("terminated"),
    }
    daemon.shutdown();
    let _ = std::fs::remove_file(&daemon.paths.socket);
    drop(lock);
    Ok(())
}
