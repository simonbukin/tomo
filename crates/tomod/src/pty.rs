use crate::holder::{self, Frame, HolderSpec};
use anyhow::{Context, Result};
use std::io::Write;
use std::os::unix::net::UnixStream;
use std::path::Path;
use std::sync::{Arc, Mutex};

pub const SCROLLBACK_CAP: usize = 1024 * 1024;

#[derive(Default)]
pub struct Scrollback {
    bytes: Vec<u8>,
}

impl Scrollback {
    pub fn from_bytes(bytes: Vec<u8>) -> Self {
        let mut s = Scrollback { bytes };
        s.trim();
        s
    }

    pub fn push(&mut self, chunk: &[u8]) {
        self.bytes.extend_from_slice(chunk);
        self.trim();
    }

    fn trim(&mut self) {
        if self.bytes.len() > SCROLLBACK_CAP + SCROLLBACK_CAP / 4 {
            let excess = self.bytes.len() - SCROLLBACK_CAP;
            self.bytes.drain(..excess);
        }
    }

    pub fn snapshot(&self) -> Vec<u8> {
        self.bytes.clone()
    }

    pub fn plain_tail(&self, lines: usize) -> Vec<String> {
        plain_tail(&self.bytes, lines)
    }
}

const TAIL_WINDOW: usize = 64 * 1024;

/// The last `lines` non-empty lines as plain text. Escape sequences are removed and
/// carriage returns and backspaces overwrite, as a terminal would show a line.
pub fn plain_tail(bytes: &[u8], lines: usize) -> Vec<String> {
    let window = match bytes.len().checked_sub(TAIL_WINDOW) {
        Some(start) => bytes[start..].iter().position(|&b| b == b'\n').map_or(&[][..], |nl| &bytes[start + nl + 1..]),
        None => bytes,
    };
    let text = String::from_utf8_lossy(&strip_escapes(window)).into_owned();
    let rendered: Vec<String> = text.split('\n').map(render_line).filter(|l| !l.is_empty()).collect();
    rendered[rendered.len().saturating_sub(lines)..].to_vec()
}

fn render_line(raw: &str) -> String {
    let mut cells: Vec<char> = Vec::new();
    let mut cursor = 0usize;
    for c in raw.chars() {
        match c {
            '\r' => cursor = 0,
            '\u{8}' => cursor = cursor.saturating_sub(1),
            c if cursor < cells.len() => {
                cells[cursor] = c;
                cursor += 1;
            }
            c => {
                cells.push(c);
                cursor += 1;
            }
        }
    }
    cells.into_iter().collect::<String>().trim_end().to_string()
}

fn strip_escapes(bytes: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        let b = bytes[i];
        if b != 0x1b {
            if b >= 0x20 || matches!(b, b'\n' | b'\r' | b'\t' | 0x08) {
                out.push(if b == b'\t' { b' ' } else { b });
            }
            i += 1;
            continue;
        }
        let rest = &bytes[i + 1..];
        let (len, replacement): (usize, &[u8]) = match rest.first() {
            Some(b'[') => match rest.iter().skip(1).position(|c| (0x40..=0x7e).contains(c)) {
                Some(p) => (p + 3, if rest[p + 1] == b'C' { b" " } else { b"" }),
                None => (bytes.len() - i, b""),
            },
            Some(b']') | Some(b'P') | Some(b'X') | Some(b'^') | Some(b'_') => {
                let body = &rest[1..];
                let end = body.iter().enumerate().find_map(|(j, &c)| match c {
                    0x07 => Some(j + 1),
                    0x1b if body.get(j + 1) == Some(&b'\\') => Some(j + 2),
                    _ => None,
                });
                (end.map_or(bytes.len() - i, |e| e + 2), b"")
            }
            Some(b'(') | Some(b')') | Some(b'*') | Some(b'+') => (3, b""),
            Some(_) => (2, b""),
            None => (1, b""),
        };
        out.extend_from_slice(replacement);
        i = (i + len).min(bytes.len());
    }
    out
}

/// Removes escape sequences that ask the terminal to reply. Replaying them
/// on attach would make the client answer into a process that never asked.
pub fn strip_terminal_queries(bytes: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == 0x1b {
            if let Some(len) = query_len(&bytes[i..]) {
                i += len;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    out
}

fn query_len(b: &[u8]) -> Option<usize> {
    let rest = b.get(1..)?;
    match rest.first()? {
        b'[' => {
            let end = rest.iter().skip(1).take(24).position(|c| (0x40..=0x7e).contains(c))? + 2;
            let body = &rest[1..end - 1];
            let final_byte = rest[end - 1];
            let is_query = match final_byte {
                b'c' => body.is_empty() || body == b"0" || body == b">" || body == b"=" || body == b">0",
                b'n' => body == b"6" || body == b"?6" || body == b"5",
                b'p' => body.starts_with(b"?") && body.ends_with(b"$"),
                b'q' => body == b">",
                b'u' => body == b"?",
                b't' => body == b"14" || body == b"16" || body == b"18" || body == b"19",
                _ => false,
            };
            is_query.then_some(end + 1)
        }
        b']' => {
            let inner = &rest[1..];
            let st = inner
                .iter()
                .take(64)
                .position(|&c| c == 0x07)
                .map(|p| p + 1)
                .or_else(|| inner.windows(2).take(64).position(|w| w == b"\x1b\\").map(|p| p + 2))?;
            let body = &inner[..st];
            let is_query =
                body.starts_with(b"10;?") || body.starts_with(b"11;?") || body.starts_with(b"12;?") || body.starts_with(b"4;") && body.contains(&b'?');
            is_query.then_some(1 + 1 + st)
        }
        b'P' => {
            let inner = &rest[1..];
            if !inner.starts_with(b"+q") && !inner.starts_with(b"$q") {
                return None;
            }
            let st = inner.windows(2).take(256).position(|w| w == b"\x1b\\")?;
            Some(1 + 1 + st + 2)
        }
        _ => None,
    }
}

pub struct Spawn<'a> {
    pub program: &'a str,
    pub args: &'a [String],
    pub cwd: &'a Path,
    pub env: &'a [(String, String)],
    pub env_remove: &'a [String],
    pub cols: u16,
    pub rows: u16,
}

pub type OutputSink = Arc<dyn Fn(&[u8]) + Send + Sync>;
pub type ExitSink = Box<dyn FnOnce(Option<i32>) + Send>;

/// A pane's terminal. The child runs under a holder process (see `holder.rs`), so the session is a
/// connection to that holder: dropping it leaves the child running, and `hangup` ends it.
pub struct PtySession {
    pub pid: u32,
    conn: Mutex<UnixStream>,
    /// Set by `detach`: the connection ends because this daemon leaves, not because the child exited.
    detached: Arc<std::sync::atomic::AtomicBool>,
}

/// Starts a holder for `spec` and waits until it listens. Tests run the same server in a thread,
/// because a test binary cannot serve as `tomod pty-holder`.
fn start_holder(spec: &HolderSpec) -> Result<()> {
    if cfg!(test) {
        let (tx, rx) = std::sync::mpsc::channel();
        let spec = spec.clone();
        std::thread::spawn(move || {
            let failed = holder::run(&spec, |_| {
                let _ = tx.send(Ok(()));
            });
            if let Err(e) = failed {
                let _ = tx.send(Err(e));
            }
        });
        return rx.recv().context("the holder thread stopped")?;
    }
    let mut child = std::process::Command::new(std::env::current_exe().context("find tomod")?)
        .arg("pty-holder")
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .context("start pty-holder")?;
    child.stdin.take().context("holder stdin")?.write_all(&serde_json::to_vec(spec)?)?;
    let out = child.wait_with_output()?;
    if !out.status.success() {
        anyhow::bail!("{}", String::from_utf8_lossy(&out.stderr).trim());
    }
    Ok(())
}

impl PtySession {
    /// Starts `spec` under a new holder at `socket`. The bytes it printed before the attach come back with the session.
    pub fn spawn(spec: Spawn<'_>, socket: &Path, on_output: OutputSink, on_exit: ExitSink) -> Result<(Self, Vec<u8>)> {
        let holder_spec = HolderSpec {
            socket: socket.to_path_buf(),
            program: spec.program.to_string(),
            args: spec.args.to_vec(),
            cwd: spec.cwd.to_path_buf(),
            env: spec.env.to_vec(),
            env_remove: spec.env_remove.to_vec(),
            cols: spec.cols,
            rows: spec.rows,
        };
        start_holder(&holder_spec)?;
        Self::connect(socket, false, on_output, on_exit)
    }

    /// Connects to the live holder at `socket`. It returns the holder's output ring for the caller to replay, because
    /// the caller holds the lock that `on_output` takes. Output after the ring goes to `on_output` in order.
    /// A holder whose child already exited is an error: that pane is gone, and the caller restores it instead.
    pub fn attach(socket: &Path, on_output: OutputSink, on_exit: ExitSink) -> Result<(Self, Vec<u8>)> {
        Self::connect(socket, true, on_output, on_exit)
    }

    fn connect(socket: &Path, only_alive: bool, on_output: OutputSink, on_exit: ExitSink) -> Result<(Self, Vec<u8>)> {
        let mut conn = UnixStream::connect(socket).with_context(|| format!("connect {}", socket.display()))?;
        conn.set_read_timeout(Some(std::time::Duration::from_secs(5)))?;
        holder::write_frame(&mut conn, &Frame::Hello { version: holder::PROTOCOL })?;
        let (pid, alive) = match holder::read_frame(&mut conn)? {
            Some(Frame::Welcome { version, pid, alive }) if version == holder::PROTOCOL => (pid, alive),
            Some(Frame::Welcome { version, .. }) => anyhow::bail!("holder speaks protocol {version}, tomod speaks {}", holder::PROTOCOL),
            other => anyhow::bail!("expected welcome, got {other:?}"),
        };
        if only_alive && !alive {
            holder::write_frame(&mut conn, &Frame::Attach)?;
            let _ = holder::read_frame(&mut conn);
            let _ = holder::read_frame(&mut conn);
            let _ = holder::write_frame(&mut conn, &Frame::ExitSeen);
            anyhow::bail!("the pane's process exited while no daemon ran");
        }
        holder::write_frame(&mut conn, &Frame::Attach)?;
        let replay = match holder::read_frame(&mut conn)? {
            Some(Frame::Replay(bytes)) => bytes,
            other => anyhow::bail!("expected replay, got {other:?}"),
        };
        conn.set_read_timeout(None)?;
        let mut reader = conn.try_clone()?;
        let detached = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let left = detached.clone();
        std::thread::Builder::new().name(format!("pty-read-{pid}")).spawn(move || {
            let code = loop {
                match holder::read_frame(&mut reader) {
                    Ok(Some(Frame::Output(bytes))) => on_output(&bytes),
                    Ok(Some(Frame::Exit(code))) => {
                        let _ = holder::write_frame(&mut reader, &Frame::ExitSeen);
                        break code;
                    }
                    Ok(Some(_)) => {}
                    Ok(None) | Err(_) if left.load(std::sync::atomic::Ordering::SeqCst) => return,
                    Ok(None) | Err(_) => break None,
                }
            };
            on_exit(code);
        })?;
        Ok((PtySession { pid, conn: Mutex::new(conn), detached }, replay))
    }

    fn send(&self, frame: &Frame) -> Result<()> {
        holder::write_frame(&mut *self.conn.lock().unwrap_or_else(|p| p.into_inner()), frame).context("write to the pane holder")
    }

    pub fn write(&self, data: &[u8]) -> Result<()> {
        self.send(&Frame::Input(data.to_vec()))
    }

    pub fn resize(&self, cols: u16, rows: u16) -> Result<()> {
        self.send(&Frame::Resize { cols, rows })
    }

    /// Hangs up the terminal, as closing a terminal window does.
    pub fn hangup(&self) {
        let _ = self.send(&Frame::Close);
    }

    /// Hangs up the holder at `socket` without attaching, for a holder that no pane owns. It waits for the welcome
    /// first: a holder whose reply hits a closed socket stops before it reads the close.
    pub fn end_holder(socket: &Path) -> Result<()> {
        let mut conn = UnixStream::connect(socket)?;
        conn.set_read_timeout(Some(std::time::Duration::from_secs(2)))?;
        holder::write_frame(&mut conn, &Frame::Hello { version: holder::PROTOCOL })?;
        holder::read_frame(&mut conn)?;
        holder::write_frame(&mut conn, &Frame::Close)?;
        Ok(())
    }

    /// Ends the connection without touching the child: the pane lives on in its holder.
    pub fn detach(&self) {
        self.detached.store(true, std::sync::atomic::Ordering::SeqCst);
        let _ = self.conn.lock().unwrap_or_else(|p| p.into_inner()).shutdown(std::net::Shutdown::Both);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plain_tail_strips_escapes_and_applies_overwrites() {
        let out = b"\x1b]0;title\x07\x1b[1;32mready\x1b[0m on http://localhost:5173\r\n\r\n50%\r100%\r\nab\x08c\r\n\x1b(Bone\x1b[2Ctwo\x1bP+q\x1b\\\r\nwatching...  \r\n";
        assert_eq!(plain_tail(out, 8), ["ready on http://localhost:5173", "100%", "ac", "one two", "watching..."]);
        assert_eq!(plain_tail(out, 2), ["one two", "watching..."]);
        assert!(plain_tail(b"", 5).is_empty());
        assert_eq!(plain_tail(b"unterminated \x1b[12", 5), ["unterminated"]);
        let mut big = vec![b'x'; TAIL_WINDOW * 2];
        big.extend_from_slice(b"\nlast line\n");
        assert_eq!(plain_tail(&big, 3), ["last line"]);
    }

    #[test]
    fn scrollback_keeps_recent_tail() {
        let mut sb = Scrollback::default();
        sb.push(&vec![1u8; SCROLLBACK_CAP]);
        sb.push(&vec![2u8; SCROLLBACK_CAP / 2]);
        let snap = sb.snapshot();
        assert!(snap.len() <= SCROLLBACK_CAP + SCROLLBACK_CAP / 4);
        assert_eq!(*snap.last().unwrap(), 2);
    }

    #[test]
    fn strips_device_queries_but_keeps_ordinary_sequences() {
        let input = b"a\x1b[c\x1b[>c\x1b[6n\x1b[?2026$p\x1b[31mred\x1b[0m\x1b]11;?\x07\x1b]0;title\x07\x1bP+q544e\x1b\\z";
        let out = strip_terminal_queries(input);
        assert_eq!(out, b"a\x1b[31mred\x1b[0m\x1b]0;title\x07z");
    }

    fn sinks() -> (OutputSink, ExitSink, std::sync::mpsc::Receiver<Vec<u8>>, std::sync::mpsc::Receiver<Option<i32>>) {
        let (tx, rx) = std::sync::mpsc::channel::<Vec<u8>>();
        let (etx, erx) = std::sync::mpsc::channel::<Option<i32>>();
        let sink: OutputSink = Arc::new(move |b: &[u8]| {
            let _ = tx.send(b.to_vec());
        });
        (sink, Box::new(move |c| {
            let _ = etx.send(c);
        }), rx, erx)
    }

    fn socket(name: &str) -> std::path::PathBuf {
        std::path::PathBuf::from(format!("/private/tmp/tomo-pty-test-{}-{name}.sock", std::process::id()))
    }

    fn text_until(replay: Vec<u8>, rx: &std::sync::mpsc::Receiver<Vec<u8>>, needle: &str) -> String {
        let mut all = replay;
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while !String::from_utf8_lossy(&all).contains(needle) && std::time::Instant::now() < deadline {
            if let Ok(chunk) = rx.recv_timeout(std::time::Duration::from_millis(100)) {
                all.extend(chunk);
            }
        }
        String::from_utf8_lossy(&all).into_owned()
    }

    #[test]
    fn spawns_shell_and_reads_output() {
        let (sink, exit, rx, erx) = sinks();
        let args = vec!["-c".to_string(), "printf hello-tomo; exit 3".to_string()];
        let (session, replay) = PtySession::spawn(
            Spawn { program: "/bin/sh", args: &args, cwd: Path::new("/"), env: &[], env_remove: &[], cols: 80, rows: 24 },
            &socket("spawn"),
            sink,
            exit,
        )
        .unwrap();
        assert!(session.pid > 0);
        assert_eq!(erx.recv_timeout(std::time::Duration::from_secs(5)).unwrap(), Some(3));
        assert!(text_until(replay, &rx, "hello-tomo").contains("hello-tomo"));
    }

    #[test]
    fn a_pane_outlives_its_session_and_a_new_session_gets_its_output() {
        let (sink, exit, _rx, _erx) = sinks();
        let path = socket("reattach");
        let args = vec!["-c".to_string(), "printf before; read line; printf \"after-$line\"; exit 0".to_string()];
        let (first, _) = PtySession::spawn(Spawn { program: "/bin/sh", args: &args, cwd: Path::new("/"), env: &[], env_remove: &[], cols: 80, rows: 24 }, &path, sink, exit).unwrap();
        let pid = first.pid;
        first.detach();
        drop(first);

        let (sink, exit, rx, erx) = sinks();
        let (second, replay) = PtySession::attach(&path, sink, exit).unwrap();
        assert_eq!(second.pid, pid, "the same process, not a new one");
        assert!(text_until(replay.clone(), &rx, "before").contains("before"), "the ring replays what the first session saw");
        second.write(b"x\n").unwrap();
        assert!(text_until(Vec::new(), &rx, "after-x").contains("after-x"), "input reaches the child after a reattach");
        assert_eq!(erx.recv_timeout(std::time::Duration::from_secs(5)).unwrap(), Some(0));
    }

    #[test]
    fn a_detached_session_reports_no_exit() {
        let (sink, exit, _rx, erx) = sinks();
        let args = vec!["-c".to_string(), "sleep 30".to_string()];
        let (session, _) = PtySession::spawn(Spawn { program: "/bin/sh", args: &args, cwd: Path::new("/"), env: &[], env_remove: &[], cols: 80, rows: 24 }, &socket("detach-no-exit"), sink, exit).unwrap();
        session.detach();
        assert!(erx.recv_timeout(std::time::Duration::from_millis(500)).is_err(), "a daemon that leaves is not a pane that exited");
        session.hangup();
    }

    #[test]
    fn hangup_ends_the_child() {
        let (sink, exit, _rx, erx) = sinks();
        let args = vec!["-c".to_string(), "sleep 30".to_string()];
        let (session, _) = PtySession::spawn(Spawn { program: "/bin/sh", args: &args, cwd: Path::new("/"), env: &[], env_remove: &[], cols: 80, rows: 24 }, &socket("hangup"), sink, exit).unwrap();
        session.hangup();
        assert!(erx.recv_timeout(std::time::Duration::from_secs(5)).is_ok(), "the child exits after a hangup");
    }

    #[test]
    fn a_holder_that_was_closed_on_purpose_ends_without_waiting_for_an_exit_collection() {
        let (sink, exit, _rx, _erx) = sinks();
        let path = socket("closed");
        let args = vec!["-c".to_string(), "sleep 30".to_string()];
        let (session, _) = PtySession::spawn(Spawn { program: "/bin/sh", args: &args, cwd: Path::new("/"), env: &[], env_remove: &[], cols: 80, rows: 24 }, &path, sink, exit).unwrap();
        session.detach();
        PtySession::end_holder(&path).unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while path.exists() && std::time::Instant::now() < deadline {
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        assert!(!path.exists(), "the holder ended within seconds, not after the one-minute wait");
    }

    #[test]
    fn a_pane_that_exited_while_nobody_was_attached_is_not_reattached_and_its_holder_ends() {
        let (sink, exit, _rx, _erx) = sinks();
        let path = socket("late-exit");
        let args = vec!["-c".to_string(), "sleep 0.3; exit 7".to_string()];
        let (first, _) = PtySession::spawn(Spawn { program: "/bin/sh", args: &args, cwd: Path::new("/"), env: &[], env_remove: &[], cols: 80, rows: 24 }, &path, sink, exit).unwrap();
        first.detach();
        drop(first);
        std::thread::sleep(std::time::Duration::from_millis(800));
        assert!(path.exists(), "the holder waits for someone to collect the exit");
        let (sink, exit, _rx, _erx) = sinks();
        assert!(PtySession::attach(&path, sink, exit).is_err(), "a restore does not reattach a pane whose process is gone");
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while path.exists() && std::time::Instant::now() < deadline {
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        assert!(!path.exists(), "once the exit is collected, the holder ends and removes its socket");
    }

    #[test]
    fn torture_query_split_across_chunks_is_stripped_when_joined() {
        let whole = b"abc\x1b[6ndef";
        let mut joined = Vec::new();
        for chunk in [&whole[..5], &whole[5..]] {
            joined.extend_from_slice(chunk);
        }
        assert_eq!(strip_terminal_queries(&joined), b"abcdef");
        let dangling = b"abc\x1b[6";
        assert_eq!(strip_terminal_queries(dangling), dangling.to_vec(), "an incomplete sequence is left for the client to finish");
    }

    #[test]
    fn torture_scrollback_tail_is_bounded_and_contiguous() {
        let mut sb = Scrollback::default();
        let mut expected = Vec::new();
        for i in 0..40u8 {
            let chunk = vec![i; 64 * 1024];
            sb.push(&chunk);
            expected.extend_from_slice(&chunk);
        }
        let snap = sb.snapshot();
        assert!(snap.len() <= SCROLLBACK_CAP + SCROLLBACK_CAP / 4);
        assert!(snap.len() >= SCROLLBACK_CAP);
        assert_eq!(&expected[expected.len() - snap.len()..], &snap[..], "snapshot is exactly the most recent tail");
    }
}
