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

pub struct Spawn<'a> {
    pub program: &'a str,
    pub args: &'a [String],
    pub cwd: &'a Path,
    pub env: &'a [(String, String)],
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
    fn spawns_shell_and_reads_output() {
        let (tx, rx) = std::sync::mpsc::channel::<Vec<u8>>();
        let (etx, erx) = std::sync::mpsc::channel::<Option<i32>>();
        let sink: OutputSink = Arc::new(move |b: &[u8]| {
            let _ = tx.send(b.to_vec());
        });
        let args = vec!["-c".to_string(), "printf hello-tomo; exit 3".to_string()];
        let session = PtySession::spawn(
            Spawn { program: "/bin/sh", args: &args, cwd: Path::new("/"), env: &[], cols: 80, rows: 24 },
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
}
