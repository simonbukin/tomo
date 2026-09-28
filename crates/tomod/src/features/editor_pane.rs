//! Editor panes: a built-in pane kind that shows one text file of its worktree, with no PTY.
//!
//! The daemon owns the file access (`fs_read`, `fs_write`) and the watch of the open files.
//! The GUI owns the buffer. A write carries the version that the buffer was read at, and the
//! daemon refuses it when the file changed on disk since then.

use crate::daemon::{err, internal, ok, Daemon, Inner};
use crate::features::browser::surface_row;
use notify::{RecursiveMode, Watcher};
use serde_json::{json, Value};
use std::collections::{BTreeSet, HashMap, HashSet};
use std::hash::{Hash, Hasher};
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;
use tomo_proto::{EditorTarget, ErrorCode, Event, FileText, FileWritten, Id, PaneKind, RpcError, SplitDirection};

pub const MAX_BYTES: u64 = 2 * 1024 * 1024;

/// The real path of `path` inside `root`, and that path relative to the real root.
/// A missing file is fine when its directory exists. A `..` component, or a symlink
/// that leads out of the worktree, is refused.
pub fn resolve(root: &Path, path: &str) -> Result<(PathBuf, String), RpcError> {
    let outside = || err(ErrorCode::BadRequest, format!("{path} is outside the worktree"));
    let root = root.canonicalize().map_err(|e| err(ErrorCode::NotFound, format!("worktree folder: {e}")))?;
    let given = Path::new(path);
    if path.trim().is_empty() || given.components().any(|c| c == Component::ParentDir) {
        return Err(outside());
    }
    let joined = if given.is_absolute() { given.to_path_buf() } else { root.join(given) };
    let real = match joined.canonicalize() {
        Ok(real) => real,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            let (Some(dir), Some(name)) = (joined.parent(), joined.file_name()) else { return Err(outside()) };
            dir.canonicalize().map_err(|_| err(ErrorCode::NotFound, format!("no folder for {path}")))?.join(name)
        }
        Err(e) => return Err(err(ErrorCode::Io, format!("{path}: {e}"))),
    };
    let rel = real.strip_prefix(&root).map_err(|_| outside())?.to_string_lossy().into_owned();
    if rel.is_empty() {
        return Err(err(ErrorCode::BadRequest, format!("{path} is a folder")));
    }
    Ok((real, rel))
}

/// Changes when the bytes change, and only then: a `touch` or an identical rewrite is not a conflict.
pub fn version_of(bytes: &[u8]) -> String {
    let mut h = std::hash::DefaultHasher::new();
    bytes.hash(&mut h);
    format!("{:x}-{:016x}", bytes.len(), h.finish())
}

fn mtime_ms(path: &Path) -> u64 {
    std::fs::metadata(path).and_then(|m| m.modified()).ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map_or(0, |d| d.as_millis() as u64)
}

fn too_big(rel: &str, size: u64) -> RpcError {
    err(ErrorCode::Unsupported, format!("{rel} is {:.1} MB; the editor opens files up to {} MB", size as f64 / 1048576.0, MAX_BYTES / 1048576))
}

fn text_of(rel: &str, bytes: Vec<u8>) -> Result<String, RpcError> {
    let binary = || err(ErrorCode::Unsupported, format!("{rel} is a binary file; the editor opens UTF-8 text only"));
    if bytes.contains(&0) {
        return Err(binary());
    }
    String::from_utf8(bytes).map_err(|_| binary())
}

pub fn read_text(real: &Path, rel: &str) -> Result<FileText, RpcError> {
    let meta = std::fs::metadata(real).map_err(|e| match e.kind() {
        std::io::ErrorKind::NotFound => err(ErrorCode::NotFound, format!("{rel} does not exist")),
        _ => err(ErrorCode::Io, format!("{rel}: {e}")),
    })?;
    if meta.is_dir() {
        return Err(err(ErrorCode::BadRequest, format!("{rel} is a folder")));
    }
    if meta.len() > MAX_BYTES {
        return Err(too_big(rel, meta.len()));
    }
    let bytes = std::fs::read(real).map_err(|e| err(ErrorCode::Io, format!("{rel}: {e}")))?;
    if bytes.len() as u64 > MAX_BYTES {
        return Err(too_big(rel, bytes.len() as u64));
    }
    let version = version_of(&bytes);
    Ok(FileText { path: rel.to_string(), content: text_of(rel, bytes)?, version, mtime_ms: mtime_ms(real) })
}

fn check_version(real: &Path, rel: &str, expected: Option<&str>) -> Result<(), RpcError> {
    let current = match std::fs::read(real) {
        Ok(bytes) => Some(version_of(&bytes)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => return Err(err(ErrorCode::Io, format!("{rel}: {e}"))),
    };
    if current.as_deref() == expected {
        return Ok(());
    }
    let why = match (&current, expected) {
        (None, _) => "was deleted",
        (Some(_), None) => "already exists",
        _ => "changed",
    };
    Err(err(ErrorCode::Conflict, format!("{rel} {why} on disk since it was read")))
}

/// Replaces the file through a temporary file in the same folder and a rename, so a reader
/// never sees half a file. The file keeps its mode. `expected` is the version that the
/// writer read; `None` means that the file must not exist yet.
pub fn write_text(real: &Path, rel: &str, content: &str, expected: Option<&str>) -> Result<FileWritten, RpcError> {
    if content.len() as u64 > MAX_BYTES {
        return Err(too_big(rel, content.len() as u64));
    }
    check_version(real, rel, expected)?;
    let io = |e: std::io::Error| err(ErrorCode::Io, format!("{rel}: {e}"));
    let dir = real.parent().ok_or_else(|| err(ErrorCode::BadRequest, format!("{rel} has no folder")))?;
    let name = real.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.subsec_nanos());
    let tmp = dir.join(format!(".{name}.tomo-{}-{nanos}.tmp", std::process::id()));
    let mode = std::fs::metadata(real).ok().map(|m| m.permissions());
    let written = (|| {
        let mut f = std::fs::OpenOptions::new().write(true).create_new(true).open(&tmp)?;
        f.write_all(content.as_bytes())?;
        f.sync_all()?;
        if let Some(mode) = mode {
            std::fs::set_permissions(&tmp, mode)?;
        }
        Ok(())
    })()
    .map_err(io)
    // The fsync above takes milliseconds; a second check narrows the window for a write by an agent to the rename itself.
    .and_then(|()| check_version(real, rel, expected))
    .and_then(|()| std::fs::rename(&tmp, real).map_err(io));
    if let Err(e) = written {
        let _ = std::fs::remove_file(&tmp);
        return Err(e);
    }
    Ok(FileWritten { version: version_of(content.as_bytes()), mtime_ms: mtime_ms(real) })
}

impl Daemon {
    fn worktree_root(&self, worktree_id: &str) -> Result<PathBuf, RpcError> {
        Ok(self.lock().worktrees.get(worktree_id).ok_or_else(|| err(ErrorCode::NotFound, "worktree not found"))?.path.clone())
    }

    pub(crate) fn editor_open(
        self: &Arc<Self>,
        worktree_id: Id,
        path: String,
        line: Option<u32>,
        col: Option<u32>,
        tab_id: Option<Id>,
    ) -> Result<Value, RpcError> {
        let root = self.worktree_root(&worktree_id)?;
        let (real, rel) = resolve(&root, &path)?;
        if real.is_dir() {
            return Err(err(ErrorCode::BadRequest, format!("{rel} is a folder")));
        }
        let title = rel.rsplit('/').next().unwrap_or(&rel).to_string();
        let target = EditorTarget { path: rel, line: line.unwrap_or(1).max(1), col: col.unwrap_or(1).max(1) };
        let mut inner = self.lock();
        let tab_id = Self::surface_tab(&mut inner, &worktree_id, tab_id, &title)?;
        let row = surface_row(&tab_id, &worktree_id, root, PaneKind::Editor, None, Some(target));
        let pane_id = Self::insert_surface_pane(&mut inner, row).map_err(internal)?;
        Self::place_pane(&mut inner, &tab_id, &pane_id, None, SplitDirection::Horizontal);
        Self::touch(&mut inner, &worktree_id);
        Self::emit_tabs(&mut inner, &worktree_id);
        Self::emit_pane(&mut inner, &pane_id);
        self.editors_changed.notify_one();
        ok(json!({ "pane": Self::pane_view(&inner, &pane_id), "tab": Self::tab_view(&inner, &inner.tabs[&tab_id]) }))
    }

    pub(crate) fn editor_cursor(self: &Arc<Self>, pane_id: Id, line: u32, col: u32) -> Result<Value, RpcError> {
        let mut inner = self.lock();
        let pane = inner.panes.get_mut(&pane_id).ok_or_else(|| err(ErrorCode::NotFound, "pane not found"))?;
        let Some(target) = pane.row.editor.as_mut() else { return Err(err(ErrorCode::BadRequest, "pane is not an editor")) };
        target.line = line.max(1);
        target.col = col.max(1);
        let row = pane.row.clone();
        inner.store.pane_upsert(&row).map_err(internal)?;
        Ok(Value::Null)
    }

    pub(crate) async fn fs_read(self: &Arc<Self>, worktree_id: Id, path: String) -> Result<Value, RpcError> {
        let root = self.worktree_root(&worktree_id)?;
        let text = tokio::task::spawn_blocking(move || resolve(&root, &path).and_then(|(real, rel)| read_text(&real, &rel)))
            .await
            .map_err(|e| err(ErrorCode::Internal, e.to_string()))??;
        ok(text)
    }

    pub(crate) async fn fs_write(self: &Arc<Self>, worktree_id: Id, path: String, content: String, expected: Option<String>) -> Result<Value, RpcError> {
        let root = self.worktree_root(&worktree_id)?;
        let written = tokio::task::spawn_blocking(move || resolve(&root, &path).and_then(|(real, rel)| write_text(&real, &rel, &content, expected.as_deref())))
            .await
            .map_err(|e| err(ErrorCode::Internal, e.to_string()))??;
        ok(written)
    }
}

/// The worktree root, worktree id, and stored path of each file that an editor pane shows.
fn editor_files(inner: &Inner) -> Vec<(PathBuf, Id, String)> {
    inner
        .panes
        .values()
        .filter_map(|p| {
            let target = p.row.editor.as_ref()?;
            let root = inner.worktrees.get(&p.row.worktree_id)?.path.clone();
            Some((root, p.row.worktree_id.clone(), target.path.clone()))
        })
        .collect()
}

/// The real path of each open file. It reads the disk, so it runs outside the daemon lock.
fn open_files(files: Vec<(PathBuf, Id, String)>) -> HashMap<PathBuf, (Id, String)> {
    files.into_iter().filter_map(|(root, worktree_id, path)| Some((resolve(&root, &path).ok()?.0, (worktree_id, path)))).collect()
}

/// Watches the folder of each open file and emits `file_changed` for the open files that change.
/// A folder watch, not a file watch, because an agent often writes a new file and renames it over the old one.
pub async fn watch(daemon: Arc<Daemon>) {
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<PathBuf>();
    let mut watcher = match notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        res.into_iter().flat_map(|e| e.paths).for_each(|p| {
            let _ = tx.send(p);
        })
    }) {
        Ok(w) => w,
        Err(e) => {
            tracing::warn!("editor file watcher unavailable: {e}");
            return;
        }
    };
    let mut watched: HashSet<PathBuf> = HashSet::new();
    loop {
        let files = editor_files(&daemon.lock());
        let open = open_files(files);
        let dirs: HashSet<PathBuf> = open.keys().filter_map(|p| p.parent().map(Path::to_path_buf)).collect();
        watched.difference(&dirs).for_each(|d| {
            let _ = watcher.unwatch(d);
        });
        watched = dirs.into_iter().filter(|d| watched.contains(d) || watcher.watch(d, RecursiveMode::NonRecursive).is_ok()).collect();
        tokio::select! {
            _ = daemon.editors_changed.notified() => {}
            _ = tokio::time::sleep(Duration::from_secs(10)) => {}
            Some(first) = rx.recv() => {
                tokio::time::sleep(Duration::from_millis(40)).await;
                let paths: Vec<PathBuf> = std::iter::once(first).chain(std::iter::from_fn(|| rx.try_recv().ok())).collect();
                let changed: BTreeSet<&(Id, String)> = paths.iter().filter_map(|p| open.get(p)).collect();
                let mut inner = daemon.lock();
                for (worktree_id, path) in changed {
                    Daemon::emit(&mut inner, Event::FileChanged { worktree_id: worktree_id.clone(), path: path.clone() });
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Tree(PathBuf);
    impl Drop for Tree {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn tree(name: &str) -> Tree {
        let dir = std::env::temp_dir().join(format!("tomo-editor-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("wt/src")).unwrap();
        std::fs::create_dir_all(dir.join("outside")).unwrap();
        std::fs::write(dir.join("wt/src/a.rs"), "fn main() {}\n").unwrap();
        std::fs::write(dir.join("outside/secret"), "no").unwrap();
        Tree(dir)
    }

    fn code(r: Result<impl std::fmt::Debug, RpcError>) -> ErrorCode {
        r.unwrap_err().code
    }

    #[test]
    fn paths_stay_inside_the_worktree() {
        let t = tree("contain");
        let wt = t.0.join("wt");
        assert_eq!(resolve(&wt, "src/a.rs").unwrap().1, "src/a.rs");
        assert_eq!(resolve(&wt, &wt.join("src/a.rs").to_string_lossy()).unwrap().1, "src/a.rs");
        assert_eq!(resolve(&wt, "src/new.rs").unwrap().1, "src/new.rs");
        assert_eq!(code(resolve(&wt, "../outside/secret")), ErrorCode::BadRequest);
        assert_eq!(code(resolve(&wt, "src/../../outside/secret")), ErrorCode::BadRequest);
        assert_eq!(code(resolve(&wt, &t.0.join("outside/secret").to_string_lossy())), ErrorCode::BadRequest);
        assert_eq!(code(resolve(&wt, "")), ErrorCode::BadRequest);
        assert_eq!(resolve(&wt, "src/a.rs ").unwrap().1, "src/a.rs ");
        std::os::unix::fs::symlink(t.0.join("outside/secret"), wt.join("link")).unwrap();
        std::os::unix::fs::symlink(t.0.join("outside"), wt.join("dirlink")).unwrap();
        assert_eq!(code(resolve(&wt, "link")), ErrorCode::BadRequest);
        assert_eq!(code(resolve(&wt, "dirlink/secret")), ErrorCode::BadRequest);
        assert_eq!(code(resolve(&wt, "dirlink/new")), ErrorCode::BadRequest);
        std::os::unix::fs::symlink(wt.join("src/a.rs"), wt.join("inner")).unwrap();
        assert_eq!(resolve(&wt, "inner").unwrap().1, "src/a.rs");
    }

    #[test]
    fn binary_and_big_files_are_refused() {
        let t = tree("binary");
        let wt = t.0.join("wt");
        std::fs::write(wt.join("nul"), b"text\0more").unwrap();
        std::fs::write(wt.join("latin1"), [0x66, 0xe9, 0x65]).unwrap();
        std::fs::write(wt.join("big"), vec![b'a'; MAX_BYTES as usize + 1]).unwrap();
        let read = |name: &str| read_text(&wt.join(name), name);
        assert!(read("nul").unwrap_err().message.contains("binary"));
        assert!(read("latin1").unwrap_err().message.contains("binary"));
        assert_eq!(code(read("big")), ErrorCode::Unsupported);
        assert_eq!(code(read("missing")), ErrorCode::NotFound);
        assert_eq!(code(read("src")), ErrorCode::BadRequest);
        assert_eq!(read("src/a.rs").unwrap().content, "fn main() {}\n");
    }

    #[test]
    fn a_write_refuses_a_file_that_changed_since_the_read() {
        let t = tree("conflict");
        let file = t.0.join("wt/src/a.rs");
        let first = read_text(&file, "a").unwrap();
        std::fs::write(&file, "fn main() { agent(); }\n").unwrap();
        assert_eq!(code(write_text(&file, "a", "mine", Some(&first.version))), ErrorCode::Conflict);
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "fn main() { agent(); }\n");
        let now = read_text(&file, "a").unwrap();
        let saved = write_text(&file, "a", "mine\n", Some(&now.version)).unwrap();
        assert_eq!(saved.version, read_text(&file, "a").unwrap().version);
        assert_eq!(code(write_text(&file, "a", "x", None)), ErrorCode::Conflict);
        std::fs::remove_file(&file).unwrap();
        assert!(write_text(&file, "a", "x", Some(&saved.version)).unwrap_err().message.contains("deleted"));
        write_text(&file, "a", "again\n", None).unwrap();
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "again\n");
    }

    #[test]
    fn an_identical_rewrite_keeps_the_version() {
        let t = tree("touch");
        let file = t.0.join("wt/src/a.rs");
        let before = read_text(&file, "a").unwrap().version;
        std::fs::write(&file, "fn main() {}\n").unwrap();
        assert_eq!(read_text(&file, "a").unwrap().version, before);
    }

    #[test]
    fn a_write_is_atomic_and_keeps_the_mode() {
        use std::os::unix::fs::PermissionsExt;
        let t = tree("atomic");
        let file = t.0.join("wt/run.sh");
        std::fs::write(&file, "#!/bin/sh\n").unwrap();
        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o751)).unwrap();
        let v = read_text(&file, "run.sh").unwrap().version;
        let reader = {
            let file = file.clone();
            std::thread::spawn(move || {
                (0..2000).all(|_| std::fs::read_to_string(&file).map_or(true, |s| s == "#!/bin/sh\n" || s.len() == 64 * 1024))
            })
        };
        write_text(&file, "run.sh", &"x".repeat(64 * 1024), Some(&v)).unwrap();
        assert!(reader.join().unwrap(), "a reader saw a partial file");
        assert_eq!(std::fs::metadata(&file).unwrap().permissions().mode() & 0o777, 0o751);
        let leftovers: Vec<_> = std::fs::read_dir(t.0.join("wt")).unwrap().filter_map(|e| e.ok()).filter(|e| e.file_name().to_string_lossy().ends_with(".tmp")).collect();
        assert!(leftovers.is_empty());
    }
}
