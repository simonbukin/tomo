mod agentation;
mod browser;
mod viewer;

use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tauri::utils::config::Color;
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
type Pending = Arc<Mutex<HashMap<u64, oneshot::Sender<Result<Value, RpcError>>>>>;

pub struct Link {
    tx: Mutex<Option<mpsc::UnboundedSender<String>>>,
    pending: Pending,
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
                if attempts == 0 || attempts.is_multiple_of(80) {
                    start_daemon();
                }
                attempts += 1;
            }
        }
        let wait = if attempts == 0 {
            300
        } else if attempts < 80 {
            25
        } else {
            250
        };
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

/// What Browser runs for each addon when a page finishes loading (webview, pane id) and when a pane closes (app, pane id).
pub(crate) const BROWSER_PAGE_LOADED: &[fn(&Webview, &str)] = &[agentation::page_loaded];
pub(crate) const BROWSER_CLOSED: &[fn(&AppHandle, &str)] = &[agentation::closed];

#[tauri::command]
fn daemon_connected(link: State<'_, Arc<Link>>) -> bool {
    link.tx.lock().unwrap().is_some()
}

/// Writes the image on a pasteboard to the file in argv[0] as PNG. argv[1] names a private pasteboard for tests;
/// without it the script reads the general clipboard. Many apps put only TIFF on the pasteboard, so TIFF is converted.
const SAVE_PASTEBOARD_PNG: &str = r#"ObjC.import('AppKit');
function run(argv) {
  const pb = argv[1] ? $.NSPasteboard.pasteboardWithName(argv[1]) : $.NSPasteboard.generalPasteboard;
  let data = pb.dataForType($.NSPasteboardTypePNG);
  if (data.isNil()) {
    const tiff = pb.dataForType($.NSPasteboardTypeTIFF);
    if (tiff.isNil()) throw new Error('no image on the pasteboard');
    data = $.NSBitmapImageRep.imageRepWithData(tiff).representationUsingTypeProperties($.NSBitmapImageFileTypePNG, $());
  }
  if (!data.writeToFileAtomically(argv[0], true)) throw new Error('could not write ' + argv[0]);
}"#;

async fn save_pasteboard_png(path: &std::path::Path, pasteboard: Option<&str>) -> bool {
    let mut cmd = tokio::process::Command::new("osascript");
    cmd.args(["-l", "JavaScript", "-e", SAVE_PASTEBOARD_PNG]).arg(path);
    if let Some(name) = pasteboard {
        cmd.arg(name);
    }
    let saved = cmd.output().await.is_ok_and(|o| o.status.success());
    saved && std::fs::metadata(path).is_ok_and(|m| m.len() > 0)
}

/// Opens `path` in Finder when it is a folder, and returns whether it did. A terminal link to a folder opens there;
/// a link to a file goes on to a pane.
#[tauri::command]
async fn open_folder(path: String) -> bool {
    std::fs::metadata(&path).is_ok_and(|m| m.is_dir()) && tokio::process::Command::new("open").arg(&path).status().await.is_ok_and(|s| s.success())
}

/// Saves the image on the clipboard as a new PNG file and returns its path, or None when the clipboard holds no image.
/// A terminal agent attaches an image from a pasted path, the same way it does for a dropped file.
#[tauri::command]
async fn clipboard_image() -> Option<String> {
    let dir = std::env::temp_dir().join("tomo-paste");
    std::fs::create_dir_all(&dir).ok()?;
    let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).ok()?.as_millis();
    let path = dir.join(format!("clipboard-{stamp}.png"));
    if save_pasteboard_png(&path, None).await {
        return Some(path.to_string_lossy().into_owned());
    }
    let _ = std::fs::remove_file(&path);
    None
}

#[tauri::command]
fn splash_ready(app: AppHandle) {
    if let Some(window) = app.get_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
    }
}

// The main webview must be a child of the window, like the browser webviews. On macOS
// a webview created as the window content replaces the content view, and a child added
// later lands in the old, detached view and never paints.
fn open_main_window(app: &AppHandle) -> tauri::Result<()> {
    let config = app.config().app.windows.iter().find(|w| w.label == "main").cloned().ok_or_else(|| tauri::Error::WindowNotFound)?;
    // The window opens hidden and the page shows it once the splash has painted, through
    // splash_ready. Every earlier moment measured as a white window: the webview holds
    // WebKit's blank page until its first paint, whatever background colour it carries.
    let window = tauri::window::WindowBuilder::from_config(app, &config)?.visible(false).build()?;
    let ground = match window.theme() {
        Ok(tauri::Theme::Light) => Color(0xfb, 0xfa, 0xfd, 0xff),
        _ => Color(0x17, 0x14, 0x1f, 0xff),
    };
    window.set_background_color(Some(ground))?;
    let size = window.inner_size()?.to_logical::<f64>(window.scale_factor()?);
    window.add_child(WebviewBuilder::from_config(&config).background_color(ground).auto_resize(), LogicalPosition::new(0.0, 0.0), size)?;
    // A page that never loads must not leave the person with no window at all.
    let fallback = window.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_secs(2));
        if fallback.is_visible().is_ok_and(|v| !v) {
            let _ = fallback.show();
        }
    });
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    STARTED.get_or_init(std::time::Instant::now);
    mark("process start");
    let link = Arc::new(Link { tx: Mutex::new(None), pending: Arc::new(Mutex::new(HashMap::new())), next_id: AtomicU64::new(1) });
    let builder = tauri::Builder::default();
    // WebKit renders web content at 60 Hz even where the display runs at 120. There is no
    // public API for it, so this flips WebKit's own private preference, the way Safari does.
    #[cfg(target_os = "macos")]
    let builder = builder.plugin(tauri_plugin_macos_fps::init());
    builder
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .register_asynchronous_uri_scheme_protocol(viewer::SCHEME, |ctx, request, responder| {
            let webview = ctx.webview_label().to_string();
            std::thread::spawn(move || responder.respond(viewer::serve(&webview, &request)));
        })
        .manage(link)
        .manage(agentation::AnnotatePanes::default())
        .invoke_handler(tauri::generate_handler![
            rpc,
            daemon_connected,
            clipboard_image,
            open_folder,
            splash_ready,
            browser::browser_create,
            browser::browser_set_bounds,
            browser::browser_set_visible,
            browser::browser_navigate,
            browser::browser_back,
            browser::browser_forward,
            browser::browser_reload,
            browser::browser_close,
            agentation::browser_set_annotate,
            agentation::browser_clear_annotations,
            agentation::browser_feedback
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
    /// Puts a 2x2 image on a private pasteboard as `kind` (PNG or TIFF), so the test never touches the user's clipboard.
    fn fill_private_pasteboard(name: &str, kind: &str) {
        let script = format!(
            "ObjC.import('AppKit'); const img = $.NSImage.alloc.initWithSize($.NSMakeSize(2, 2)); img.lockFocus; $.NSColor.redColor.set; $.NSRectFill($.NSMakeRect(0, 0, 2, 2)); img.unlockFocus; \
             const tiff = img.TIFFRepresentation; const pb = $.NSPasteboard.pasteboardWithName('{name}'); pb.clearContents; \
             if ('{kind}' === 'png') {{ pb.setDataForType($.NSBitmapImageRep.imageRepWithData(tiff).representationUsingTypeProperties($.NSBitmapImageFileTypePNG, $()), $.NSPasteboardTypePNG); }} \
             else {{ pb.setDataForType(tiff, $.NSPasteboardTypeTIFF); }}"
        );
        let out = std::process::Command::new("osascript").args(["-l", "JavaScript", "-e", &script]).output().unwrap();
        assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    }

    fn release_private_pasteboard(name: &str) {
        let script = format!("ObjC.import('AppKit'); $.NSPasteboard.pasteboardWithName('{name}').releaseGlobally");
        let _ = std::process::Command::new("osascript").args(["-l", "JavaScript", "-e", &script]).output();
    }

    #[tokio::test]
    async fn an_image_on_the_pasteboard_is_saved_as_png_whether_it_came_as_png_or_tiff() {
        for kind in ["png", "tiff"] {
            let name = format!("tomo-test-{}-{kind}", std::process::id());
            fill_private_pasteboard(&name, kind);
            let path = std::env::temp_dir().join(format!("{name}.png"));
            assert!(super::save_pasteboard_png(&path, Some(&name)).await, "{kind}");
            let bytes = std::fs::read(&path).unwrap();
            assert_eq!(&bytes[..8], b"\x89PNG\r\n\x1a\n", "{kind} becomes a PNG file");
            let _ = std::fs::remove_file(&path);
            release_private_pasteboard(&name);
        }
    }

    #[tokio::test]
    async fn a_pasteboard_without_an_image_saves_nothing() {
        let name = format!("tomo-test-{}-empty", std::process::id());
        let script = format!("ObjC.import('AppKit'); const pb = $.NSPasteboard.pasteboardWithName('{name}'); pb.clearContents; pb.setStringForType('just text', $.NSPasteboardTypeString)");
        std::process::Command::new("osascript").args(["-l", "JavaScript", "-e", &script]).output().unwrap();
        let path = std::env::temp_dir().join(format!("{name}.png"));
        assert!(!super::save_pasteboard_png(&path, Some(&name)).await);
        release_private_pasteboard(&name);
    }

    #[test]
    fn the_browser_host_does_not_name_agentation() {
        let hits: Vec<(&str, &str)> = [("browser.rs", include_str!("browser.rs")), ("main.rs", include_str!("main.rs"))]
            .into_iter()
            .flat_map(|(file, text)| {
                ["agentation", "annotat", "feedback"].into_iter().filter(move |noun| text.to_lowercase().contains(noun)).map(move |noun| (file, noun))
            })
            .collect();
        assert!(hits.is_empty(), "the browser host names agentation: {hits:?}");
    }
}
