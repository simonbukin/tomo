use std::collections::HashSet;
use std::io::{ErrorKind, Read};
use std::os::unix::io::AsRawFd;
use std::os::unix::process::CommandExt;
use std::process::{Child, ChildStdout, Command, Stdio};
use std::time::{Duration, Instant};

const MARK: &str = "__TOMO_PATH__";
const LOGIN_SHELL_TIMEOUT: Duration = Duration::from_secs(2);
const POLL: Duration = Duration::from_millis(20);

pub fn between_marks(output: &str) -> Option<&str> {
    let (_, rest) = output.split_once(MARK)?;
    rest.split_once(MARK).map(|(path, _)| path)
}

pub fn merge_paths(login: &str, current: &str) -> String {
    let mut seen = HashSet::new();
    login.split(':').chain(current.split(':')).filter(|dir| !dir.is_empty() && seen.insert(*dir)).collect::<Vec<_>>().join(":")
}

fn lacks_tool_dirs(path: &str, home: &str) -> bool {
    let has = |dir: &str| path.split(':').any(|entry| entry == dir);
    let no_package_manager = !has("/opt/homebrew/bin") && !has("/usr/local/bin");
    no_package_manager || !has(&format!("{home}/.local/bin"))
}

fn drain(stdout: &mut ChildStdout, output: &mut Vec<u8>) -> bool {
    let mut chunk = [0u8; 4096];
    loop {
        match stdout.read(&mut chunk) {
            Ok(0) => return false,
            Ok(n) => output.extend_from_slice(&chunk[..n]),
            Err(e) if e.kind() == ErrorKind::WouldBlock => return true,
            Err(e) if e.kind() == ErrorKind::Interrupted => continue,
            Err(_) => return false,
        }
    }
}

fn read_marked(child: &mut Child, stdout: &mut ChildStdout) -> Option<String> {
    let deadline = Instant::now() + LOGIN_SHELL_TIMEOUT;
    let mut output = Vec::new();
    loop {
        let exited = !matches!(child.try_wait(), Ok(None));
        let open = drain(stdout, &mut output);
        if let Some(path) = between_marks(&String::from_utf8_lossy(&output)) {
            return Some(path.to_string());
        }
        if exited || !open || Instant::now() >= deadline {
            return None;
        }
        std::thread::sleep(POLL);
    }
}

pub fn login_path(shell: &str) -> Option<String> {
    let mut command = Command::new(shell);
    command.args(["-l", "-i", "-c", &format!(r#"printf "{MARK}%s{MARK}" "$PATH""#)]).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null());
    // An interactive shell that shares a terminal with a background daemon stops on SIGTTOU; a new session has no terminal.
    unsafe {
        command.pre_exec(|| {
            libc::setsid();
            Ok(())
        });
    }
    let mut child = command.spawn().ok()?;
    let mut stdout = child.stdout.take()?;
    let fd = stdout.as_raw_fd();
    unsafe { libc::fcntl(fd, libc::F_SETFL, libc::fcntl(fd, libc::F_GETFL) | libc::O_NONBLOCK) };
    let path = read_marked(&mut child, &mut stdout);
    // rc files can start helpers in the shell's process group that outlive it; the group dies with the shell.
    unsafe { libc::killpg(child.id() as libc::pid_t, libc::SIGKILL) };
    let _ = child.wait();
    path.filter(|p| !p.is_empty())
}

/// Adopts the login shell PATH when the daemon started with a bare one, as launchd gives a GUI app.
/// Call it before any thread exists: it changes the process environment.
pub fn apply() {
    let current = std::env::var("PATH").unwrap_or_default();
    let home = std::env::var("HOME").unwrap_or_default();
    if !lacks_tool_dirs(&current, &home) {
        return;
    }
    let shell = std::env::var("SHELL").ok().filter(|s| !s.is_empty()).unwrap_or_else(|| "/bin/zsh".to_string());
    match login_path(&shell) {
        Some(login) => {
            let merged = merge_paths(&login, &current);
            tracing::info!("adopted the login PATH from {shell}: {} bytes, {} entries", merged.len(), merged.split(':').count());
            std::env::set_var("PATH", merged);
        }
        None => tracing::warn!("could not read the login PATH from {shell}; keeping {current}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn marks_cut_the_path_out_of_shell_noise() {
        assert_eq!(between_marks("motd\n__TOMO_PATH__/a:/b__TOMO_PATH__\x1b]7;x\x07"), Some("/a:/b"));
        assert_eq!(between_marks("__TOMO_PATH____TOMO_PATH__"), Some(""));
        assert_eq!(between_marks("__TOMO_PATH__/a:/b"), None);
        assert_eq!(between_marks("no marks"), None);
    }

    #[test]
    fn merge_puts_login_first_without_duplicates_or_empties() {
        assert_eq!(merge_paths("/h/.local/bin::/opt/homebrew/bin:/usr/bin", "/usr/bin:/bin::/h/.local/bin"), "/h/.local/bin:/opt/homebrew/bin:/usr/bin:/bin");
        assert_eq!(merge_paths("", "/usr/bin:/bin"), "/usr/bin:/bin");
        assert_eq!(merge_paths("/a", ""), "/a");
    }

    #[test]
    fn only_a_bare_path_needs_the_login_shell() {
        assert!(lacks_tool_dirs("/usr/bin:/bin:/usr/sbin:/sbin", "/h"));
        assert!(lacks_tool_dirs("/opt/homebrew/bin:/usr/bin", "/h"));
        assert!(lacks_tool_dirs("/h/.local/bin:/usr/bin", "/h"));
        assert!(!lacks_tool_dirs("/h/.local/bin:/usr/local/bin:/usr/bin", "/h"));
        assert!(!lacks_tool_dirs("/opt/homebrew/bin:/h/.local/bin", "/h"));
    }

    #[test]
    fn login_path_reads_through_a_real_shell() {
        assert!(login_path("/bin/sh").is_some_and(|p| p.contains("/usr/bin")));
        assert_eq!(login_path("/nonexistent/shell"), None);
    }
}
