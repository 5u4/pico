use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncWrite, AsyncWriteExt};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "cmd", rename_all = "snake_case")]
pub enum Request {
    Deploy { path: PathBuf },
    Rollback,
    Status,
    Stop,
    Ready { token: String },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum Response {
    Ok { detail: String },
    Status(StatusReport),
    Error { message: String },
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ReadyAck {}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StatusReport {
    pub running: bool,
    pub pid: Option<u32>,
    pub current: Option<String>,
    pub version: Option<String>,
    pub uptime_secs: Option<u64>,
    pub deploys: Vec<DeployRecord>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeployRecord {
    pub target: String,
    pub outcome: String,
    pub at_unix: u64,
}

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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deploy_roundtrips() {
        let req: Request = serde_json::from_str(r#"{"cmd":"deploy","path":"/slots/a"}"#).unwrap();
        match req {
            Request::Deploy { path } => assert_eq!(path, PathBuf::from("/slots/a")),
            other => panic!("expected Deploy, got {other:?}"),
        }
    }

    #[test]
    fn ready_frame_matches_worker_wire() {
        let req: Request = serde_json::from_str(r#"{"cmd":"ready","token":"abc"}"#).unwrap();
        match req {
            Request::Ready { token } => assert_eq!(token, "abc"),
            other => panic!("expected Ready, got {other:?}"),
        }
    }

    #[test]
    fn ready_ack_serializes_to_empty_object() {
        assert_eq!(serde_json::to_string(&ReadyAck {}).unwrap(), "{}");
    }

    #[test]
    fn error_response_tagged() {
        let wire = serde_json::to_string(&Response::Error {
            message: "boom".into(),
        })
        .unwrap();
        assert_eq!(wire, r#"{"status":"error","message":"boom"}"#);
    }
}
