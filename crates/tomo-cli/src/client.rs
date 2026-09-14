use anyhow::{anyhow, bail, Context, Result};
use serde::de::DeserializeOwned;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::UnixStream;
use tokio::sync::Mutex;
use tomo_proto::*;

pub fn data_dir() -> PathBuf {
    std::env::var("TOMO_DATA_DIR").map(PathBuf::from).unwrap_or_else(|_| dirs::data_dir().unwrap_or_else(|| PathBuf::from(".")).join("tomo"))
}

pub fn socket_path() -> PathBuf {
    std::env::var("TOMO_SOCKET").map(PathBuf::from).unwrap_or_else(|_| data_dir().join("tomod.sock"))
}

pub fn daemon_binary() -> PathBuf {
    if let Ok(p) = std::env::var("TOMO_DAEMON_BIN") {
        return PathBuf::from(p);
    }
    if let Ok(exe) = std::env::current_exe() {
        let sibling = exe.with_file_name("tomod");
        if sibling.exists() {
            return sibling;
        }
    }
    PathBuf::from("tomod")
}

pub fn start_daemon() -> Result<()> {
    let bin = daemon_binary();
    let log = std::fs::OpenOptions::new().create(true).append(true).open(data_dir().join("tomod.log"));
    let stderr = log.map(std::process::Stdio::from).unwrap_or_else(|_| std::process::Stdio::null());
    let mut cmd = std::process::Command::new(&bin);
    cmd.stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(stderr);
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    cmd.spawn().with_context(|| format!("start {}", bin.display()))?;
    Ok(())
}

pub struct Client {
    writer: Mutex<tokio::net::unix::OwnedWriteHalf>,
    reader: Mutex<tokio::io::Lines<BufReader<tokio::net::unix::OwnedReadHalf>>>,
    next_id: AtomicU64,
}

impl Client {
    pub async fn connect() -> Result<Self> {
        let stream = UnixStream::connect(socket_path()).await?;
        let (rd, wr) = stream.into_split();
        let client = Client { writer: Mutex::new(wr), reader: Mutex::new(BufReader::new(rd).lines()), next_id: AtomicU64::new(1) };
        let _: Hello = client.call(Call::Hello { protocol: PROTOCOL_VERSION, client: format!("tomo-cli/{}", env!("CARGO_PKG_VERSION")) }).await?;
        Ok(client)
    }

    pub async fn connect_or_start() -> Result<Self> {
        if let Ok(c) = Self::connect().await {
            return Ok(c);
        }
        std::fs::create_dir_all(data_dir())?;
        start_daemon()?;
        for _ in 0..50 {
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            if let Ok(c) = Self::connect().await {
                return Ok(c);
            }
        }
        bail!("tomod did not start; see {}", data_dir().join("tomod.log").display())
    }

    pub async fn call<T: DeserializeOwned>(&self, call: Call) -> Result<T> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let req = Request { id, call };
        let mut line = serde_json::to_string(&req)?;
        line.push('\n');
        self.writer.lock().await.write_all(line.as_bytes()).await?;
        let mut reader = self.reader.lock().await;
        while let Some(text) = reader.next_line().await? {
            let frame: Frame = match serde_json::from_str(&text) {
                Ok(f) => f,
                Err(_) => continue,
            };
            match frame {
                Frame::Response { id: rid, result } if rid == id => return Ok(serde_json::from_value(result)?),
                Frame::Error { id: rid, error } if rid == id => bail!("{} ({:?})", error.message, error.code),
                _ => continue,
            }
        }
        Err(anyhow!("daemon closed the connection"))
    }
}
