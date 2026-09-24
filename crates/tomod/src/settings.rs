use crate::config;
use crate::daemon::Daemon;
use notify::{RecursiveMode, Watcher};
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Arc;
use std::time::Duration;
use tomo_proto::{Config, ConfigIssue, DiagnosticLevel, ErrorCode, Event, IssueLevel, NoticeLevel, RpcError};

fn rpc_err(code: ErrorCode, message: impl Into<String>) -> RpcError {
    RpcError { code, message: message.into() }
}

/// The first issue plus a count, or `None` when the config has no issues.
pub fn issues_summary(issues: &[ConfigIssue]) -> Option<String> {
    let first = issues.first()?;
    let more = if issues.len() > 1 { format!(" (+{} more)", issues.len() - 1) } else { String::new() };
    Some(format!("{}: {}{more}", first.key, first.message))
}

/// Loads config.toml into the daemon and pushes `config_changed` when the result differs.
/// A reload and each change in the config problems are diagnostics. A new error is also a notice.
pub fn reload(daemon: &Daemon) -> Config {
    let loaded = config::load_checked(&daemon.paths.config).map(|(cfg, parse_issues)| {
        let issues = [parse_issues, config::check(&cfg, &daemon.seams.hook_events)].concat();
        let integrations = crate::providers::status(&cfg);
        (cfg, issues, integrations)
    });
    let mut inner = daemon.lock();
    let (cfg, issues, integrations) = match loaded {
        Ok(loaded) => loaded,
        Err(e) => {
            Daemon::diagnostic_on_change(&mut inner, "config", "config", Some(e.to_string()));
            return inner.config.clone();
        }
    };
    if serde_json::to_value(&inner.config).ok() != serde_json::to_value(&cfg).ok() {
        inner.config = cfg.clone();
        Daemon::diagnostic(&mut inner, DiagnosticLevel::Info, "config", "config reloaded");
        Daemon::emit(&mut inner, Event::ConfigChanged { config: cfg.clone() });
        let repos = Daemon::repo_views(&inner);
        Daemon::emit(&mut inner, Event::ReposChanged { repos });
    }
    let summary = issues_summary(&issues);
    if Daemon::diagnostic_on_change(&mut inner, "config", "config", summary.clone()) && issues.iter().any(|i| i.level == IssueLevel::Error) {
        Daemon::emit(&mut inner, Event::Notice { level: NoticeLevel::Warning, message: format!("config problem: {}", summary.unwrap_or_default()) });
    }
    crate::providers::record_health(&mut inner, &integrations);
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
    [config_path.parent().map(Path::to_path_buf), real.as_deref().and_then(Path::parent).map(Path::to_path_buf)].into_iter().flatten().fold(
        Vec::new(),
        |mut dirs, d| {
            if !dirs.contains(&d) {
                dirs.push(d);
            }
            dirs
        },
    )
}

/// Reloads config.toml when the file changes on disk, so theme and font edits apply without a restart.
pub async fn watch(daemon: Arc<Daemon>) {
    reload(&daemon);
    let names: Vec<std::ffi::OsString> = [Some(daemon.paths.config.clone()), std::fs::canonicalize(&daemon.paths.config).ok()]
        .into_iter()
        .flatten()
        .filter_map(|p| p.file_name().map(|n| n.to_os_string()))
        .collect();
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<()>();
    let mut watcher = match notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        if res.is_ok_and(|e| e.paths.iter().any(|p| p.file_name().is_some_and(|n| names.iter().any(|x| x == n)))) {
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
    fn issues_summary_names_the_first_issue_and_counts_the_rest() {
        let issue = |key: &str| ConfigIssue { level: IssueLevel::Error, key: key.into(), message: "bad".into() };
        assert_eq!(issues_summary(&[]), None);
        assert_eq!(issues_summary(&[issue("theme")]).as_deref(), Some("theme: bad"));
        assert_eq!(issues_summary(&[issue("theme"), issue("shell"), issue("states")]).as_deref(), Some("theme: bad (+2 more)"));
    }

    #[test]
    fn editor_argv_substitutes_or_appends_the_path() {
        let p = Path::new("/d/config.toml");
        assert_eq!(editor_argv(&["zed".into(), "{path}".into()], p), vec!["zed", "/d/config.toml"]);
        assert_eq!(editor_argv(&["code".into(), "-w".into()], p), vec!["code", "-w", "/d/config.toml"]);
        assert!(editor_argv(&[], p).is_empty());
    }
}
