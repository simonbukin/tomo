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
