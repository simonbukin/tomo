mod browser;

use browser::browser_webview;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tauri::webview::WebviewBuilder;
use tauri::{AppHandle, Emitter, LogicalPosition, Manager, State, Webview};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::UnixStream;
use tokio::sync::{mpsc, oneshot};
use tomo_proto::*;

static STARTED: std::sync::OnceLock<std::time::Instant> = std::sync::OnceLock::new();

fn mark(what: &str) {
    if std::env::var_os("TOMO_TIMING").is_some() {
        eprintln!("[tomo-app] {what} at {} ms", STARTED.get_or_init(std::time::Instant::now).elapsed().as_millis());
    }
}

pub struct Link {
    tx: Mutex<Option<mpsc::UnboundedSender<String>>>,
    pending: Arc<Mutex<HashMap<u64, oneshot::Sender<Result<Value, RpcError>>>>>,
    next_id: AtomicU64,
}

fn data_dir() -> PathBuf {
    std::env::var("TOMO_DATA_DIR").map(PathBuf::from).unwrap_or_else(|_| dirs::data_dir().unwrap_or_else(|| PathBuf::from(".")).join("tomo"))
}

fn socket_path() -> PathBuf {
    std::env::var("TOMO_SOCKET").map(PathBuf::from).unwrap_or_else(|_| data_dir().join("tomod.sock"))
}

fn daemon_binary() -> PathBuf {
    if let Ok(p) = std::env::var("TOMO_DAEMON_BIN") {
        return PathBuf::from(p);
    }
    if let Ok(exe) = std::env::current_exe() {
        let sibling = exe.with_file_name("tomod");
        if sibling.exists() {
            return sibling;
        }
    }
    let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../target/debug/tomod");
    if dev.exists() {
        return dev;
    }
    PathBuf::from("tomod")
}

fn start_daemon() {
    let _ = std::fs::create_dir_all(data_dir());
    let log = std::fs::OpenOptions::new().create(true).append(true).open(data_dir().join("tomod.log"));
    let stderr = log.map(std::process::Stdio::from).unwrap_or_else(|_| std::process::Stdio::null());
    let mut cmd = std::process::Command::new(daemon_binary());
    cmd.stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(stderr);
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    if let Ok(exe) = std::env::current_exe() {
        let tomo = exe.with_file_name("tomo");
        if tomo.exists() {
            cmd.env("TOMO_BIN", tomo);
        } else {
            let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../target/debug/tomo");
            if dev.exists() {
                cmd.env("TOMO_BIN", dev);
            }
        }
    }
    let _ = cmd.spawn();
}

async fn connect_once(app: &AppHandle, link: &Link) -> Option<()> {
    let stream = UnixStream::connect(socket_path()).await.ok()?;
    let (rd, mut wr) = stream.into_split();
    let (tx, mut rx) = mpsc::unbounded_channel::<String>();
    let hello = json!({ "id": 0, "method": "hello", "params": { "protocol": PROTOCOL_VERSION, "client": format!("tomo-app/{}", env!("CARGO_PKG_VERSION")) } });
    let _ = tx.send(hello.to_string());
    *link.tx.lock().unwrap() = Some(tx);
    let writer = tokio::spawn(async move {
        while let Some(line) = rx.recv().await {
            if wr.write_all(line.as_bytes()).await.is_err() || wr.write_all(b"\n").await.is_err() {
                break;
            }
        }
    });
    mark("daemon connected");
    let _ = app.emit("daemon-state", json!({ "connected": true }));
    let mut lines = BufReader::with_capacity(1024 * 1024, rd).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        match serde_json::from_str::<Frame>(&line) {
            Ok(Frame::Response { id, result }) => {
                if let Some(tx) = link.pending.lock().unwrap().remove(&id) {
                    let _ = tx.send(Ok(result));
                }
            }
            Ok(Frame::Error { id: 0, error }) if error.code == ErrorCode::Unsupported => {
                eprintln!("[tomo-app] daemon speaks another protocol; asking it to stop: {}", error.message);
                if let Some(tx) = link.tx.lock().unwrap().as_ref() {
                    let _ = tx.send(json!({ "id": 0, "method": "daemon_stop" }).to_string());
                }
                tokio::time::sleep(std::time::Duration::from_millis(800)).await;
                break;
            }
            Ok(Frame::Error { id, error }) => {
                if let Some(tx) = link.pending.lock().unwrap().remove(&id) {
                    let _ = tx.send(Err(error));
                }
            }
            Ok(Frame::Event { .. }) => {
                let _ = app.emit("daemon-event", line);
            }
            Err(_) => {}
        }
    }
    writer.abort();
    *link.tx.lock().unwrap() = None;
    for (_, tx) in link.pending.lock().unwrap().drain() {
        let _ = tx.send(Err(RpcError { code: ErrorCode::Io, message: "daemon disconnected".into() }));
    }
    let _ = app.emit("daemon-state", json!({ "connected": false }));
    Some(())
}

async fn connect_loop(app: AppHandle) {
    let link = app.state::<Arc<Link>>().inner().clone();
    let mut attempts = 0u32;
    loop {
        match connect_once(&app, &link).await {
            Some(()) => attempts = 0,
            None => {
                if attempts == 0 || attempts % 80 == 0 {
                    start_daemon();
                }
                attempts += 1;
            }
        }
        let wait = if attempts == 0 { 300 } else if attempts < 80 { 25 } else { 250 };
        tokio::time::sleep(std::time::Duration::from_millis(wait)).await;
    }
}

#[tauri::command]
async fn rpc(link: State<'_, Arc<Link>>, method: String, params: Option<Value>) -> Result<Value, RpcError> {
    let id = link.next_id.fetch_add(1, Ordering::Relaxed);
    if id == 1 {
        mark(&format!("first rpc ({method})"));
    }
    let mut req = json!({ "id": id, "method": method });
    if let Some(p) = params {
        req["params"] = p;
    }
    let (tx, rx) = oneshot::channel();
    link.pending.lock().unwrap().insert(id, tx);
    let sender = link.tx.lock().unwrap().clone();
    match sender {
        Some(s) => {
            if s.send(req.to_string()).is_err() {
                link.pending.lock().unwrap().remove(&id);
                return Err(RpcError { code: ErrorCode::Io, message: "daemon not connected".into() });
            }
        }
        None => {
            link.pending.lock().unwrap().remove(&id);
            return Err(RpcError { code: ErrorCode::Io, message: "daemon not connected".into() });
        }
    }
    rx.await.unwrap_or_else(|_| Err(RpcError { code: ErrorCode::Io, message: "daemon disconnected".into() }))
}

#[tauri::command]
fn daemon_connected(link: State<'_, Arc<Link>>) -> bool {
    link.tx.lock().unwrap().is_some()
}

const AGENTATION_JS: &str = include_str!("../agentation/agentation.js");

#[derive(Default)]
pub struct AnnotatePanes(Mutex<HashSet<String>>);

fn agentation_script(enabled: bool) -> String {
    format!("if(!window.__tomoAgentation){{{AGENTATION_JS}\n}}window.__tomoAgentation.set({enabled});")
}

#[tauri::command]
async fn browser_set_annotate(app: AppHandle, annotate: State<'_, AnnotatePanes>, pane_id: String, enabled: bool) -> Result<(), String> {
    {
        let mut panes = annotate.0.lock().unwrap();
        if enabled { panes.insert(pane_id.clone()) } else { panes.remove(&pane_id) };
    }
    let wv = browser_webview(&app, &pane_id)?;
    wv.eval(agentation_script(enabled)).map_err(|e| e.to_string())?;
    if enabled {
        wv.set_focus().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
async fn browser_clear_annotations(app: AppHandle, pane_id: String) -> Result<(), String> {
    browser_webview(&app, &pane_id)?.eval("window.__tomoAgentation && window.__tomoAgentation.clear()").map_err(|e| e.to_string())
}

fn feedback_pane<'a>(label: &'a str, kind: &str, annotating: impl Fn(&str) -> bool) -> Result<&'a str, String> {
    let pane_id = label.strip_prefix("browser-").ok_or("not a browser webview")?;
    match kind {
        "change" => Ok(pane_id),
        "copy" | "submit" if annotating(pane_id) => Ok(pane_id),
        "copy" | "submit" => Err("annotate is off for this pane".into()),
        _ => Err(format!("unknown feedback kind {kind}")),
    }
}

/// Called by the page inside a browser webview. The pane comes from the webview label, never from the page.
#[tauri::command]
fn browser_feedback(app: AppHandle, webview: Webview, annotate: State<'_, AnnotatePanes>, kind: String, count: u32, markdown: String) -> Result<(), String> {
    let pane_id = feedback_pane(webview.label(), &kind, |p| annotate.0.lock().unwrap().contains(p))?;
    app.emit_to("main", "browser://feedback", json!({ "pane_id": pane_id, "kind": kind, "count": count, "markdown": markdown })).map_err(|e| e.to_string())
}

// The main webview must be a child of the window, like the browser webviews. On macOS
// a webview created as the window content replaces the content view, and a child added
// later lands in the old, detached view and never paints.
fn open_main_window(app: &AppHandle) -> tauri::Result<()> {
    let config = app.config().app.windows.iter().find(|w| w.label == "main").cloned().ok_or_else(|| tauri::Error::WindowNotFound)?;
    let window = tauri::window::WindowBuilder::from_config(app, &config)?.build()?;
    let size = window.inner_size()?.to_logical::<f64>(window.scale_factor()?);
    window.add_child(WebviewBuilder::from_config(&config).auto_resize(), LogicalPosition::new(0.0, 0.0), size)?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    STARTED.get_or_init(std::time::Instant::now);
    mark("process start");
    let link = Arc::new(Link { tx: Mutex::new(None), pending: Arc::new(Mutex::new(HashMap::new())), next_id: AtomicU64::new(1) });
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .manage(link)
        .manage(AnnotatePanes::default())
        .invoke_handler(tauri::generate_handler![
            rpc,
            daemon_connected,
            browser::browser_create,
            browser::browser_set_bounds,
            browser::browser_set_visible,
            browser::browser_navigate,
            browser::browser_back,
            browser::browser_forward,
            browser::browser_reload,
            browser::browser_close,
            browser_set_annotate,
            browser_clear_annotations,
            browser_feedback
        ])
        .setup(|app| {
            mark("tauri setup");
            open_main_window(app.handle())?;
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(connect_loop(handle));
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn feedback_pane_comes_from_the_label_and_gates_copy_and_submit() {
        let on = |p: &str| p == "p1";
        assert_eq!(feedback_pane("browser-p1", "change", on), Ok("p1"));
        assert_eq!(feedback_pane("browser-p2", "change", on), Ok("p2"));
        assert_eq!(feedback_pane("browser-p1", "copy", on), Ok("p1"));
        assert_eq!(feedback_pane("browser-p1", "submit", on), Ok("p1"));
        assert!(feedback_pane("browser-p2", "copy", on).is_err());
        assert!(feedback_pane("browser-p1", "eval", on).is_err());
        assert!(feedback_pane("main", "change", on).is_err());
    }

    #[test]
    fn agentation_script_injects_once_then_toggles() {
        let script = agentation_script(true);
        assert!(script.starts_with("if(!window.__tomoAgentation){"));
        assert!(script.ends_with("}window.__tomoAgentation.set(true);"));
        assert!(agentation_script(false).ends_with("set(false);"));
    }
}
