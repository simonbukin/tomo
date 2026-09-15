use crate::daemon::{Client, Daemon};
use std::collections::HashSet;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::{UnixListener, UnixStream};
use tomo_proto::*;

static NEXT_CLIENT: AtomicU64 = AtomicU64::new(1);

pub async fn serve(daemon: Arc<Daemon>, listener: UnixListener) {
    loop {
        match listener.accept().await {
            Ok((stream, _)) => {
                let id = NEXT_CLIENT.fetch_add(1, Ordering::Relaxed);
                tokio::spawn(handle_conn(daemon.clone(), id, stream));
            }
            Err(e) => {
                tracing::warn!("accept: {e}");
                tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            }
        }
    }
}

fn is_slow(call: &Call) -> bool {
    matches!(
        call,
        Call::RepoAdd { .. } | Call::RepoRemove { .. } | Call::RepoClone { .. } | Call::WorktreeRefresh | Call::WorktreeCreate(_) | Call::WorktreeArchive { .. } | Call::WorktreeRestore { .. } | Call::GitSummary { .. } | Call::PrStatus { .. } | Call::RuntimeList { .. } | Call::SystemStats
    )
}

async fn handle_conn(daemon: Arc<Daemon>, id: u64, stream: UnixStream) {
    let (rd, mut wr) = stream.into_split();
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<String>();
    daemon.lock().clients.insert(id, Client { tx: tx.clone(), subscribed: false, attached: HashSet::new() });
    let writer = tokio::spawn(async move {
        while let Some(line) = rx.recv().await {
            if wr.write_all(line.as_bytes()).await.is_err() || wr.write_all(b"\n").await.is_err() {
                break;
            }
        }
    });
    let mut lines = BufReader::with_capacity(256 * 1024, rd).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        if line.trim().is_empty() {
            continue;
        }
        let req: Request = match serde_json::from_str(&line) {
            Ok(r) => r,
            Err(e) => {
                let frame = Frame::Error { id: 0, error: RpcError { code: ErrorCode::BadRequest, message: format!("bad request: {e}") } };
                let _ = tx.send(serde_json::to_string(&frame).unwrap_or_default());
                continue;
            }
        };
        if is_slow(&req.call) {
            let d = daemon.clone();
            let tx = tx.clone();
            tokio::spawn(async move {
                let frame = to_frame(req.id, d.handle(id, req.call).await);
                let _ = tx.send(serde_json::to_string(&frame).unwrap_or_default());
            });
        } else {
            let frame = to_frame(req.id, daemon.handle(id, req.call).await);
            let _ = tx.send(serde_json::to_string(&frame).unwrap_or_default());
        }
    }
    daemon.lock().clients.remove(&id);
    writer.abort();
}

fn to_frame(id: u64, result: Result<serde_json::Value, RpcError>) -> Frame {
    match result {
        Ok(result) => Frame::Response { id, result },
        Err(error) => Frame::Error { id, error },
    }
}
