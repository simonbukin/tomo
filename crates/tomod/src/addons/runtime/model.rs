//! The pure rules of Runtime: `lsof` text, hosts, idle shells, the restart grace, and the HTTP probe of one socket.

use std::collections::{HashMap, HashSet};
use std::io::{Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::time::Duration;
use tomo_proto::*;

/// A port that vanishes and returns within this window (a restart) makes no event.
pub const REMOVAL_GRACE_MS: u64 = 5_000;
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

pub fn is_shell(name: &str) -> bool {
    let base = name.trim_start_matches('-').rsplit('/').next().unwrap_or(name);
    SHELLS.contains(&base)
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

#[cfg(test)]
mod tests {
    use super::*;

    fn ep(pid: u32, port: u16, wt: &str) -> RuntimeEndpoint {
        RuntimeEndpoint { id: format!("{pid}:{port}"), worktree_id: wt.into(), pane_id: Some("p".into()), action_id: None, pid, process: "node".into(), protocol: RuntimeProtocol::Tcp, host: "localhost".into(), port, label: None, discovered_at_ms: 0, source: None }
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
