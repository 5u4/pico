use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncWrite, AsyncWriteExt};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "cmd", rename_all = "snake_case")]
pub enum Request {
    Deploy {
        path: PathBuf,
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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum Response {
    Ok { detail: String },
    Status(StatusReport),
    Error { message: String },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReadyAck {
    #[serde(default)]
    pub report: Option<DeployReport>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeployReport {
    pub report_to: String,
    pub text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StatusReport {
    pub running: bool,
    pub pid: Option<u32>,
    pub current: Option<String>,
    pub version: Option<String>,
    pub build: Option<String>,
    pub uptime_secs: Option<u64>,
    pub deploys: Vec<DeployRecord>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeployRecord {
    pub target: String,
    pub build: Option<String>,
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
    fn deploy_without_report_to_deserializes() {
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

        let empty: ReadyAck = serde_json::from_str("{}").unwrap();
        assert!(empty.report.is_none());
    }
}
