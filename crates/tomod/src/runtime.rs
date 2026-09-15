//! Runtime endpoints: listening TCP sockets owned by pane process trees.
//!
//! Attribution goes pid → pane (the pane whose PTY root is an ancestor) →
//! Action. A port number is never evidence; a process outside every pane
//! tree is never reported.

use crate::activity;
use crate::daemon::{Daemon, Inner};
use crate::events;
use crate::monitor;
use crate::procs;
use serde_json::json;
use std::collections::{BTreeSet, HashMap, HashSet};
use std::io::{Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::sync::Arc;
use std::time::Duration;
use tomo_proto::*;

/// A port that vanishes and returns within this window (a restart) makes no event.
pub const REMOVAL_GRACE_MS: u64 = 5_000;
/// One `endpoint_discovered` activity per worktree and port in this window.
pub const ENDPOINT_REPEAT_MS: u64 = 60_000;
const PROBE_TIMEOUT: Duration = Duration::from_millis(400);
const SHELLS: [&str; 6] = ["zsh", "bash", "sh", "fish", "dash", "login"];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Listener {
    pub pid: u32,
    pub host: String,
    pub port: u16,
}

pub fn normalise_host(host: &str) -> String {
    match host {
        "*" | "0.0.0.0" | "::" | "[::]" => "localhost".to_string(),
        h => h.to_string(),
    }
}

/// Parses `lsof -F pn`: `p<pid>` opens a process block, `n<host>:<port>` names one socket.
/// A process that listens on the same port over IPv4 and IPv6 yields one listener.
pub fn parse_lsof(text: &str) -> Vec<Listener> {
    let mut pid: Option<u32> = None;
    let mut seen: HashSet<(u32, u16)> = HashSet::new();
    let mut out = Vec::new();
    for line in text.lines() {
        if let Some(p) = line.strip_prefix('p') {
            pid = p.trim().parse().ok();
            continue;
        }
        let (Some(pid), Some(name)) = (pid, line.strip_prefix('n')) else { continue };
        let Some((host, port)) = name.rsplit_once(':') else { continue };
        let Ok(port) = port.trim().parse::<u16>() else { continue };
        if seen.insert((pid, port)) {
            out.push(Listener { pid, host: host.to_string(), port });
        }
    }
    out
}

/// One `lsof` call for the given pids; none when there is nothing to ask about.
pub fn listeners(pids: &[u32]) -> Result<Vec<Listener>, String> {
    if pids.is_empty() {
        return Ok(Vec::new());
    }
    let list = pids.iter().map(u32::to_string).collect::<Vec<_>>().join(",");
    std::process::Command::new("lsof")
        .args(["-nP", "-iTCP", "-sTCP:LISTEN", "-a", "-p", &list, "-F", "pn"])
        .stdin(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .output()
        .map(|o| parse_lsof(&String::from_utf8_lossy(&o.stdout)))
        .map_err(|e| format!("lsof: {e}"))
}

pub fn is_shell(name: &str) -> bool {
    let base = name.trim_start_matches('-').rsplit('/').next().unwrap_or(name);
    SHELLS.contains(&base)
}

fn owned(inner: &Inner) -> Vec<ProcessInfo> {
    monitor::classify_all(inner).into_iter().filter(|p| p.ownership == Ownership::Owned).collect()
}

fn program_of(inner: &Inner, pid: u32) -> Option<String> {
    inner.proc_rows.iter().find(|r| r.pid == pid).map(procs::program_name)
}

/// Every owned process except an idle pane shell, which cannot listen. A pane
/// root is judged by the program it runs now, because a shell that exec'd an
/// Action keeps its pid.
pub fn candidate_pids(inner: &Inner) -> Vec<u32> {
    owned(inner).into_iter().filter(|p| p.depth > 0 || !program_of(inner, p.pid).map_or(true, |n| is_shell(&n))).map(|p| p.pid).collect()
}

pub fn observe(inner: &Inner, listeners: &[Listener], now: u64) -> Vec<RuntimeEndpoint> {
    let by_pid: HashMap<u32, ProcessInfo> = owned(inner).into_iter().map(|p| (p.pid, p)).collect();
    listeners
        .iter()
        .filter_map(|l| {
            let p = by_pid.get(&l.pid)?;
            let pane_id = p.pane_id.clone()?;
            let worktree_id = p.worktree_id.clone()?;
            let source = inner.panes.get(&pane_id).and_then(|p| p.source.as_ref());
            let action_id = PaneSource::action_id(source);
            let label = source.map(|s| s.label.clone());
            Some(RuntimeEndpoint {
                id: format!("{}:{}", l.pid, l.port),
                worktree_id,
                pane_id: Some(pane_id),
                action_id,
                pid: l.pid,
                process: program_of(inner, l.pid).unwrap_or_else(|| p.name.clone()),
                protocol: RuntimeProtocol::Tcp,
                host: normalise_host(&l.host),
                port: l.port,
                label,
                discovered_at_ms: now,
            })
        })
        .collect()
}

#[derive(Debug, Default)]
pub struct Reconciled {
    pub endpoints: Vec<RuntimeEndpoint>,
    pub gone_ms: HashMap<Id, u64>,
    pub added: Vec<RuntimeEndpoint>,
    pub removed: Vec<RuntimeEndpoint>,
    pub restarted: Vec<RuntimeEndpoint>,
}

/// Merges one observation into the current list. A missing endpoint stays
/// listed for `REMOVAL_GRACE_MS`; a new pid on the same worktree and port
/// inside that window replaces it silently.
pub fn reconcile(current: &[RuntimeEndpoint], gone_ms: &HashMap<Id, u64>, observed: Vec<RuntimeEndpoint>, now: u64) -> Reconciled {
    let seen: HashSet<&Id> = observed.iter().map(|e| &e.id).collect();
    let known: HashSet<&Id> = current.iter().map(|e| &e.id).collect();
    let mut r = Reconciled::default();
    for e in current {
        if seen.contains(&e.id) {
            r.endpoints.push(e.clone());
            continue;
        }
        let since = gone_ms.get(&e.id).copied().unwrap_or(now);
        if now.saturating_sub(since) >= REMOVAL_GRACE_MS {
            r.removed.push(e.clone());
        } else {
            r.gone_ms.insert(e.id.clone(), since);
            r.endpoints.push(e.clone());
        }
    }
    for e in observed.into_iter().filter(|e| !known.contains(&e.id)) {
        let restart_of = r.endpoints.iter().position(|k| r.gone_ms.contains_key(&k.id) && k.worktree_id == e.worktree_id && k.port == e.port);
        match restart_of {
            Some(pos) => {
                r.gone_ms.remove(&r.endpoints[pos].id);
                r.endpoints[pos] = e.clone();
                r.restarted.push(e);
            }
            None => {
                r.endpoints.push(e.clone());
                r.added.push(e);
            }
        }
    }
    r
}

/// 400 ms connect, `HEAD /`, and a look at the first bytes. Anything that is
/// not an HTTP status line is plain TCP.
pub fn probe(host: &str, port: u16) -> RuntimeProtocol {
    let addrs = (host, port).to_socket_addrs().map(|a| a.collect::<Vec<_>>()).unwrap_or_default();
    for addr in addrs {
        let Ok(mut s) = TcpStream::connect_timeout(&addr, PROBE_TIMEOUT) else { continue };
        let _ = s.set_read_timeout(Some(PROBE_TIMEOUT));
        let _ = s.set_write_timeout(Some(PROBE_TIMEOUT));
        if s.write_all(b"HEAD / HTTP/1.0\r\n\r\n").is_err() {
            return RuntimeProtocol::Tcp;
        }
        let mut buf = [0u8; 8];
        let n = s.read(&mut buf).unwrap_or(0);
        return if buf[..n].starts_with(b"HTTP/") { RuntimeProtocol::Http } else { RuntimeProtocol::Tcp };
    }
    RuntimeProtocol::Tcp
}

impl Daemon {
    pub fn emit_endpoints(inner: &mut Inner, worktree_id: &str) {
        let endpoints = inner.endpoints.iter().filter(|e| e.worktree_id == worktree_id).cloned().collect();
        Self::emit(inner, Event::EndpointsChanged { worktree_id: worktree_id.to_string(), endpoints });
    }

    fn queue_endpoint_event(inner: &mut Inner, name: &str, e: &RuntimeEndpoint) {
        let mut ev = events::envelope(inner, name, Some(&e.worktree_id));
        ev.pane = e.pane_id.as_deref().and_then(|p| Self::hook_pane(inner, p));
        ev.action = e.action_id.as_ref().map(|id| HookAction { id: id.clone(), label: e.label.clone().unwrap_or_else(|| id.clone()) });
        inner.hook_queue.push(ev);
    }

    /// Runs `lsof` with no lock held, then merges the result. Call after a process poll.
    pub fn scan_endpoints(self: &Arc<Self>) {
        let pids = candidate_pids(&self.lock());
        let scanned = listeners(&pids);
        let mut inner = self.lock();
        Self::diagnostic_on_change(&mut inner, "runtime", "port scan", scanned.as_ref().err().cloned());
        let Ok(found) = scanned else { return };
        let now = now_ms();
        let observed = observe(&inner, &found, now);
        let r = reconcile(&inner.endpoints, &inner.endpoint_gone_ms, observed, now);
        inner.endpoints = r.endpoints;
        inner.endpoint_gone_ms = r.gone_ms;
        inner.endpoints_at_ms = now;
        let changed: BTreeSet<Id> = r.added.iter().chain(&r.removed).chain(&r.restarted).map(|e| e.worktree_id.clone()).collect();
        for e in &r.added {
            Self::queue_endpoint_event(&mut inner, "runtime.endpoint_discovered", e);
            let repeat = Self::recorded_recently(&inner, RuntimeActivity::EndpointDiscovered, ENDPOINT_REPEAT_MS, |a| a.worktree_id == Some(e.worktree_id.clone()) && a.payload["port"] == e.port);
            if !repeat {
                let mut ev = activity::event(RuntimeActivity::EndpointDiscovered, Some(&e.worktree_id), format!("{} listens on {}", e.label.clone().unwrap_or_else(|| e.process.clone()), e.port));
                ev.pane_id = e.pane_id.clone();
                ev.detail = Some(format!("{}:{}", e.host, e.port));
                ev.payload = json!({ "port": e.port, "host": e.host, "pid": e.pid, "action_id": e.action_id, "endpoint_id": e.id });
                Self::record(&mut inner, ev);
            }
        }
        for e in &r.removed {
            Self::queue_endpoint_event(&mut inner, "runtime.endpoint_removed", e);
        }
        for wt in &changed {
            Self::emit_endpoints(&mut inner, wt);
        }
        drop(inner);
        for e in r.added.iter().chain(&r.restarted) {
            self.probe_endpoint(e.id.clone(), e.host.clone(), e.port);
        }
    }

    fn probe_endpoint(self: &Arc<Self>, id: Id, host: String, port: u16) {
        let daemon = self.clone();
        self.rt.spawn(async move {
            let protocol = tokio::task::spawn_blocking(move || probe(&host, port)).await.unwrap_or(RuntimeProtocol::Tcp);
            let mut inner = daemon.lock();
            let Some(e) = inner.endpoints.iter_mut().find(|e| e.id == id) else { return };
            if e.protocol == protocol {
                return;
            }
            e.protocol = protocol;
            let worktree_id = e.worktree_id.clone();
            Daemon::emit_endpoints(&mut inner, &worktree_id);
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ep(pid: u32, port: u16, wt: &str) -> RuntimeEndpoint {
        RuntimeEndpoint { id: format!("{pid}:{port}"), worktree_id: wt.into(), pane_id: Some("p".into()), action_id: None, pid, process: "node".into(), protocol: RuntimeProtocol::Tcp, host: "localhost".into(), port, label: None, discovered_at_ms: 0 }
    }

    #[test]
    fn parses_lsof_blocks_and_normalises_hosts() {
        let text = "p100\nf3\nn*:3000\nf4\nn[::]:3000\np200\nf5\nn127.0.0.1:5173\nf6\nnbad\n";
        let got = parse_lsof(text);
        assert_eq!(got, vec![Listener { pid: 100, host: "*".into(), port: 3000 }, Listener { pid: 200, host: "127.0.0.1".into(), port: 5173 }]);
        assert_eq!(normalise_host("*"), "localhost");
        assert_eq!(normalise_host("[::]"), "localhost");
        assert_eq!(normalise_host("127.0.0.1"), "127.0.0.1");
        assert!(is_shell("-zsh") && is_shell("/bin/bash") && !is_shell("node"));
    }

    #[test]
    fn reconcile_debounces_a_restart_and_removes_after_the_grace() {
        let current = vec![ep(1, 3000, "w")];
        let gone = HashMap::new();
        let missing = reconcile(&current, &gone, vec![], 1_000);
        assert_eq!(missing.endpoints.len(), 1);
        assert!(missing.removed.is_empty());
        assert_eq!(missing.gone_ms.get("1:3000"), Some(&1_000));

        let back = reconcile(&missing.endpoints, &missing.gone_ms, vec![ep(2, 3000, "w")], 3_000);
        assert_eq!(back.endpoints.iter().map(|e| e.pid).collect::<Vec<_>>(), vec![2]);
        assert!(back.added.is_empty() && back.removed.is_empty());
        assert_eq!(back.restarted.len(), 1);
        assert!(back.gone_ms.is_empty());

        let still = reconcile(&missing.endpoints, &missing.gone_ms, vec![], 1_000 + REMOVAL_GRACE_MS);
        assert!(still.endpoints.is_empty());
        assert_eq!(still.removed.len(), 1);

        let other = reconcile(&missing.endpoints, &missing.gone_ms, vec![ep(3, 3000, "v")], 2_000);
        assert_eq!(other.added.len(), 1, "same port in another worktree is a new endpoint");
        assert_eq!(other.endpoints.len(), 2);
    }

    #[test]
    fn probe_tells_http_from_tcp() {
        let http = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let tcp = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let (hp, tp) = (http.local_addr().unwrap().port(), tcp.local_addr().unwrap().port());
        std::thread::spawn(move || {
            let (mut s, _) = http.accept().unwrap();
            let _ = s.write_all(b"HTTP/1.0 200 OK\r\n\r\n");
        });
        std::thread::spawn(move || {
            let (mut s, _) = tcp.accept().unwrap();
            let _ = s.write_all(b"hello\n");
        });
        assert_eq!(probe("127.0.0.1", hp), RuntimeProtocol::Http);
        assert_eq!(probe("127.0.0.1", tp), RuntimeProtocol::Tcp);
        assert_eq!(probe("127.0.0.1", 1), RuntimeProtocol::Tcp);
    }
}

#[cfg(test)]
mod characterization {
    use crate::config::Paths;
    use crate::daemon::{Client, Daemon};
    use crate::{addons, dispatch, monitor};
    use serde_json::Value;
    use std::path::{Path, PathBuf};
    use std::sync::Arc;
    use std::time::Duration;
    use tomo_proto::*;

    fn git(dir: &Path, args: &[&str]) {
        assert!(std::process::Command::new("git").args(["-c", "user.email=t@t", "-c", "user.name=t"]).args(args).current_dir(dir).output().unwrap().status.success());
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

    async fn serve(daemon: &Arc<Daemon>, worktree_id: &str, port: u16) -> Id {
        let server = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../scripts/fixtures/fake-server");
        let command = vec!["python3".to_string(), server.display().to_string(), "--port".into(), port.to_string()];
        let created = call(daemon, Call::PaneCreate(PaneCreate { worktree_id: Some(worktree_id.into()), command: Some(command), ..Default::default() })).await;
        let pane_id = created["pane"]["id"].as_str().unwrap().to_string();
        daemon.lock().panes.get_mut(&pane_id).unwrap().source = Some(PaneSource { kind: ACTION_SOURCE_KIND.into(), id: "serve".into(), label: "Serve".into() });
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
        wait_for_list("the http probe", &daemon, &worktree_id, |l| l.iter().any(|e| e.port == port && e.protocol == RuntimeProtocol::Http)).await;

        let snapshot = call(&daemon, Call::Subscribe).await;
        assert!(snapshot["endpoints"].as_array().unwrap().iter().any(|v| v["id"] == e.id.as_str() && v["action_id"] == "serve"), "the snapshot lists the endpoint: {}", snapshot["endpoints"]);
        let sent: Vec<Value> = std::iter::from_fn(|| frames.try_recv().ok()).filter_map(|t| serde_json::from_str::<Value>(&t).ok()).filter(|v| v["event"] == "endpoints_changed").collect();
        assert!(sent.iter().any(|v| v["data"]["worktree_id"] == worktree_id.as_str() && v["data"]["endpoints"][0]["protocol"] == "tcp"), "endpoints_changed on discovery: {sent:?}");
        assert!(sent.iter().any(|v| v["data"]["endpoints"][0]["protocol"] == "http"), "endpoints_changed after the probe: {sent:?}");

        let discovered = |d: &Arc<Daemon>| -> Vec<ActivityEvent> {
            let query = ActivityQuery { worktree_id: Some(worktree_id.clone()), ..Default::default() };
            d.lock().store.activity_list(&query, &[]).unwrap().into_iter().filter(|a| a.kind.as_str() == "endpoint_discovered").collect()
        };
        let recorded = discovered(&daemon);
        assert_eq!(recorded.len(), 1);
        assert_eq!((recorded[0].title.clone(), recorded[0].detail.clone(), recorded[0].pane_id.as_deref()), (format!("Serve listens on {port}"), Some(format!("localhost:{port}")), Some(first.as_str())));
        assert_eq!(recorded[0].payload, serde_json::json!({ "port": port, "host": "localhost", "pid": e.pid, "action_id": "serve", "endpoint_id": e.id }));
        let hook = wait_for_hooks(&log, "runtime.endpoint_discovered", 1).await.remove(0);
        assert_eq!((hook.action.map(|a| (a.id, a.label)), hook.pane.map(|p| p.id), hook.worktree.map(|w| w.id)), (Some(("serve".into(), "Serve".into())), Some(first.clone()), Some(worktree_id.clone())));

        assert!(std::process::Command::new("kill").arg(e.pid.to_string()).status().unwrap().success());
        tokio::time::sleep(Duration::from_millis(300)).await;
        tick(&daemon).await;
        assert!(endpoints(&daemon, &worktree_id).await.iter().any(|x| x.port == port), "a gone listener stays listed for the grace");
        tokio::time::sleep(Duration::from_millis(5_200)).await;
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
}
