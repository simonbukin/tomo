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
