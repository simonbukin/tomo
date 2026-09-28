//! The pane holder: a small process that owns one PTY, so a pane outlives a restart or a crash of tomod.
//! tomod starts it as `tomod pty-holder` and talks to it over one Unix socket per pane. See docs/pane-holder.md.
//!
//! The holder has no terminal emulator and no Tomo logic. It keeps the PTY master open, keeps the last
//! output in a ring, and reports the exit code of its child, which only it can wait for.

use anyhow::{anyhow, bail, Context, Result};
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use std::io::{Read, Write};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

/// The version in the handshake. A socket path never carries it, so a new tomod finds an old holder.
pub const PROTOCOL: u16 = 1;
const RING_CAP: usize = 2 * 1024 * 1024;
const MAX_FRAME: usize = 16 * 1024 * 1024;
/// How long a holder whose child exited waits for tomod to collect the exit code.
const UNCOLLECTED_EXIT_WAIT: Duration = Duration::from_secs(60);
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Debug, Clone, PartialEq)]
pub enum Frame {
    Hello { version: u16 },
    /// `alive` is false when the child exited before this client came.
    Welcome { version: u16, pid: u32, alive: bool },
    Attach,
    Replay(Vec<u8>),
    Output(Vec<u8>),
    Input(Vec<u8>),
    Resize { cols: u16, rows: u16 },
    Signal(i32),
    /// Closes the PTY master, so the kernel hangs up the child's session, as a closed terminal window does.
    Close,
    Exit(Option<i32>),
    /// The client has the exit code. Only this frame lets the holder finish: a write alone can land in a socket that is closing.
    ExitSeen,
}

fn kind_and_payload(frame: &Frame) -> (u8, Vec<u8>) {
    match frame {
        Frame::Hello { version } => (1, version.to_le_bytes().to_vec()),
        Frame::Welcome { version, pid, alive } => (2, [version.to_le_bytes().as_slice(), pid.to_le_bytes().as_slice(), &[u8::from(*alive)]].concat()),
        Frame::Attach => (3, vec![]),
        Frame::Replay(bytes) => (4, bytes.clone()),
        Frame::Output(bytes) => (5, bytes.clone()),
        Frame::Input(bytes) => (6, bytes.clone()),
        Frame::Resize { cols, rows } => (7, [cols.to_le_bytes(), rows.to_le_bytes()].concat()),
        Frame::Signal(sig) => (8, sig.to_le_bytes().to_vec()),
        Frame::Close => (9, vec![]),
        Frame::Exit(code) => (10, code.map_or(vec![0], |c| [[1u8].as_slice(), c.to_le_bytes().as_slice()].concat())),
        Frame::ExitSeen => (11, vec![]),
    }
}

pub fn encode(frame: &Frame) -> Vec<u8> {
    let (kind, payload) = kind_and_payload(frame);
    [[kind].as_slice(), (payload.len() as u32).to_le_bytes().as_slice(), &payload].concat()
}

fn u16_at(p: &[u8], i: usize) -> Result<u16> {
    Ok(u16::from_le_bytes(p.get(i..i + 2).ok_or_else(|| anyhow!("short frame"))?.try_into()?))
}

fn u32_at(p: &[u8], i: usize) -> Result<u32> {
    Ok(u32::from_le_bytes(p.get(i..i + 4).ok_or_else(|| anyhow!("short frame"))?.try_into()?))
}

fn decode(kind: u8, p: Vec<u8>) -> Result<Frame> {
    Ok(match kind {
        1 => Frame::Hello { version: u16_at(&p, 0)? },
        2 => Frame::Welcome { version: u16_at(&p, 0)?, pid: u32_at(&p, 2)?, alive: p.get(6) == Some(&1) },
        3 => Frame::Attach,
        4 => Frame::Replay(p),
        5 => Frame::Output(p),
        6 => Frame::Input(p),
        7 => Frame::Resize { cols: u16_at(&p, 0)?, rows: u16_at(&p, 2)? },
        8 => Frame::Signal(u32_at(&p, 0)? as i32),
        9 => Frame::Close,
        10 => Frame::Exit(match p.first() {
            Some(1) => Some(u32_at(&p, 1)? as i32),
            _ => None,
        }),
        11 => Frame::ExitSeen,
        other => bail!("unknown frame kind {other}"),
    })
}

/// Reads one frame. `Ok(None)` is a clean end of the stream.
pub fn read_frame(r: &mut impl Read) -> Result<Option<Frame>> {
    let mut head = [0u8; 5];
    match r.read_exact(&mut head) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(e) => return Err(e.into()),
    }
    let len = u32::from_le_bytes(head[1..5].try_into()?) as usize;
    if len > MAX_FRAME {
        bail!("frame of {len} bytes is too large");
    }
    let mut payload = vec![0u8; len];
    r.read_exact(&mut payload)?;
    decode(head[0], payload).map(Some)
}

pub fn write_frame(w: &mut impl Write, frame: &Frame) -> std::io::Result<()> {
    w.write_all(&encode(frame))
}

/// What a holder starts. tomod sends it as JSON on the holder's stdin.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HolderSpec {
    pub socket: PathBuf,
    pub program: String,
    pub args: Vec<String>,
    pub cwd: PathBuf,
    pub env: Vec<(String, String)>,
    pub env_remove: Vec<String>,
    pub cols: u16,
    pub rows: u16,
}

fn push_ring(ring: &mut Vec<u8>, bytes: &[u8]) {
    ring.extend_from_slice(bytes);
    if ring.len() > RING_CAP + RING_CAP / 4 {
        ring.drain(..ring.len() - RING_CAP);
    }
}

#[derive(Default)]
struct State {
    ring: Vec<u8>,
    client: Option<UnixStream>,
    exit: Option<Option<i32>>,
    exited_at: Option<Instant>,
    exit_collected: bool,
    /// Set by `Close`: the pane is being ended on purpose, so nobody waits for the exit code.
    closing: bool,
}

struct Shared {
    state: Mutex<State>,
    changed: Condvar,
    master: Mutex<Option<Box<dyn MasterPty + Send>>>,
    writer: Mutex<Option<Box<dyn Write + Send>>>,
    pid: u32,
}

impl Shared {
    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|p| p.into_inner())
    }

    fn send_to_client(state: &mut State, frame: &Frame) -> bool {
        let sent = state.client.as_mut().is_some_and(|c| write_frame(c, frame).is_ok());
        if !sent {
            state.client = None;
        }
        sent
    }

    fn close_terminal(&self) {
        self.writer.lock().unwrap_or_else(|p| p.into_inner()).take();
        self.master.lock().unwrap_or_else(|p| p.into_inner()).take();
    }

    /// The reader thread keeps its own copy of the master, so closing ours does not hang up the session.
    /// The child gets SIGHUP directly, as it did when tomod owned the terminal. Only a child that has not
    /// exited gets it: the pid of a reaped child can belong to another process already.
    fn hang_up(&self) {
        self.close_terminal();
        let mut state = self.lock();
        state.closing = true;
        self.changed.notify_all();
        if state.exit.is_none() {
            unsafe {
                libc::kill(self.pid as i32, libc::SIGHUP);
            }
        }
    }
}

fn spawn_child(spec: &HolderSpec) -> Result<(Box<dyn MasterPty + Send>, Box<dyn portable_pty::Child + Send + Sync>)> {
    let pair = native_pty_system().openpty(PtySize { rows: spec.rows, cols: spec.cols, pixel_width: 0, pixel_height: 0 }).context("openpty")?;
    let mut cmd = CommandBuilder::new(&spec.program);
    cmd.args(&spec.args);
    cmd.cwd(&spec.cwd);
    spec.env_remove.iter().for_each(|k| cmd.env_remove(k));
    spec.env.iter().for_each(|(k, v)| cmd.env(k, v));
    let child = pair.slave.spawn_command(cmd).context("spawn in pty")?;
    drop(pair.slave);
    Ok((pair.master, child))
}

fn serve_client(shared: &Shared, mut stream: UnixStream) -> Result<()> {
    stream.set_read_timeout(Some(HANDSHAKE_TIMEOUT))?;
    match read_frame(&mut stream)? {
        Some(Frame::Hello { .. }) => {
            let alive = shared.lock().exit.is_none();
            write_frame(&mut stream, &Frame::Welcome { version: PROTOCOL, pid: shared.pid, alive })?
        }
        other => bail!("expected hello, got {other:?}"),
    }
    match read_frame(&mut stream)? {
        Some(Frame::Attach) => {}
        Some(Frame::Close) => {
            shared.hang_up();
            return Ok(());
        }
        other => bail!("expected attach or close, got {other:?}"),
    }
    stream.set_read_timeout(None)?;
    {
        let mut state = shared.lock();
        write_frame(&mut stream, &Frame::Replay(state.ring.clone()))?;
        if let Some(code) = state.exit {
            write_frame(&mut stream, &Frame::Exit(code))?;
        } else {
            state.client = Some(stream.try_clone()?);
        }
    }
    while let Some(frame) = read_frame(&mut stream)? {
        match frame {
            Frame::Input(bytes) => {
                if let Some(w) = shared.writer.lock().unwrap_or_else(|p| p.into_inner()).as_mut() {
                    w.write_all(&bytes)?;
                    w.flush()?;
                }
            }
            Frame::Resize { cols, rows } => {
                if let Some(m) = shared.master.lock().unwrap_or_else(|p| p.into_inner()).as_ref() {
                    m.resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })?;
                }
            }
            Frame::Signal(sig) => {
                if shared.lock().exit.is_none() {
                    unsafe {
                        libc::kill(shared.pid as i32, sig);
                    }
                }
            }
            Frame::Close => shared.hang_up(),
            Frame::ExitSeen => {
                shared.lock().exit_collected = true;
                shared.changed.notify_all();
                return Ok(());
            }
            other => bail!("unexpected frame {other:?}"),
        }
    }
    Ok(())
}

/// Serves one pane until its child has exited and tomod has collected the exit code, or nobody came for it.
/// `ready` gets the child pid once the socket listens.
pub fn run(spec: &HolderSpec, ready: impl FnOnce(u32)) -> Result<()> {
    let _ = std::fs::remove_file(&spec.socket);
    if let Some(dir) = spec.socket.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let listener = UnixListener::bind(&spec.socket).with_context(|| format!("bind {}", spec.socket.display()))?;
    let (master, mut child) = spawn_child(spec)?;
    let pid = child.process_id().context("child pid")?;
    let mut reader = master.try_clone_reader()?;
    let writer = master.take_writer()?;
    let shared = Arc::new(Shared { state: Mutex::default(), changed: Condvar::new(), master: Mutex::new(Some(master)), writer: Mutex::new(Some(writer)), pid });

    let output = shared.clone();
    std::thread::spawn(move || {
        let mut buf = vec![0u8; 16 * 1024];
        while let Ok(n @ 1..) = reader.read(&mut buf) {
            let mut state = output.lock();
            push_ring(&mut state.ring, &buf[..n]);
            Shared::send_to_client(&mut state, &Frame::Output(buf[..n].to_vec()));
        }
    });
    let waiter = shared.clone();
    std::thread::spawn(move || {
        let code = child.wait().ok().map(|s| s.exit_code() as i32);
        let mut state = waiter.lock();
        state.exit = Some(code);
        state.exited_at = Some(Instant::now());
        Shared::send_to_client(&mut state, &Frame::Exit(code));
        waiter.changed.notify_all();
    });
    let accepting = shared.clone();
    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let serving = accepting.clone();
            std::thread::spawn(move || {
                let _ = serve_client(&serving, stream);
            });
        }
    });
    ready(pid);

    let mut state = shared.lock();
    loop {
        let done = state.exit_collected || (state.closing && state.exit.is_some()) || state.exited_at.is_some_and(|at| at.elapsed() >= UNCOLLECTED_EXIT_WAIT);
        if done {
            break;
        }
        state = shared.changed.wait_timeout(state, Duration::from_secs(1)).unwrap_or_else(|p| p.into_inner()).0;
    }
    drop(state);
    shared.close_terminal();
    let _ = std::fs::remove_file(&spec.socket);
    Ok(())
}

/// The `tomod pty-holder` entry point. It reads the spec on stdin, forks, and the first process exits once the
/// holder listens, so tomod waits for a clear result and never keeps a child. The holder leads its own session.
pub fn main() -> ! {
    let mut input = String::new();
    let spec: HolderSpec = match std::io::stdin().read_to_string(&mut input).map_err(anyhow::Error::from).and_then(|_| Ok(serde_json::from_str(&input)?)) {
        Ok(spec) => spec,
        Err(e) => {
            eprintln!("pty-holder: bad spec: {e}");
            std::process::exit(2);
        }
    };
    let mut fds = [0i32; 2];
    if unsafe { libc::pipe(fds.as_mut_ptr()) } != 0 {
        eprintln!("pty-holder: pipe failed");
        std::process::exit(2);
    }
    let (read_end, write_end) = (fds[0], fds[1]);
    match unsafe { libc::fork() } {
        -1 => {
            eprintln!("pty-holder: fork failed");
            std::process::exit(2);
        }
        0 => {
            unsafe {
                libc::close(read_end);
                libc::setsid();
                let null = libc::open(c"/dev/null".as_ptr(), libc::O_RDWR);
                [0, 1, 2].iter().for_each(|fd| {
                    libc::dup2(null, *fd);
                });
            }
            let report = |message: &str| unsafe {
                libc::write(write_end, message.as_ptr().cast(), message.len());
                libc::close(write_end);
            };
            let reported = std::cell::Cell::new(false);
            let result = run(&spec, |pid| {
                report(&format!("ok {pid}"));
                reported.set(true);
            });
            if let (Err(e), false) = (&result, reported.get()) {
                report(&format!("error {e:#}"));
            }
            std::process::exit(if result.is_ok() { 0 } else { 1 });
        }
        _ => {
            unsafe { libc::close(write_end) };
            let mut file = unsafe { <std::fs::File as std::os::fd::FromRawFd>::from_raw_fd(read_end) };
            let mut message = String::new();
            let _ = file.read_to_string(&mut message);
            match message.strip_prefix("ok ") {
                Some(_) => std::process::exit(0),
                None => {
                    eprintln!("pty-holder: {}", message.strip_prefix("error ").unwrap_or("the holder did not start"));
                    std::process::exit(1);
                }
            }
        }
    }
}

/// The socket of a pane's holder.
pub fn socket_path(dir: &Path, pane_id: &str) -> PathBuf {
    dir.join(format!("{pane_id}.sock"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_frame_survives_a_round_trip() {
        let frames = [
            Frame::Hello { version: PROTOCOL },
            Frame::Welcome { version: 1, pid: 4242, alive: true },
            Frame::Welcome { version: 1, pid: 1, alive: false },
            Frame::Attach,
            Frame::Replay(b"ring".to_vec()),
            Frame::Output(vec![0, 255, 27]),
            Frame::Input(b"ls\n".to_vec()),
            Frame::Resize { cols: 120, rows: 40 },
            Frame::Signal(libc::SIGHUP),
            Frame::Close,
            Frame::Exit(Some(3)),
            Frame::Exit(Some(-1)),
            Frame::Exit(None),
            Frame::ExitSeen,
        ];
        let bytes: Vec<u8> = frames.iter().flat_map(encode).collect();
        let mut reader = bytes.as_slice();
        let back: Vec<Frame> = std::iter::from_fn(|| read_frame(&mut reader).unwrap()).collect();
        assert_eq!(back, frames);
    }

    #[test]
    fn a_frame_that_claims_too_many_bytes_is_refused() {
        let mut head = vec![5u8];
        head.extend_from_slice(&((MAX_FRAME as u32) + 1).to_le_bytes());
        assert!(read_frame(&mut head.as_slice()).is_err());
    }

    #[test]
    fn the_ring_keeps_the_newest_bytes() {
        let mut ring = Vec::new();
        push_ring(&mut ring, &vec![1u8; RING_CAP]);
        push_ring(&mut ring, &vec![2u8; RING_CAP / 2]);
        assert!(ring.len() <= RING_CAP + RING_CAP / 4);
        assert_eq!(*ring.last().unwrap(), 2);
    }
}
