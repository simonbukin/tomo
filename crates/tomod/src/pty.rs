use anyhow::{Context, Result};
use portable_pty::{CommandBuilder, MasterPty, PtySize, native_pty_system};
use std::io::{Read, Write};
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
            let st = inner.iter().take(64).position(|&c| c == 0x07).map(|p| p + 1).or_else(|| inner.windows(2).take(64).position(|w| w == b"\x1b\\").map(|p| p + 2))?;
            let body = &inner[..st];
            let is_query = body.starts_with(b"10;?") || body.starts_with(b"11;?") || body.starts_with(b"12;?") || body.starts_with(b"4;") && body.contains(&b'?');
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

pub struct PtySession {
    pub pid: u32,
    master: Mutex<Box<dyn MasterPty + Send>>,
    writer: Mutex<Box<dyn Write + Send>>,
}

impl PtySession {
    pub fn spawn(spec: Spawn<'_>, on_output: OutputSink, on_exit: ExitSink) -> Result<Self> {
        let pty = native_pty_system();
        let pair = pty
            .openpty(PtySize { rows: spec.rows, cols: spec.cols, pixel_width: 0, pixel_height: 0 })
            .context("openpty")?;
        let mut cmd = CommandBuilder::new(spec.program);
        cmd.args(spec.args);
        cmd.cwd(spec.cwd);
        for k in spec.env_remove {
            cmd.env_remove(k);
        }
        for (k, v) in spec.env {
            cmd.env(k, v);
        }
        let mut child = pair.slave.spawn_command(cmd).context("spawn in pty")?;
        drop(pair.slave);
        let pid = child.process_id().context("child pid")?;
        let mut reader = pair.master.try_clone_reader().context("clone reader")?;
        let writer = pair.master.take_writer().context("take writer")?;

        std::thread::Builder::new().name(format!("pty-read-{pid}")).spawn(move || {
            let mut buf = vec![0u8; 16 * 1024];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => on_output(&buf[..n]),
                }
            }
        })?;
        std::thread::Builder::new().name(format!("pty-wait-{pid}")).spawn(move || {
            let code = child.wait().ok().map(|s| s.exit_code() as i32);
            on_exit(code);
        })?;

        Ok(PtySession {
            pid,
            master: Mutex::new(pair.master),
            writer: Mutex::new(writer),
        })
    }

    pub fn write(&self, data: &[u8]) -> Result<()> {
        let mut w = self.writer.lock().unwrap();
        w.write_all(data)?;
        w.flush()?;
        Ok(())
    }

    pub fn resize(&self, cols: u16, rows: u16) -> Result<()> {
        self.master
            .lock()
            .unwrap()
            .resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
            .context("resize pty")
    }

    pub fn hangup(&self) {
        unsafe {
            libc::kill(self.pid as i32, libc::SIGHUP);
        }
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

    #[test]
    fn spawns_shell_and_reads_output() {
        let (tx, rx) = std::sync::mpsc::channel::<Vec<u8>>();
        let (etx, erx) = std::sync::mpsc::channel::<Option<i32>>();
        let sink: OutputSink = Arc::new(move |b: &[u8]| {
            let _ = tx.send(b.to_vec());
        });
        let args = vec!["-c".to_string(), "printf hello-tomo; exit 3".to_string()];
        let session = PtySession::spawn(
            Spawn { program: "/bin/sh", args: &args, cwd: Path::new("/"), env: &[], env_remove: &[], cols: 80, rows: 24 },
            sink,
            Box::new(move |c| {
                let _ = etx.send(c);
            }),
        )
        .unwrap();
        assert!(session.pid > 0);
        let code = erx.recv_timeout(std::time::Duration::from_secs(5)).unwrap();
        assert_eq!(code, Some(3));
        let mut all = Vec::new();
        while let Ok(chunk) = rx.try_recv() {
            all.extend(chunk);
        }
        assert!(String::from_utf8_lossy(&all).contains("hello-tomo"));
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
