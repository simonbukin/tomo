//! Opens a file location from terminal output in the configured editor.

use std::path::Path;
use std::process::{Command, Stdio};

/// Fills `editor_command` for one location. With a `{line}` placeholder the
/// command places the numbers itself; otherwise `{path}` becomes `path:line:col`,
/// the form that Zed and Sublime Text read. A command without `{path}` gets
/// the target appended.
pub fn location_argv(editor: &[String], path: &Path, line: Option<u32>, col: Option<u32>) -> Vec<String> {
    let path = path.to_string_lossy();
    let explicit = editor.iter().any(|a| a.contains("{line}"));
    let target = match (explicit, line, col) {
        (false, Some(l), Some(c)) => format!("{path}:{l}:{c}"),
        (false, Some(l), None) => format!("{path}:{l}"),
        _ => path.to_string(),
    };
    let (line, col) = (line.unwrap_or(1).to_string(), col.unwrap_or(1).to_string());
    let filled = editor.iter().map(|a| a.replace("{path}", &target).replace("{line}", &line).replace("{col}", &col));
    if editor.iter().any(|a| a.contains("{path}")) {
        filled.collect()
    } else {
        filled.chain(std::iter::once(target.clone())).collect()
    }
}

fn spawn_detached(argv: &[String], cwd: &Path) -> std::io::Result<()> {
    let (program, args) = argv.split_first().ok_or_else(|| std::io::Error::new(std::io::ErrorKind::InvalidInput, "editor_command is empty"))?;
    let mut cmd = Command::new(program);
    cmd.args(args).current_dir(cwd).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    let mut child = cmd.spawn()?;
    std::thread::spawn(move || child.wait());
    Ok(())
}

/// Starts the editor and does not wait for it. When the editor cannot start,
/// opens the file with the default app and returns a warning for the user.
pub fn open_location(editor: &[String], path: &Path, line: Option<u32>, col: Option<u32>) -> Option<String> {
    let cwd = if path.is_dir() { path } else { path.parent().unwrap_or(path) };
    let argv = location_argv(editor, path, line, col);
    match spawn_detached(&argv, cwd) {
        Ok(()) => None,
        Err(e) => {
            let _ = spawn_detached(&["open".to_string(), path.to_string_lossy().into_owned()], cwd);
            Some(format!("{} did not start ({e}); opened with the default app instead", argv.first().map(String::as_str).unwrap_or("editor")))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn argv(editor: &[&str], line: Option<u32>, col: Option<u32>) -> Vec<String> {
        let editor: Vec<String> = editor.iter().map(|s| s.to_string()).collect();
        location_argv(&editor, Path::new("/w/src/a.rs"), line, col)
    }

    #[test]
    fn path_placeholder_takes_line_and_column() {
        assert_eq!(argv(&["zed", "{path}"], Some(12), Some(3)), ["zed", "/w/src/a.rs:12:3"]);
        assert_eq!(argv(&["zed", "{path}"], Some(12), None), ["zed", "/w/src/a.rs:12"]);
        assert_eq!(argv(&["zed", "{path}"], None, None), ["zed", "/w/src/a.rs"]);
        assert_eq!(argv(&["subl"], Some(4), None), ["subl", "/w/src/a.rs:4"]);
    }

    #[test]
    fn explicit_line_placeholders_keep_the_path_plain() {
        assert_eq!(argv(&["code", "-g", "{path}:{line}:{col}"], Some(7), None), ["code", "-g", "/w/src/a.rs:7:1"]);
        assert_eq!(argv(&["vim", "+{line}", "{path}"], Some(9), Some(2)), ["vim", "+9", "/w/src/a.rs"]);
    }

    #[test]
    fn a_fake_editor_receives_the_location_without_blocking() {
        let dir = std::env::temp_dir().join(format!("tomo-qol-os-editor-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let out = dir.join("args.txt");
        let script = dir.join("fake-editor");
        std::fs::write(&script, format!("#!/bin/sh\nprintf '%s\\n' \"$@\" > '{}.tmp' && mv '{0}.tmp' '{0}'\n", out.display())).unwrap();
        std::fs::set_permissions(&script, std::os::unix::fs::PermissionsExt::from_mode(0o755)).unwrap();
        let file = dir.join("main.rs");
        std::fs::write(&file, "fn main() {}\n").unwrap();
        let warning = open_location(&[script.to_string_lossy().into_owned(), "{path}".into()], &file, Some(12), Some(3));
        assert_eq!(warning, None);
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while !out.exists() && std::time::Instant::now() < deadline {
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        assert_eq!(std::fs::read_to_string(&out).unwrap(), format!("{}:12:3\n", file.display()));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_missing_or_empty_editor_cannot_start() {
        assert!(spawn_detached(&["/nonexistent/tomo-no-editor".to_string()], Path::new("/tmp")).is_err());
        assert!(spawn_detached(&[], Path::new("/tmp")).is_err());
    }
}
