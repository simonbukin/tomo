//! The pure rules of Runtime: `lsof` text, hosts, idle shells, the restart grace, and the HTTP probe of one socket.

use std::collections::{HashMap, HashSet};
use std::io::{Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::Duration;
use tomo_proto::*;

/// A port that vanishes and returns within this window (a restart) makes no
/// event. A dev server that builds again before it listens again needs more
/// than a few seconds, and a remove with an add costs two hooks and two
/// activity rows.
pub const REMOVAL_GRACE_MS: u64 = 15_000;
/// `lsof` can hang, for example on a stale network mount. The monitor tick
/// waits for the answer, so a hung call would stop the process poll, the agent
/// state, and the resources of every worktree.
pub const LSOF_DEADLINE: Duration = Duration::from_secs(2);
const PROBE_CONNECT: Duration = Duration::from_millis(400);
/// A dev server can answer its first request slowly while it builds; a later probe catches it anyway.
const PROBE_REPLY: Duration = Duration::from_millis(1_000);
/// The waits between the probes of a port that does not answer HTTP yet.
pub const PROBE_RETRIES: [Duration; 7] = [secs(1), secs(2), secs(3), secs(5), secs(10), secs(20), secs(30)];
const fn secs(s: u64) -> Duration {
    Duration::from_secs(s)
}
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


/// What one probe of a socket found.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Probe {
    pub protocol: RuntimeProtocol,
    /// The status of `HEAD /` when the socket speaks HTTP.
    pub status: Option<u16>,
}

impl Probe {
    pub const TCP: Probe = Probe { protocol: RuntimeProtocol::Tcp, status: None };
}

/// The status code of an HTTP status line, such as `HTTP/1.1 307 Temporary Redirect`.
pub fn parse_status(first: &[u8]) -> Option<u16> {
    let line = std::str::from_utf8(first).ok()?;
    let rest = line.strip_prefix("HTTP/")?;
    rest.split_whitespace().nth(1)?.parse().ok()
}

/// Connect, `HEAD /`, and read the status line. Anything that is not an HTTP
/// status line is plain TCP. `lsof` writes an IPv6 host in brackets, and the
/// resolver refuses the brackets.
pub fn probe(host: &str, port: u16) -> Probe {
    let host = host.strip_prefix('[').and_then(|h| h.strip_suffix(']')).unwrap_or(host);
    let addrs = (host, port).to_socket_addrs().map(|a| a.collect::<Vec<_>>()).unwrap_or_default();
    for addr in addrs {
        let Ok(mut s) = TcpStream::connect_timeout(&addr, PROBE_CONNECT) else { continue };
        let _ = s.set_read_timeout(Some(PROBE_REPLY));
        let _ = s.set_write_timeout(Some(PROBE_CONNECT));
        if s.write_all(b"HEAD / HTTP/1.0\r\n\r\n").is_err() {
            return Probe::TCP;
        }
        let mut buf = [0u8; 32];
        let n = s.read(&mut buf).unwrap_or(0);
        return match parse_status(&buf[..n]) {
            Some(status) => Probe { protocol: RuntimeProtocol::Http, status: Some(status) },
            None if buf[..n].starts_with(b"HTTP/") => Probe { protocol: RuntimeProtocol::Http, status: None },
            None => Probe::TCP,
        };
    }
    Probe::TCP
}

/// The wait before the next probe of an endpoint, after `done` probes that found no HTTP. `None`
/// means stop. A dev server listens before its first page compiles, and a cold compile can take
/// several seconds, so a port that is not HTTP yet gets more chances.
pub fn next_probe(done: usize, found: &Probe) -> Option<Duration> {
    if found.protocol != RuntimeProtocol::Tcp {
        return None;
    }
    PROBE_RETRIES.get(done.checked_sub(1)?).copied()
}

/// Runs the command and gives it a deadline. `Ok(None)` means that the command
/// did not answer and Tomo killed it. The caller gets the standard output.
pub fn output_within(mut command: Command, deadline: Duration) -> std::io::Result<Option<Vec<u8>>> {
    let child = command.stdout(Stdio::piped()).spawn()?;
    let pid = child.id();
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || tx.send(child.wait_with_output()));
    match rx.recv_timeout(deadline) {
        Ok(done) => done.map(|out| Some(out.stdout)),
        Err(_) => {
            // SIGKILL, because a call that hangs in the kernel does not answer a polite signal.
            unsafe { libc::kill(pid as i32, libc::SIGKILL) };
            Ok(None)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ep(pid: u32, port: u16, wt: &str) -> RuntimeEndpoint {
        RuntimeEndpoint {
            id: format!("{pid}:{port}"),
            worktree_id: wt.into(),
            pane_id: Some("p".into()),
            action_id: None,
            pid,
            process: "node".into(),
            protocol: RuntimeProtocol::Tcp,
            status: None,
            probing: false,
            host: "localhost".into(),
            port,
            label: None,
            discovered_at_ms: 0,
            source: None,
        }
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
    fn output_within_reads_an_answer_and_kills_a_command_that_gives_none() {
        let mut echo = Command::new("echo");
        echo.arg("hi");
        assert_eq!(output_within(echo, Duration::from_secs(5)).unwrap(), Some(b"hi\n".to_vec()));
        let mut slow = Command::new("sleep");
        slow.arg("30");
        let started = std::time::Instant::now();
        assert_eq!(output_within(slow, Duration::from_millis(200)).unwrap(), None, "a command that does not answer gives None");
        assert!(started.elapsed() < Duration::from_secs(2), "the deadline returns; it does not wait for the command");
        assert!(output_within(Command::new("tomo-no-such-program"), Duration::from_secs(1)).is_err());
    }

    /// A server that answers each connection with `reply` after `delay`.
    fn serve(reply: &'static [u8], delay: Duration) -> u16 {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            for mut s in listener.incoming().flatten() {
                std::thread::sleep(delay);
                let _ = s.write_all(reply);
            }
        });
        port
    }

    #[test]
    fn probe_reads_the_status_and_tells_http_from_tcp() {
        let ok = serve(b"HTTP/1.0 200 OK\r\n\r\n", Duration::ZERO);
        let missing = serve(b"HTTP/1.1 404 Not Found\r\n\r\n", Duration::ZERO);
        let tcp = serve(b"hello\n", Duration::ZERO);
        assert_eq!(probe("127.0.0.1", ok), Probe { protocol: RuntimeProtocol::Http, status: Some(200) });
        assert_eq!(probe("127.0.0.1", missing), Probe { protocol: RuntimeProtocol::Http, status: Some(404) });
        assert_eq!(probe("127.0.0.1", tcp), Probe::TCP);
        assert_eq!(probe("127.0.0.1", 1), Probe::TCP);
    }

    #[test]
    fn probe_waits_for_a_slow_first_reply() {
        let slow = serve(b"HTTP/1.1 307 Temporary Redirect\r\n\r\n", Duration::from_millis(600));
        assert_eq!(probe("127.0.0.1", slow).status, Some(307), "a dev server that takes 600 ms to answer is still HTTP");
    }

    #[test]
    fn parse_status_reads_the_code_of_a_status_line() {
        assert_eq!(parse_status(b"HTTP/1.1 307 Temporary Redirect\r\n"), Some(307));
        assert_eq!(parse_status(b"HTTP/1.0 200 OK"), Some(200));
        assert_eq!(parse_status(b"HTTP/2 404"), Some(404));
        assert_eq!(parse_status(b"SSH-2.0-OpenSSH"), None);
        assert_eq!(parse_status(b"HTTP/"), None);
    }

    #[test]
    fn next_probe_backs_off_until_http_or_the_last_retry() {
        let http = Probe { protocol: RuntimeProtocol::Http, status: Some(200) };
        let waits: Vec<Option<Duration>> = (1..=PROBE_RETRIES.len() + 1).map(|done| next_probe(done, &Probe::TCP)).collect();
        assert_eq!(waits, [PROBE_RETRIES.map(Some).as_slice(), &[None]].concat(), "every retry in order, then stop");
        assert_eq!(next_probe(1, &http), None, "the first HTTP answer stops the probe");
        assert_eq!(next_probe(0, &Probe::TCP), None);
    }

    #[test]
    fn probe_reaches_an_ipv6_host_in_the_brackets_that_lsof_writes() {
        let Ok(http) = std::net::TcpListener::bind("[::1]:0") else { return };
        let port = http.local_addr().unwrap().port();
        std::thread::spawn(move || {
            let (mut s, _) = http.accept().unwrap();
            let _ = s.write_all(b"HTTP/1.1 200 OK\r\n\r\n");
        });
        assert_eq!(probe("[::1]", port).protocol, RuntimeProtocol::Http);
    }
}
