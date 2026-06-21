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
use tokio_util::{sync::CancellationToken, task::TaskTracker};

use crate::omp::protocol::{Command, Inbound, OmpEvent, RequestId, RpcResponse, UiResponse};

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
    pub session_dir: Option<PathBuf>,
    /// Pass `--continue` so a respawned child resumes the session-dir's
    /// existing session — transparent thread resume across idle-eviction and
    /// worker restart, since the session-dir is derived from the thread id.
    pub continue_session: bool,
    pub system_prompt: Option<PathBuf>,
    pub append_system_prompt: Option<PathBuf>,
    /// omp `--extension <path>` modules to load (the camofox browser tools when a
    /// profile enables the browser). Empty for a normal turn.
    pub extensions: Vec<PathBuf>,
    /// Extra environment for the child (the `CAMOFOX_*` wiring read by the
    /// extension). Empty otherwise.
    pub env: Vec<(String, String)>,
}

/// A live connection to one `omp --mode rpc` process.
pub struct OmpClient {
    child: Child,
    stdin: AsyncMutex<ChildStdin>,
    pending: Pending,
}

/// Build the `omp --mode rpc` command (split out from spawn to unit-test cwd wiring).
fn build_command(config: &SpawnConfig) -> ProcCommand {
    let mut cmd = ProcCommand::new("omp");
    // `rpc`, not `rpc-ui`: `hasUI` off drops omp's interactive `ask` tool (questions
    // become plain text); the `extension_ui_request` UI sub-protocol still works in `rpc`.
    cmd.arg("--mode").arg("rpc");
    if let Some(model) = &config.model {
        cmd.arg("--model").arg(model);
    }
    if let Some(cwd) = &config.cwd {
        // omp does not chdir to `--cwd`, so without this the child inherits the
        // worker's launch dir and the binding/guild-default cwd is ignored.
        cmd.current_dir(cwd);
        cmd.arg("--cwd").arg(cwd);
    }
    if let Some(session_dir) = &config.session_dir {
        cmd.arg("--session-dir").arg(session_dir);
    }
    if config.continue_session {
        cmd.arg("--continue");
    }
    if let Some(prompt) = &config.system_prompt {
        cmd.arg("--system-prompt").arg(prompt);
    }
    if let Some(prompt) = &config.append_system_prompt {
        cmd.arg("--append-system-prompt").arg(prompt);
    }
    for extension in &config.extensions {
        cmd.arg("--extension").arg(extension);
    }
    for (key, value) in &config.env {
        cmd.env(key, value);
    }
    cmd.stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    cmd
}

impl OmpClient {
    /// Spawn `omp --mode rpc`, wait for its `ready` frame, and return the client
    /// alongside the session event stream. Errors if the binary cannot be
    /// spawned or it exits / stalls before reporting ready. The stdout reader and
    /// stderr drain run on `tracker` and stop on `cancel`, so worker shutdown
    /// joins them instead of leaking detached tasks past the child's kill.
    pub async fn spawn(
        config: &SpawnConfig,
        cancel: &CancellationToken,
        tracker: &TaskTracker,
    ) -> color_eyre::Result<(OmpClient, mpsc::UnboundedReceiver<OmpEvent>)> {
        let mut cmd = build_command(config);

        let mut child = cmd.spawn().wrap_err("spawn `omp --mode rpc`")?;
        let stdin = child.stdin.take().ok_or_else(|| eyre!("omp child has no stdin"))?;
        let stdout = child.stdout.take().ok_or_else(|| eyre!("omp child has no stdout"))?;
        let stderr = child.stderr.take().ok_or_else(|| eyre!("omp child has no stderr"))?;

        let pending: Pending = Arc::new(Mutex::new(HashMap::new()));
        // Unbounded so the reader never blocks on a send: it is the sole resolver
        // of command responses, so blocking here would deadlock a concurrent abort.
        let (event_tx, event_rx) = mpsc::unbounded_channel();
        let (ready_tx, ready_rx) = oneshot::channel();

        tracker.spawn(drain_stderr(stderr, cancel.clone()));
        tracker.spawn(read_loop(stdout, Arc::clone(&pending), event_tx, ready_tx, cancel.clone()));

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

    /// Best-effort sync of omp's persisted session title to the Discord thread name.
    pub async fn set_session_name(&self, name: &str) -> color_eyre::Result<()> {
        let id = RequestId::new();
        self.dispatch(&id, &Command::SetSessionName { id: &id, name }).await
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

    /// Answer an [`OmpEvent::UiRequest`]: frame the reply onto stdin (no command
    /// response follows). Shares the stdin lock with [`dispatch`], so bytes never interleave.
    pub async fn ui_response(&self, response: &UiResponse<'_>) -> color_eyre::Result<()> {
        let mut stdin = self.stdin.lock().await;
        pico_shared::proto::write_frame(&mut *stdin, response)
            .await
            .wrap_err("write extension_ui_response")
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

/// Drains OMP's stdout until EOF, a read error, or `cancel`, then drops all
/// pending waiters so in-flight commands fail fast instead of hanging.
async fn read_loop(
    stdout: ChildStdout,
    pending: Pending,
    event_tx: mpsc::UnboundedSender<OmpEvent>,
    ready_tx: oneshot::Sender<()>,
    cancel: CancellationToken,
) {
    let mut reader = BufReader::new(stdout);
    let mut line = String::new();
    let mut ready_tx = Some(ready_tx);

    loop {
        line.clear();
        let read = tokio::select! {
            () = cancel.cancelled() => break,
            read = reader.read_line(&mut line) => read,
        };
        match read {
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
            Inbound::TurnEnd => {
                let _ = event_tx.send(OmpEvent::TurnEnd);
            }
            Inbound::MessageUpdate {
                assistant_message_event,
            } => {
                let _ = event_tx.send(OmpEvent::Message(assistant_message_event));
            }
            Inbound::ToolExecutionStart(tool) => {
                let _ = event_tx.send(OmpEvent::ToolStart(tool));
            }
            Inbound::ToolExecutionUpdate(tool) => {
                let _ = event_tx.send(OmpEvent::ToolUpdate(tool));
            }
            Inbound::ToolExecutionEnd(tool) => {
                let _ = event_tx.send(OmpEvent::ToolEnd(tool));
            }
            Inbound::ExtensionUiRequest(req) => {
                let _ = event_tx.send(OmpEvent::UiRequest(req));
            }
            Inbound::Unknown => {}
        }
    }

    pending.lock().clear();
}

/// Forward OMP's stderr to the log so a full pipe can never block the child.
async fn drain_stderr(stderr: ChildStderr, cancel: CancellationToken) {
    let mut reader = BufReader::new(stderr);
    let mut line = String::new();
    loop {
        line.clear();
        let read = tokio::select! {
            () = cancel.cancelled() => break,
            read = reader.read_line(&mut line) => read,
        };
        match read {
            Ok(0) | Err(_) => break,
            Ok(_) => tracing::debug!(target: "omp_stderr", "{}", line.trim_end()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn build_command_starts_child_in_configured_cwd() {
        let cwd = std::env::temp_dir().join("pico-cwd");
        let config = SpawnConfig {
            cwd: Some(cwd.clone()),
            ..SpawnConfig::default()
        };
        let cmd = build_command(&config);
        assert_eq!(cmd.as_std().get_current_dir(), Some(cwd.as_path()));
    }

    #[test]
    fn build_command_without_cwd_inherits_worker_dir() {
        let cmd = build_command(&SpawnConfig::default());
        assert_eq!(cmd.as_std().get_current_dir(), None);
    }

    #[test]
    fn build_command_injects_extensions_and_env() {
        let ext = std::path::PathBuf::from("/x/extension.ts");
        let config = SpawnConfig {
            extensions: vec![ext.clone()],
            env: vec![
                ("CAMOFOX_BASE_URL".to_owned(), "http://127.0.0.1:9377".to_owned()),
                ("CAMOFOX_USER_ID".to_owned(), "acme".to_owned()),
            ],
            ..SpawnConfig::default()
        };
        let cmd = build_command(&config);
        let std_cmd = cmd.as_std();
        let args: Vec<String> = std_cmd.get_args().map(|a| a.to_string_lossy().into_owned()).collect();
        let i = args
            .iter()
            .position(|a| a == "--extension")
            .expect("--extension arg present");
        assert_eq!(args[i + 1], ext.to_string_lossy());
        let envs: std::collections::HashMap<String, String> = std_cmd
            .get_envs()
            .filter_map(|(k, v)| Some((k.to_string_lossy().into_owned(), v?.to_string_lossy().into_owned())))
            .collect();
        assert_eq!(envs.get("CAMOFOX_BASE_URL").map(String::as_str), Some("http://127.0.0.1:9377"));
        assert_eq!(envs.get("CAMOFOX_USER_ID").map(String::as_str), Some("acme"));
    }

    #[test]
    fn build_command_passes_system_and_append_prompts() {
        let base = std::path::PathBuf::from("/x/system_prompt.md");
        let identity = std::path::PathBuf::from("/x/identity.md");
        let config = SpawnConfig {
            system_prompt: Some(base.clone()),
            append_system_prompt: Some(identity.clone()),
            ..SpawnConfig::default()
        };
        let cmd = build_command(&config);
        let args: Vec<String> = cmd
            .as_std()
            .get_args()
            .map(|a| a.to_string_lossy().into_owned())
            .collect();
        let s = args
            .iter()
            .position(|a| a == "--system-prompt")
            .expect("--system-prompt present");
        assert_eq!(args[s + 1], base.to_string_lossy());
        let a = args
            .iter()
            .position(|a| a == "--append-system-prompt")
            .expect("--append-system-prompt present");
        assert_eq!(args[a + 1], identity.to_string_lossy());
    }

    #[test]
    fn build_command_default_passes_no_system_prompt() {
        let cmd = build_command(&SpawnConfig::default());
        assert!(cmd.as_std().get_args().all(|a| a != "--system-prompt"));
    }

    #[test]
    fn build_command_default_injects_no_extension_or_env() {
        let cmd = build_command(&SpawnConfig::default());
        let std_cmd = cmd.as_std();
        assert!(std_cmd.get_args().all(|a| a != "--extension"));
        assert_eq!(std_cmd.get_envs().count(), 0);
    }
}
