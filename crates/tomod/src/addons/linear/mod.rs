//! Linear: the issue that each worktree's branch names, and its state. See docs/linear.md.
//! The key lives in the Keychain. `curl` gets it on stdin, never in argv.
//! A background check runs every 20 s while a client is subscribed. It fetches when the answer is 60 s old or when a branch names another issue.

mod model;

use crate::addons;
use crate::daemon::{err, ok, Daemon, Inner};
use model::Wanted;
use serde_json::Value;
use std::io::Write;
use std::process::{Command, Stdio};
use std::sync::Arc;
use std::time::Duration;
use tomo_proto::*;

const GRAPHQL_URL: &str = "https://api.linear.app/graphql";
const KEYCHAIN_SERVICE: &str = "tomo.linear";
const KEYCHAIN_ACCOUNT: &str = "linear";
const REQUEST_TIMEOUT_SECS: u64 = 8;
const POLL_TICK: Duration = Duration::from_secs(20);
const NO_KEY: &str = "no Linear key; run `tomo linear login`";

/// The last answer, and the worktree issues that it asked for. Memory only: a restart starts empty.
/// `started` counts fetches; `kept` is the number of the fetch that gave `status`.
#[derive(Default)]
pub struct Last {
    status: LinearStatus,
    asked: Vec<Wanted>,
    started: u64,
    kept: u64,
}

fn read_key() -> Option<String> {
    Command::new("security")
        .args(["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", KEYCHAIN_ACCOUNT, "-w"])
        .stderr(Stdio::null())
        .output()
        .ok()
        .filter(|o| o.status.success())
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .map(|k| k.trim().to_string())
        .filter(|k| !k.is_empty())
}

/// `security -i` reads its command from stdin, so the key stays out of argv. `model::valid_key` keeps the command line whole.
fn security_stdin(command: &str) -> Result<(), String> {
    let mut child = Command::new("security").arg("-i").stdin(Stdio::piped()).stdout(Stdio::null()).stderr(Stdio::piped()).spawn().map_err(|e| format!("security failed to start: {e}"))?;
    child.stdin.take().map(|mut stdin| stdin.write_all(format!("{command}\n").as_bytes())).transpose().map_err(|e| e.to_string())?;
    let out = child.wait_with_output().map_err(|e| e.to_string())?;
    let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
    if stderr.is_empty() { Ok(()) } else { Err(stderr) }
}

fn store_key(key: &str) -> Result<(), String> {
    security_stdin(&format!("add-generic-password -U -s {KEYCHAIN_SERVICE} -a {KEYCHAIN_ACCOUNT} -w {key}"))?;
    (read_key().as_deref() == Some(key)).then_some(()).ok_or_else(|| "the Keychain did not keep the key".to_string())
}

fn delete_key() {
    let _ = Command::new("security").args(["delete-generic-password", "-s", KEYCHAIN_SERVICE, "-a", KEYCHAIN_ACCOUNT]).stdout(Stdio::null()).stderr(Stdio::null()).status();
}

fn split_status(output: &[u8]) -> (&[u8], &str) {
    let cut = output.iter().rposition(|b| *b == b'\n').unwrap_or(0);
    (&output[..cut], std::str::from_utf8(&output[cut..]).unwrap_or("").trim())
}

/// One GraphQL request. It gives the HTTP status and the body; a failed `curl` gives the status `000`.
fn post(key: &str, request: &Value) -> (String, Value) {
    let child = Command::new("curl")
        .args(["-s", "--max-time", &REQUEST_TIMEOUT_SECS.to_string(), "-H", "@-", "-w", "\n%{http_code}", "--data-binary", &request.to_string(), GRAPHQL_URL])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn();
    let Ok(mut child) = child else { return ("000".into(), Value::Null) };
    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(format!("Authorization: {key}\nContent-Type: application/json\n").as_bytes());
    }
    let Ok(out) = child.wait_with_output() else { return ("000".into(), Value::Null) };
    if !out.status.success() {
        return ("000".into(), Value::Null);
    }
    let (body, status) = split_status(&out.stdout);
    (status.to_string(), serde_json::from_slice(body).unwrap_or(Value::Null))
}

fn fetch(wanted: &[Wanted], now: u64) -> LinearStatus {
    let Some(key) = read_key() else { return model::unavailable(NO_KEY, now) };
    if wanted.is_empty() {
        return model::found(vec![], now);
    }
    let (status, body) = post(&key, &model::issues_request(wanted));
    match model::failure(&status, &body) {
        Some(reason) => model::unavailable(reason, now),
        None => model::found(model::links(wanted, &body), now),
    }
}

fn wanted_now(inner: &Inner) -> Vec<Wanted> {
    let live = inner.worktrees.values().filter(|w| w.exists && w.archived_at_ms.is_none());
    let mut wanted = model::wanted(live.filter_map(|w| w.branch.as_deref().map(|b| (&w.id, b))));
    wanted.sort();
    wanted
}

/// The last answer, for the `subscribe` snapshot.
pub fn snapshot(inner: &Inner) -> LinearStatus {
    addons::state(inner).linear.status.clone()
}

/// Keeps a new answer under the Core lock. A missing key is not a problem: most people do not use Linear.
pub fn remember(inner: &mut Inner, fetch: u64, asked: Vec<Wanted>, fresh: LinearStatus) {
    let last = &addons::state(inner).linear;
    if !model::newer(last.kept, fetch) {
        return;
    }
    let started = last.started;
    let problem = fresh.reason.clone().filter(|r| r != NO_KEY);
    Daemon::diagnostic_on_change(inner, "linear", "linear issues", problem);
    let before = std::mem::replace(&mut addons::state_mut(inner).linear, Last { status: fresh.clone(), asked, started, kept: fetch });
    if !model::same(&before.status, &fresh) {
        Daemon::emit(inner, Event::LinearChanged { status: fresh });
    }
}

async fn refresh(daemon: &Arc<Daemon>) {
    let (number, wanted) = {
        let mut inner = daemon.lock();
        let wanted = wanted_now(&inner);
        let last = &mut addons::state_mut(&mut inner).linear;
        last.started += 1;
        (last.started, wanted)
    };
    let asked = wanted.clone();
    let fresh = tokio::task::spawn_blocking(move || fetch(&wanted, now_ms())).await.unwrap_or_else(|e| model::unavailable(e.to_string(), now_ms()));
    remember(&mut daemon.lock(), number, asked, fresh);
}

/// `linear_get`: fetches at once when `refresh` is set, or when a subscribed poll would, because no poll runs without a subscriber.
pub async fn get(daemon: &Arc<Daemon>, refresh_now: bool) -> Result<Value, RpcError> {
    let is_due = {
        let inner = daemon.lock();
        let last = &addons::state(&inner).linear;
        model::due(true, &last.status, &last.asked, &wanted_now(&inner), now_ms())
    };
    if refresh_now || is_due {
        refresh(daemon).await;
    }
    ok(snapshot(&daemon.lock()))
}

/// `linear_login`: asks Linear who owns the key, and keeps the key only when Linear accepts it.
pub async fn login(daemon: &Arc<Daemon>, key: String) -> Result<Value, RpcError> {
    let key = key.trim().to_string();
    if !model::valid_key(&key) {
        return Err(err(ErrorCode::BadRequest, "not a Linear personal API key: it starts with lin_api_"));
    }
    let viewer = tokio::task::spawn_blocking(move || {
        let (status, body) = post(&key, &model::viewer_request());
        if let Some(reason) = model::failure(&status, &body) {
            return Err(err(ErrorCode::BadRequest, reason));
        }
        let viewer = model::viewer(&body).ok_or_else(|| err(ErrorCode::Internal, "Linear gave no viewer"))?;
        store_key(&key).map_err(|e| err(ErrorCode::Io, format!("Keychain: {e}")))?;
        Ok(viewer)
    })
    .await
    .map_err(|e| err(ErrorCode::Internal, e.to_string()))??;
    refresh(daemon).await;
    ok(viewer)
}

/// `linear_logout`: deletes the key and clears the links.
pub async fn logout(daemon: &Arc<Daemon>) -> Result<Value, RpcError> {
    tokio::task::spawn_blocking(delete_key).await.map_err(|e| err(ErrorCode::Internal, e.to_string()))?;
    refresh(daemon).await;
    ok(snapshot(&daemon.lock()))
}

/// The background poll. It fetches only while a client is subscribed.
pub async fn run(daemon: Arc<Daemon>) {
    loop {
        tokio::time::sleep(POLL_TICK).await;
        let is_due = {
            let inner = daemon.lock();
            let last = &addons::state(&inner).linear;
            model::due(inner.clients.values().any(|c| c.subscribed), &last.status, &last.asked, &wanted_now(&inner), now_ms())
        };
        if is_due {
            refresh(&daemon).await;
        }
    }
}
