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
    Deploy {
        path: PathBuf,
        /// Opaque return-address the supervisor relays back via the live
        /// worker's [`ReadyAck`]; `None` for clients that read the reply
        /// synchronously. The supervisor never interprets it.
        #[serde(default)]
        report_to: Option<String>,
    },
    Rollback,
    Status,
    Stop,
    Ready {
        token: String,
    },
}

/// The supervisor's reply to a control [`Request`]. `ready` gets a [`ReadyAck`].
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum Response {
    Ok { detail: String },
    Status(StatusReport),
    Error { message: String },
}

/// The supervisor's reply to a worker's `ready` ping: an optional deploy report
/// for the live worker to surface to the deploy's initiator.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReadyAck {
    #[serde(default)]
    pub report: Option<DeployReport>,
}

/// A deploy outcome for the live worker to deliver to the initiator: the opaque
/// `report_to` from the `Deploy` request plus human-readable `text`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeployReport {
    pub report_to: String,
    pub text: String,
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deploy_without_report_to_deserializes() {
        // The pre-relay wire shape (and the CLI / e2e harness) omits report_to.
        let req: Request = serde_json::from_str(r#"{"cmd":"deploy","path":"/x"}"#).unwrap();
        match req {
            Request::Deploy { path, report_to } => {
                assert_eq!(path, PathBuf::from("/x"));
                assert_eq!(report_to, None);
            }
            other => panic!("expected Deploy, got {other:?}"),
        }
    }

    #[test]
    fn deploy_with_report_to_roundtrips() {
        let req = Request::Deploy {
            path: PathBuf::from("/x"),
            report_to: Some("12345".to_owned()),
        };
        let wire = serde_json::to_string(&req).unwrap();
        match serde_json::from_str::<Request>(&wire).unwrap() {
            Request::Deploy { path, report_to } => {
                assert_eq!(path, PathBuf::from("/x"));
                assert_eq!(report_to.as_deref(), Some("12345"));
            }
            other => panic!("expected Deploy, got {other:?}"),
        }
    }

    #[test]
    fn ready_ack_roundtrips() {
        let ack = ReadyAck {
            report: Some(DeployReport {
                report_to: "999".to_owned(),
                text: "deployed v1".to_owned(),
            }),
        };
        let back: ReadyAck = serde_json::from_str(&serde_json::to_string(&ack).unwrap()).unwrap();
        let report = back.report.expect("report present");
        assert_eq!(report.report_to, "999");
        assert_eq!(report.text, "deployed v1");

        // An older worker / empty object yields no report rather than failing.
        let empty: ReadyAck = serde_json::from_str("{}").unwrap();
        assert!(empty.report.is_none());
    }
}
