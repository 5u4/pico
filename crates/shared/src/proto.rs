use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncWrite, AsyncWriteExt};

/// A line-delimited JSON message from a client (or the worker) to the
/// supervisor's control socket.
///
/// Control clients send `deploy` / `rollback` / `status` / `stop`; a worker the
/// supervisor spawned sends `ready` (carrying the per-spawn token it was given)
/// once it is up, to validate a deploy.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "cmd", rename_all = "snake_case")]
pub enum Request {
    Deploy { path: PathBuf },
    Rollback,
    Status,
    Stop,
    Ready { token: String },
}

/// The supervisor's reply to a control [`Request`]. `ready` gets no reply.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum Response {
    Ok { detail: String },
    Status(StatusReport),
    Error { message: String },
}

/// Snapshot returned by `status`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StatusReport {
    pub running: bool,
    pub pid: Option<u32>,
    pub current: Option<String>,
    pub version: Option<String>,
    /// Per-artifact content hash; separates builds with an identical `version`.
    pub build: Option<String>,
    pub uptime_secs: Option<u64>,
    pub deploys: Vec<DeployRecord>,
}

/// One entry of the deploy history (`status` returns the last few).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeployRecord {
    pub target: String,
    pub build: Option<String>,
    pub outcome: String,
    pub at_unix: u64,
}

/// Read one newline-delimited JSON value. `Ok(None)` on a clean EOF before any
/// bytes, so callers can treat a closed connection as "no message".
pub async fn read_frame<T, R>(reader: &mut R) -> color_eyre::Result<Option<T>>
where
    T: serde::de::DeserializeOwned,
    R: AsyncBufRead + Unpin,
{
    let mut line = String::new();
    if reader.read_line(&mut line).await? == 0 {
        return Ok(None);
    }
    Ok(Some(serde_json::from_str(line.trim_end())?))
}

/// Write one value as a newline-delimited JSON frame and flush it.
pub async fn write_frame<T, W>(writer: &mut W, msg: &T) -> color_eyre::Result<()>
where
    T: Serialize,
    W: AsyncWrite + Unpin,
{
    let mut buf = serde_json::to_vec(msg)?;
    buf.push(b'\n');
    writer.write_all(&buf).await?;
    writer.flush().await?;
    Ok(())
}
