use crate::config;
use crate::daemon::Daemon;
use notify::{RecursiveMode, Watcher};
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Arc;
use std::time::Duration;
use tomo_proto::{Config, ErrorCode, Event, RpcError};

fn rpc_err(code: ErrorCode, message: impl Into<String>) -> RpcError {
    RpcError { code, message: message.into() }
}

/// Loads config.toml into the daemon and pushes `config_changed` when the result differs.
pub fn reload(daemon: &Daemon) -> Config {
    let Ok(cfg) = config::load(&daemon.paths.config) else { return daemon.lock().config.clone() };
    let mut inner = daemon.lock();
    if serde_json::to_value(&inner.config).ok() != serde_json::to_value(&cfg).ok() {
        inner.config = cfg.clone();
        Daemon::emit(&mut inner, Event::ConfigChanged { config: cfg.clone() });
    }
    cfg
}

pub fn set(daemon: &Daemon, key: &str, value: &Value) -> Result<Config, RpcError> {
    {
        let _serialize_writers = daemon.lock();
        let path = &daemon.paths.config;
        let text = match std::fs::read_to_string(path) {
            Ok(text) => text,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => config::DEFAULT_CONFIG_TOML.to_string(),
            Err(e) => return Err(rpc_err(ErrorCode::Io, format!("{}: {e}", path.display()))),
        };
        let next = config::set_value(&text, key, value).map_err(|m| rpc_err(ErrorCode::BadRequest, m))?;
        write_in_place(path, &next).map_err(|e| rpc_err(ErrorCode::Io, format!("{}: {e}", path.display())))?;
    }
    Ok(reload(daemon))
}

/// Writes through a symlink to its target, so a config.toml kept in a dotfiles repo stays linked.
fn write_in_place(path: &Path, text: &str) -> std::io::Result<()> {
    let target = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    let tmp = target.with_extension("toml.tomo-tmp");
    std::fs::write(&tmp, text)?;
    std::fs::rename(&tmp, &target)
}

pub fn open(daemon: &Daemon) -> Result<(), RpcError> {
    let path = daemon.paths.config.clone();
    let editor = daemon.lock().config.editor_command.clone();
    if !path.exists() {
        let _ = config::load(&path);
    }
    let argv = editor_argv(&editor, &path);
    let spawn = |argv: &[String]| {
        argv.split_first()
            .map(|(program, args)| Command::new(program).args(args).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn().is_ok())
            .unwrap_or(false)
    };
    let fallback = ["open".to_string(), "-t".to_string(), path.to_string_lossy().into_owned()];
    if spawn(&argv) || spawn(&fallback) {
        Ok(())
    } else {
        Err(rpc_err(ErrorCode::Io, format!("could not open {}", path.display())))
    }
}

fn editor_argv(editor: &[String], path: &Path) -> Vec<String> {
    let p = path.to_string_lossy();
    let substituted: Vec<String> = editor.iter().map(|a| a.replace("{path}", &p)).collect();
    if editor.iter().any(|a| a.contains("{path}")) || editor.is_empty() {
        substituted
    } else {
        [substituted, vec![p.into_owned()]].concat()
    }
}

fn watched_dirs(config_path: &Path) -> Vec<PathBuf> {
    let real = std::fs::canonicalize(config_path).ok();
    [config_path.parent().map(Path::to_path_buf), real.as_deref().and_then(Path::parent).map(Path::to_path_buf)]
        .into_iter()
        .flatten()
        .fold(Vec::new(), |mut dirs, d| {
            if !dirs.contains(&d) {
                dirs.push(d);
            }
            dirs
        })
}

/// Reloads config.toml when the file changes on disk, so theme and font edits apply without a restart.
pub async fn watch(daemon: Arc<Daemon>) {
    let names: Vec<std::ffi::OsString> = [Some(daemon.paths.config.clone()), std::fs::canonicalize(&daemon.paths.config).ok()]
        .into_iter()
        .flatten()
        .filter_map(|p| p.file_name().map(|n| n.to_os_string()))
        .collect();
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<()>();
    let mut watcher = match notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        if res.map_or(false, |e| e.paths.iter().any(|p| p.file_name().map_or(false, |n| names.iter().any(|x| x == n)))) {
            let _ = tx.send(());
        }
    }) {
        Ok(w) => w,
        Err(e) => {
            tracing::warn!("config watcher unavailable: {e}");
            return;
        }
    };
    for dir in watched_dirs(&daemon.paths.config) {
        if let Err(e) = watcher.watch(&dir, RecursiveMode::NonRecursive) {
            tracing::warn!("config watcher: {}: {e}", dir.display());
        }
    }
    while rx.recv().await.is_some() {
        tokio::time::sleep(Duration::from_millis(250)).await;
        while rx.try_recv().is_ok() {}
        reload(&daemon);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn editor_argv_substitutes_or_appends_the_path() {
        let p = Path::new("/d/config.toml");
        assert_eq!(editor_argv(&["zed".into(), "{path}".into()], p), vec!["zed", "/d/config.toml"]);
        assert_eq!(editor_argv(&["code".into(), "-w".into()], p), vec!["code", "-w", "/d/config.toml"]);
        assert!(editor_argv(&[], p).is_empty());
    }
}
