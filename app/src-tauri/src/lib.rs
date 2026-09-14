use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, State};
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    STARTED.get_or_init(std::time::Instant::now);
    mark("process start");
    let link = Arc::new(Link { tx: Mutex::new(None), pending: Arc::new(Mutex::new(HashMap::new())), next_id: AtomicU64::new(1) });
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(link)
        .invoke_handler(tauri::generate_handler![rpc, daemon_connected])
        .setup(|app| {
            mark("tauri setup");
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(connect_loop(handle));
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
