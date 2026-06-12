//! RPC client for an `omp --mode rpc` child: spawns the process, frames
//! newline-delimited JSON over its stdio, sends drive commands, and forwards
//! the session event stream.
//!
//! One reader task owns stdout: it answers the startup `ready` frame, resolves
//! command responses by `id`, and forwards [`OmpEvent`]s on a channel. Commands
//! register a pending oneshot before writing, so a response can never race ahead
//! of its waiter. The process is killed if the client is dropped without
//! [`OmpClient::shutdown`].

use std::{collections::HashMap, path::PathBuf, process::Stdio, sync::Arc, time::Duration};

use color_eyre::eyre::{WrapErr, eyre};
use parking_lot::Mutex;
use tokio::{
    io::{AsyncBufReadExt, BufReader},
    process::{Child, ChildStderr, ChildStdin, ChildStdout, Command as ProcCommand},
    sync::{Mutex as AsyncMutex, mpsc, oneshot},
};

use crate::omp::protocol::{Command, Inbound, OmpEvent, RequestId, RpcResponse};

const READY_TIMEOUT: Duration = Duration::from_secs(30);

const SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(5);

const RESPONSE_TIMEOUT: Duration = Duration::from_secs(30);

type Pending = Arc<Mutex<HashMap<RequestId, oneshot::Sender<RpcResponse>>>>;

/// Spawn parameters for an `omp --mode rpc` child.
///
/// Provider auth is intentionally absent: omp owns it (its own credential
/// store, or any provider env var the child inherits from the worker).
#[derive(Debug, Default, Clone)]
pub struct SpawnConfig {
    pub model: Option<String>,
    pub cwd: Option<PathBuf>,
}

/// A live connection to one `omp --mode rpc` process.
pub struct OmpClient {
    child: Child,
    stdin: AsyncMutex<ChildStdin>,
    pending: Pending,
}

impl OmpClient {
    /// Spawn `omp --mode rpc`, wait for its `ready` frame, and return the client
    /// alongside the session event stream. Errors if the binary cannot be
    /// spawned or it exits / stalls before reporting ready.
    pub async fn spawn(config: &SpawnConfig) -> color_eyre::Result<(OmpClient, mpsc::UnboundedReceiver<OmpEvent>)> {
        let mut cmd = ProcCommand::new("omp");
        cmd.arg("--mode").arg("rpc");
        if let Some(model) = &config.model {
            cmd.arg("--model").arg(model);
        }
        if let Some(cwd) = &config.cwd {
            cmd.arg("--cwd").arg(cwd);
        }
        cmd.stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);

        let mut child = cmd.spawn().wrap_err("spawn `omp --mode rpc`")?;
        let stdin = child.stdin.take().ok_or_else(|| eyre!("omp child has no stdin"))?;
        let stdout = child.stdout.take().ok_or_else(|| eyre!("omp child has no stdout"))?;
        let stderr = child.stderr.take().ok_or_else(|| eyre!("omp child has no stderr"))?;

        let pending: Pending = Arc::new(Mutex::new(HashMap::new()));
        // Unbounded so the reader never blocks on a send: it is the sole resolver
        // of command responses, so blocking here would deadlock a concurrent abort.
        let (event_tx, event_rx) = mpsc::unbounded_channel();
        let (ready_tx, ready_rx) = oneshot::channel();

        tokio::spawn(drain_stderr(stderr));
        tokio::spawn(read_loop(stdout, Arc::clone(&pending), event_tx, ready_tx));

        match tokio::time::timeout(READY_TIMEOUT, ready_rx).await {
            Ok(Ok(())) => tracing::debug!(model = ?config.model, "omp --mode rpc ready"),
            Ok(Err(_)) => {
                let _ = child.start_kill();
                return Err(eyre!("omp exited before sending its ready frame"));
            }
            Err(_) => {
                let _ = child.start_kill();
                return Err(eyre!("omp did not send a ready frame within {READY_TIMEOUT:?}"));
            }
        }

        let client = OmpClient {
            child,
            stdin: AsyncMutex::new(stdin),
            pending,
        };
        Ok((client, event_rx))
    }

    /// Send a prompt. Returns once OMP acks it; the reply arrives as a sequence
    /// of [`OmpEvent`]s terminated by [`OmpEvent::AgentEnd`] (or
    /// [`OmpEvent::Error`] on an async failure).
    pub async fn prompt(&self, message: &str) -> color_eyre::Result<()> {
        let id = RequestId::new();
        self.dispatch(&id, &Command::Prompt { id: &id, message }).await
    }

    /// Queue a steering message that interrupts the in-flight turn.
    pub async fn steer(&self, message: &str) -> color_eyre::Result<()> {
        let id = RequestId::new();
        self.dispatch(&id, &Command::Steer { id: &id, message }).await
    }

    /// Queue a follow-up message delivered after the in-flight turn completes.
    pub async fn follow_up(&self, message: &str) -> color_eyre::Result<()> {
        let id = RequestId::new();
        self.dispatch(&id, &Command::FollowUp { id: &id, message }).await
    }

    pub async fn abort(&self) -> color_eyre::Result<()> {
        let id = RequestId::new();
        self.dispatch(&id, &Command::Abort { id: &id }).await
    }

    /// Start a fresh session, discarding the current conversation.
    pub async fn new_session(&self) -> color_eyre::Result<()> {
        let id = RequestId::new();
        self.dispatch(&id, &Command::NewSession { id: &id }).await
    }

    /// Switch the active model for subsequent turns.
    pub async fn set_model(&self, provider: &str, model_id: &str) -> color_eyre::Result<()> {
        let id = RequestId::new();
        self.dispatch(
            &id,
            &Command::SetModel {
                id: &id,
                provider,
                model_id,
            },
        )
        .await
    }

    /// Close stdin (OMP exits cleanly on EOF) and reap the process, killing it
    /// if it does not exit within [`SHUTDOWN_TIMEOUT`].
    pub async fn shutdown(self) -> color_eyre::Result<()> {
        let OmpClient { mut child, stdin, .. } = self;
        drop(stdin);
        match tokio::time::timeout(SHUTDOWN_TIMEOUT, child.wait()).await {
            Ok(Ok(status)) => {
                tracing::debug!(%status, "omp exited");
                Ok(())
            }
            Ok(Err(e)) => Err(e).wrap_err("wait for omp to exit"),
            Err(_) => {
                let _ = child.start_kill();
                tracing::warn!("omp did not exit within {SHUTDOWN_TIMEOUT:?}; killed");
                Ok(())
            }
        }
    }

    /// `id` must equal the command's `id` field so the response correlates.
    async fn dispatch(&self, id: &RequestId, cmd: &Command<'_>) -> color_eyre::Result<()> {
        let (tx, rx) = oneshot::channel();
        self.pending.lock().insert(id.clone(), tx);
        tracing::debug!(command = cmd.kind(), %id, "sending omp command");

        let write = {
            let mut stdin = self.stdin.lock().await;
            pico_shared::proto::write_frame(&mut *stdin, cmd).await
        };
        if let Err(e) = write {
            self.pending.lock().remove(id);
            return Err(e).wrap_err("write omp command");
        }

        let resp = match tokio::time::timeout(RESPONSE_TIMEOUT, rx).await {
            Ok(Ok(resp)) => resp,
            Ok(Err(_)) => return Err(eyre!("omp exited before responding to `{id}`")),
            Err(_) => {
                self.pending.lock().remove(id);
                return Err(eyre!("omp did not respond to `{id}` within {RESPONSE_TIMEOUT:?}"));
            }
        };
        if resp.success {
            Ok(())
        } else {
            let detail = resp
                .error
                .as_deref()
                .unwrap_or("omp reported failure without a message");
            Err(eyre!("omp `{}` failed: {detail}", resp.command))
        }
    }
}

/// Drains OMP's stdout until EOF or a fatal read error, then drops all pending
/// waiters so in-flight commands fail instead of hanging.
async fn read_loop(
    stdout: ChildStdout,
    pending: Pending,
    event_tx: mpsc::UnboundedSender<OmpEvent>,
    ready_tx: oneshot::Sender<()>,
) {
    let mut reader = BufReader::new(stdout);
    let mut line = String::new();
    let mut ready_tx = Some(ready_tx);

    loop {
        line.clear();
        match reader.read_line(&mut line).await {
            Ok(0) => break,
            Ok(_) => {}
            Err(e) => {
                tracing::warn!(error = %e, "omp stdout read error");
                break;
            }
        }
        let trimmed = line.trim_end();
        if trimmed.is_empty() {
            continue;
        }
        let frame: Inbound = match serde_json::from_str(trimmed) {
            Ok(frame) => frame,
            Err(e) => {
                tracing::warn!(error = %e, bytes = trimmed.len(), "omp: undecodable frame");
                tracing::debug!(frame = %trimmed, "omp: undecodable frame contents");
                continue;
            }
        };

        match frame {
            Inbound::Ready => {
                if let Some(tx) = ready_tx.take() {
                    let _ = tx.send(());
                }
            }
            Inbound::Response(resp) => {
                let waiter = resp.id.as_ref().and_then(|id| pending.lock().remove(id));
                match waiter {
                    Some(tx) => {
                        let _ = tx.send(resp);
                    }
                    // A response with no waiter is an async failure delivered
                    // after the command was already acked (e.g. a prompt the
                    // model later rejected). Surface failures; ignore stray oks.
                    None if !resp.success => {
                        let msg = resp.error.unwrap_or_else(|| format!("omp `{}` failed", resp.command));
                        let _ = event_tx.send(OmpEvent::Error(msg));
                    }
                    None => tracing::debug!(command = %resp.command, "omp: response with no waiter"),
                }
            }
            Inbound::AgentStart => {
                let _ = event_tx.send(OmpEvent::AgentStart);
            }
            Inbound::AgentEnd => {
                let _ = event_tx.send(OmpEvent::AgentEnd);
            }
            Inbound::MessageUpdate {
                assistant_message_event,
            } => {
                let _ = event_tx.send(OmpEvent::Message(assistant_message_event));
            }
            Inbound::ToolExecutionStart(tool) => {
                let _ = event_tx.send(OmpEvent::ToolStart(tool));
            }
            Inbound::ToolExecutionEnd(tool) => {
                let _ = event_tx.send(OmpEvent::ToolEnd(tool));
            }
            Inbound::Unknown => {}
        }
    }

    pending.lock().clear();
}

/// Forward OMP's stderr to the log so a full pipe can never block the child.
async fn drain_stderr(stderr: ChildStderr) {
    let mut reader = BufReader::new(stderr);
    let mut line = String::new();
    loop {
        line.clear();
        match reader.read_line(&mut line).await {
            Ok(0) | Err(_) => break,
            Ok(_) => tracing::debug!(target: "omp_stderr", "{}", line.trim_end()),
        }
    }
}
