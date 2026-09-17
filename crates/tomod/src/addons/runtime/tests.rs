use crate::config::Paths;
use crate::daemon::{Client, Daemon};
use crate::{addons, dispatch, monitor};
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;
use tomo_proto::*;

fn git(dir: &Path, args: &[&str]) {
    assert!(std::process::Command::new("git")
        .args(["-c", "user.email=t@t", "-c", "user.name=t"])
        .args(args)
        .current_dir(dir)
        .output()
        .unwrap()
        .status
        .success());
}

async fn call(daemon: &Arc<Daemon>, call: Call) -> Value {
    dispatch::handle(daemon, 0, call).await.unwrap()
}

async fn tick(daemon: &Arc<Daemon>) {
    let d = daemon.clone();
    tokio::task::spawn_blocking(move || monitor::poll_and_scan(&d, false)).await.unwrap();
}

async fn endpoints(daemon: &Arc<Daemon>, worktree_id: &str) -> Vec<RuntimeEndpoint> {
    serde_json::from_value(call(daemon, Call::RuntimeList { worktree_id: Some(worktree_id.into()) }).await).unwrap()
}

async fn wait_for_list(what: &str, daemon: &Arc<Daemon>, worktree_id: &str, done: impl Fn(&[RuntimeEndpoint]) -> bool) -> Vec<RuntimeEndpoint> {
    for _ in 0..100 {
        tick(daemon).await;
        let list = endpoints(daemon, worktree_id).await;
        if done(&list) {
            return list;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    panic!("timed out waiting for {what}");
}

async fn wait_for_hooks(file: &Path, event: &str, count: usize) -> Vec<HookEvent> {
    for _ in 0..100 {
        let found = hooks(file, event);
        if found.len() >= count {
            return found;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!("timed out waiting for {count} {event} hooks");
}

fn free_port() -> u16 {
    std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port()
}

fn serve_source() -> PaneSource {
    PaneSource { kind: ACTION_SOURCE_KIND.into(), id: "serve".into(), label: "Serve".into() }
}

async fn serve(daemon: &Arc<Daemon>, worktree_id: &str, port: u16) -> Id {
    let server = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../scripts/fixtures/fake-server");
    let command = vec!["python3".to_string(), server.display().to_string(), "--port".into(), port.to_string()];
    let created = call(daemon, Call::PaneCreate(PaneCreate { worktree_id: Some(worktree_id.into()), command: Some(command), ..Default::default() })).await;
    let pane_id = created["pane"]["id"].as_str().unwrap().to_string();
    daemon.lock().panes.get_mut(&pane_id).unwrap().source = Some(serve_source());
    pane_id
}

fn hooks(file: &Path, event: &str) -> Vec<HookEvent> {
    std::fs::read_to_string(file).unwrap_or_default().lines().filter_map(|l| serde_json::from_str::<HookEvent>(l).ok()).filter(|e| e.event == event).collect()
}

#[tokio::test(flavor = "multi_thread")]
async fn a_pane_listener_is_labelled_from_its_source_recorded_once_and_removed_after_the_grace() {
    let dir = PathBuf::from(format!("/tmp/tomo-addons-runtime-test-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let repo = dir.join("repo");
    std::fs::create_dir_all(&repo).unwrap();
    std::fs::create_dir_all(dir.join("data")).unwrap();
    git(&repo, &["init", "-q"]);
    git(&repo, &["commit", "-q", "--allow-empty", "-m", "init"]);
    let log = dir.join("events.log");
    let hook = |e: &str| format!("[[hooks]]\nevent = \"{e}\"\ncommand = \"printf '%s\\\\n' \\\"$TOMO_EVENT_JSON\\\" >> {}\"\n", log.display());
    std::fs::write(dir.join("data/config.toml"), [hook("runtime.endpoint_discovered"), hook("runtime.endpoint_removed")].join("\n")).unwrap();
    let daemon = Daemon::new(Paths::new(dir.join("data")), addons::seams(), Box::new(addons::State::default())).unwrap();
    addons::migrate(&daemon.lock().store).unwrap();
    daemon.lock().config.shell = "/bin/sh".into();
    call(&daemon, Call::RepoAdd { path: repo.clone() }).await;
    let worktrees: Vec<Worktree> = serde_json::from_value(call(&daemon, Call::WorktreeList).await).unwrap();
    let worktree_id = worktrees[0].id.clone();
    let (tx, mut frames) = tokio::sync::mpsc::unbounded_channel();
    daemon.lock().clients.insert(7, Client { tx, subscribed: true, attached: Default::default() });

    let port = free_port();
    let first = serve(&daemon, &worktree_id, port).await;
    let list = wait_for_list("the endpoint", &daemon, &worktree_id, |l| l.iter().any(|e| e.port == port)).await;
    let e = list.iter().find(|e| e.port == port).unwrap().clone();
    assert_eq!(
        (e.id.clone(), e.worktree_id.as_str(), e.pane_id.as_deref(), e.action_id.as_deref(), e.label.as_deref(), e.host.as_str()),
        (format!("{}:{port}", e.pid), worktree_id.as_str(), Some(first.as_str()), Some("serve"), Some("Serve"), "localhost")
    );
    assert_eq!(e.source, Some(serve_source()));
    wait_for_list("the http probe", &daemon, &worktree_id, |l| l.iter().any(|e| e.port == port && e.protocol == RuntimeProtocol::Http)).await;

    let snapshot = call(&daemon, Call::Subscribe).await;
    assert!(
        snapshot["endpoints"].as_array().unwrap().iter().any(|v| v["id"] == e.id.as_str() && v["action_id"] == "serve"),
        "the snapshot lists the endpoint: {}",
        snapshot["endpoints"]
    );
    let sent: Vec<Value> = std::iter::from_fn(|| frames.try_recv().ok())
        .filter_map(|t| serde_json::from_str::<Value>(&t).ok())
        .filter(|v| v["event"] == "endpoints_changed")
        .collect();
    assert!(
        sent.iter().any(|v| v["data"]["worktree_id"] == worktree_id.as_str() && v["data"]["endpoints"][0]["protocol"] == "tcp"),
        "endpoints_changed on discovery: {sent:?}"
    );
    assert!(sent.iter().any(|v| v["data"]["endpoints"][0]["protocol"] == "http"), "endpoints_changed after the probe: {sent:?}");

    let discovered = |d: &Arc<Daemon>| -> Vec<ActivityEvent> {
        let query = ActivityQuery { worktree_id: Some(worktree_id.clone()), ..Default::default() };
        d.lock().store.activity_list(&query, &[]).unwrap().into_iter().filter(|a| a.kind.as_str() == "endpoint_discovered").collect()
    };
    let recorded = discovered(&daemon);
    assert_eq!(recorded.len(), 1);
    assert_eq!(
        (recorded[0].title.clone(), recorded[0].detail.clone(), recorded[0].pane_id.as_deref()),
        (format!("Serve listens on {port}"), Some(format!("localhost:{port}")), Some(first.as_str()))
    );
    assert_eq!(recorded[0].payload, serde_json::json!({ "port": port, "host": "localhost", "pid": e.pid, "action_id": "serve", "endpoint_id": e.id }));
    let hook = wait_for_hooks(&log, "runtime.endpoint_discovered", 1).await.remove(0);
    assert_eq!(
        (hook.action.map(|a| (a.id, a.label)), hook.pane.map(|p| p.id), hook.worktree.map(|w| w.id)),
        (Some(("serve".into(), "Serve".into())), Some(first.clone()), Some(worktree_id.clone()))
    );

    assert!(std::process::Command::new("kill").arg(e.pid.to_string()).status().unwrap().success());
    tokio::time::sleep(Duration::from_millis(300)).await;
    tick(&daemon).await;
    assert!(endpoints(&daemon, &worktree_id).await.iter().any(|x| x.port == port), "a gone listener stays listed for the grace");
    tokio::time::sleep(Duration::from_millis(super::model::REMOVAL_GRACE_MS + 200)).await;
    wait_for_list("the removal", &daemon, &worktree_id, |l| !l.iter().any(|x| x.port == port)).await;
    let removed = wait_for_hooks(&log, "runtime.endpoint_removed", 1).await;
    assert_eq!(removed[0].action.as_ref().map(|a| a.id.as_str()), Some("serve"));

    let second = serve(&daemon, &worktree_id, port).await;
    wait_for_list("the second endpoint", &daemon, &worktree_id, |l| l.iter().any(|x| x.pane_id.as_deref() == Some(second.as_str()))).await;
    wait_for_hooks(&log, "runtime.endpoint_discovered", 2).await;
    assert_eq!(discovered(&daemon).len(), 1, "a second discovery on the same port inside a minute records no activity");
    daemon.shutdown();
    let _ = std::fs::remove_dir_all(&dir);
}
