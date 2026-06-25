use std::{
    collections::HashMap,
    path::PathBuf,
    process::Stdio,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

use color_eyre::eyre::{WrapErr, eyre};
use parking_lot::Mutex;
use tokio::{
    io::{AsyncBufReadExt, BufReader},
    process::{ChildStderr, ChildStdin, ChildStdout, Command as ProcCommand},
    sync::{Mutex as AsyncMutex, mpsc, oneshot},
};
use tokio_util::{sync::CancellationToken, task::TaskTracker};

use crate::omp::protocol::{Command, Identity, Inbound, OmpEvent, RequestId, RpcResponse, UiResponse};

const READY_TIMEOUT: Duration = Duration::from_secs(30);

const RESPONSE_TIMEOUT: Duration = Duration::from_secs(30);

const HOST_ENTRY_ENV: &str = "PICO_OMP_HOST";

const HOST_BIN_ENV: &str = "PICO_OMP_BIN";

type Pending = Arc<Mutex<HashMap<RequestId, oneshot::Sender<RpcResponse>>>>;

type Sessions = Arc<Mutex<HashMap<String, mpsc::UnboundedSender<OmpEvent>>>>;

#[derive(Debug, Default, Clone)]
pub struct HostConfig {
    pub env: Vec<(String, String)>,
}

#[derive(Debug, Default, Clone)]
pub struct SessionIdentity {
    pub platform: String,
    pub guild: String,
    pub channel: String,
    pub thread: String,
    pub user: String,
}

#[derive(Debug, Default, Clone)]
pub struct SessionConfig {
    pub model: Option<String>,
    pub cwd: PathBuf,
    pub session_dir: PathBuf,
    pub continue_from_file: Option<PathBuf>,
    pub append_system_prompt: Option<PathBuf>,
    pub identity: SessionIdentity,
    pub profile: String,
}

pub struct OmpHost {
    stdin: AsyncMutex<ChildStdin>,
    pending: Pending,
    sessions: Sessions,
    alive: Arc<AtomicBool>,
}

pub struct OmpSessionHandle {
    host: Arc<OmpHost>,
    session_id: String,
}

fn resolve_host_entry(explicit: Option<PathBuf>, home: Option<PathBuf>) -> PathBuf {
    explicit.unwrap_or_else(|| home.unwrap_or_default().join(".pico/agent/omp-host/host.ts"))
}

fn host_entry() -> PathBuf {
    resolve_host_entry(
        std::env::var_os(HOST_ENTRY_ENV).map(PathBuf::from),
        std::env::var_os("HOME").map(PathBuf::from),
    )
}

fn build_command(host: &HostConfig) -> ProcCommand {
    let mut cmd = match std::env::var_os(HOST_BIN_ENV) {
        Some(bin) => ProcCommand::new(bin),
        None => {
            let mut cmd = ProcCommand::new("bun");
            cmd.arg("run").arg(host_entry());
            cmd
        }
    };
    for (key, value) in &host.env {
        cmd.env(key, value);
    }
    cmd.stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    cmd
}

impl OmpHost {
    pub async fn spawn(
        host: &HostConfig,
        cancel: &CancellationToken,
        tracker: &TaskTracker,
    ) -> color_eyre::Result<Arc<OmpHost>> {
        let mut cmd = build_command(host);

        let mut child = cmd.spawn().wrap_err("spawn `bun run` omp host")?;
        let stdin = child.stdin.take().ok_or_else(|| eyre!("omp host has no stdin"))?;
        let stdout = child.stdout.take().ok_or_else(|| eyre!("omp host has no stdout"))?;
        let stderr = child.stderr.take().ok_or_else(|| eyre!("omp host has no stderr"))?;

        let pending: Pending = Arc::new(Mutex::new(HashMap::new()));
        let sessions: Sessions = Arc::new(Mutex::new(HashMap::new()));
        let (ready_tx, ready_rx) = oneshot::channel();
        let alive = Arc::new(AtomicBool::new(true));

        tracker.spawn(drain_stderr(stderr, cancel.clone()));
        tracker.spawn(read_loop(
            stdout,
            Arc::clone(&pending),
            Arc::clone(&sessions),
            Arc::clone(&alive),
            ready_tx,
            cancel.clone(),
        ));

        match tokio::time::timeout(READY_TIMEOUT, ready_rx).await {
            Ok(Ok(())) => tracing::debug!("omp host ready"),
            Ok(Err(_)) => {
                let _ = child.start_kill();
                return Err(eyre!("omp host exited before sending its ready frame"));
            }
            Err(_) => {
                let _ = child.start_kill();
                return Err(eyre!("omp host did not send a ready frame within {READY_TIMEOUT:?}"));
            }
        }

        let shutdown = cancel.clone();
        tracker.spawn(async move {
            shutdown.cancelled().await;
            let _ = child.start_kill();
            let _ = child.wait().await;
        });

        Ok(Arc::new(OmpHost {
            stdin: AsyncMutex::new(stdin),
            pending,
            sessions,
            alive,
        }))
    }

    pub fn is_alive(&self) -> bool {
        self.alive.load(Ordering::Relaxed)
    }

    pub async fn open_session(
        self: &Arc<Self>,
        session_id: &str,
        config: &SessionConfig,
    ) -> color_eyre::Result<(OmpSessionHandle, mpsc::UnboundedReceiver<OmpEvent>)> {
        let (event_tx, event_rx) = mpsc::unbounded_channel();
        self.sessions.lock().insert(session_id.to_owned(), event_tx);

        let id = RequestId::new();
        let identity = Identity {
            platform: &config.identity.platform,
            guild: &config.identity.guild,
            channel: &config.identity.channel,
            thread: &config.identity.thread,
            user: &config.identity.user,
        };
        let cmd = Command::OpenSession {
            id: &id,
            session_id,
            cwd: &config.cwd,
            session_dir: &config.session_dir,
            continue_from_file: config.continue_from_file.as_deref(),
            append_system_prompt: config.append_system_prompt.as_deref(),
            model: config.model.as_deref(),
            identity,
        };
        if let Err(e) = self.dispatch(&id, &cmd).await {
            self.sessions.lock().remove(session_id);
            return Err(e);
        }

        let handle = OmpSessionHandle {
            host: Arc::clone(self),
            session_id: session_id.to_owned(),
        };
        Ok((handle, event_rx))
    }

    async fn send_and_await(&self, id: &RequestId, cmd: &Command<'_>) -> color_eyre::Result<RpcResponse> {
        let (tx, rx) = oneshot::channel();
        self.pending.lock().insert(id.clone(), tx);
        tracing::debug!(command = cmd.kind(), %id, "sending omp host command");

        let write = {
            let mut stdin = self.stdin.lock().await;
            pico_shared::proto::write_frame(&mut *stdin, cmd).await
        };
        if let Err(e) = write {
            self.pending.lock().remove(id);
            return Err(e).wrap_err("write omp host command");
        }

        match tokio::time::timeout(RESPONSE_TIMEOUT, rx).await {
            Ok(Ok(resp)) => Ok(resp),
            Ok(Err(_)) => Err(eyre!("omp host exited before responding to `{id}`")),
            Err(_) => {
                self.pending.lock().remove(id);
                Err(eyre!("omp host did not respond to `{id}` within {RESPONSE_TIMEOUT:?}"))
            }
        }
    }

    async fn dispatch(&self, id: &RequestId, cmd: &Command<'_>) -> color_eyre::Result<()> {
        let resp = self.send_and_await(id, cmd).await?;
        if resp.success {
            Ok(())
        } else {
            let detail = resp
                .error
                .as_deref()
                .unwrap_or("omp host reported failure without a message");
            Err(eyre!("omp host `{}` failed: {detail}", resp.command))
        }
    }

    pub async fn completion(&self, system: &str, prompt: &str) -> color_eyre::Result<Option<String>> {
        let id = RequestId::new();
        let resp = self
            .send_and_await(
                &id,
                &Command::Completion {
                    id: &id,
                    system,
                    prompt,
                },
            )
            .await?;
        Ok(if resp.success { resp.result } else { None })
    }
}

impl OmpSessionHandle {
    pub fn session_id(&self) -> &str {
        &self.session_id
    }

    pub async fn prompt(&self, message: &str) -> color_eyre::Result<()> {
        let id = RequestId::new();
        self.host
            .dispatch(
                &id,
                &Command::Prompt {
                    id: &id,
                    session_id: &self.session_id,
                    message,
                },
            )
            .await
    }

    pub async fn steer(&self, message: &str) -> color_eyre::Result<()> {
        let id = RequestId::new();
        self.host
            .dispatch(
                &id,
                &Command::Steer {
                    id: &id,
                    session_id: &self.session_id,
                    message,
                },
            )
            .await
    }

    pub async fn follow_up(&self, message: &str) -> color_eyre::Result<()> {
        let id = RequestId::new();
        self.host
            .dispatch(
                &id,
                &Command::FollowUp {
                    id: &id,
                    session_id: &self.session_id,
                    message,
                },
            )
            .await
    }

    pub async fn abort(&self) -> color_eyre::Result<()> {
        let id = RequestId::new();
        self.host
            .dispatch(
                &id,
                &Command::Abort {
                    id: &id,
                    session_id: &self.session_id,
                },
            )
            .await
    }

    pub async fn new_session(&self) -> color_eyre::Result<()> {
        let id = RequestId::new();
        self.host
            .dispatch(
                &id,
                &Command::NewSession {
                    id: &id,
                    session_id: &self.session_id,
                },
            )
            .await
    }

    pub async fn set_model(&self, provider: &str, model_id: &str) -> color_eyre::Result<()> {
        let id = RequestId::new();
        self.host
            .dispatch(
                &id,
                &Command::SetModel {
                    id: &id,
                    session_id: &self.session_id,
                    provider,
                    model_id,
                },
            )
            .await
    }

    pub async fn set_session_name(&self, name: &str) -> color_eyre::Result<()> {
        let id = RequestId::new();
        self.host
            .dispatch(
                &id,
                &Command::SetSessionName {
                    id: &id,
                    session_id: &self.session_id,
                    name,
                },
            )
            .await
    }

    pub async fn ui_response(&self, response: &UiResponse<'_>) -> color_eyre::Result<()> {
        let mut stdin = self.host.stdin.lock().await;
        pico_shared::proto::write_frame(&mut *stdin, response)
            .await
            .wrap_err("write extension_ui_response")
    }

    pub async fn close(&self) -> color_eyre::Result<()> {
        let id = RequestId::new();
        let result = self
            .host
            .dispatch(
                &id,
                &Command::CloseSession {
                    id: &id,
                    session_id: &self.session_id,
                },
            )
            .await;
        self.host.sessions.lock().remove(&self.session_id);
        result
    }
}

fn route(sessions: &Sessions, session_id: &str, event: OmpEvent) {
    match sessions.lock().get(session_id) {
        Some(tx) => {
            let _ = tx.send(event);
        }
        None => tracing::debug!(%session_id, "omp host: event for unknown session"),
    }
}

async fn read_loop(
    stdout: ChildStdout,
    pending: Pending,
    sessions: Sessions,
    alive: Arc<AtomicBool>,
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
                tracing::warn!(error = %e, "omp host stdout read error");
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
                tracing::warn!(error = %e, bytes = trimmed.len(), "omp host: undecodable frame");
                tracing::debug!(frame = %trimmed, "omp host: undecodable frame contents");
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
                    None if !resp.success => {
                        let msg = resp
                            .error
                            .unwrap_or_else(|| format!("omp host `{}` failed", resp.command));
                        route(&sessions, &resp.session_id, OmpEvent::Error(msg));
                    }
                    None => tracing::debug!(command = %resp.command, "omp host: response with no waiter"),
                }
            }
            Inbound::AgentStart { session_id } => route(&sessions, &session_id, OmpEvent::AgentStart),
            Inbound::AgentEnd { session_id } => route(&sessions, &session_id, OmpEvent::AgentEnd),
            Inbound::TurnEnd { session_id } => route(&sessions, &session_id, OmpEvent::TurnEnd),
            Inbound::MessageUpdate {
                session_id,
                assistant_message_event,
            } => route(&sessions, &session_id, OmpEvent::Message(assistant_message_event)),
            Inbound::ToolExecutionStart { session_id, call } => {
                route(&sessions, &session_id, OmpEvent::ToolStart(call))
            }
            Inbound::ToolExecutionUpdate { session_id, update } => {
                route(&sessions, &session_id, OmpEvent::ToolUpdate(update))
            }
            Inbound::ToolExecutionEnd { session_id, end } => route(&sessions, &session_id, OmpEvent::ToolEnd(end)),
            Inbound::ExtensionUiRequest { session_id, request } => {
                route(&sessions, &session_id, OmpEvent::UiRequest(request))
            }
            Inbound::Error { session_id, message } => route(&sessions, &session_id, OmpEvent::Error(message)),
            Inbound::Unknown => {}
        }
    }

    pending.lock().clear();
    sessions.lock().clear();
    alive.store(false, Ordering::Relaxed);
}

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
    fn resolve_host_entry_prefers_explicit() {
        assert_eq!(
            resolve_host_entry(Some(PathBuf::from("/x/host.ts")), Some(PathBuf::from("/home/u"))),
            PathBuf::from("/x/host.ts"),
        );
    }

    #[test]
    fn resolve_host_entry_defaults_under_home() {
        assert_eq!(
            resolve_host_entry(None, Some(PathBuf::from("/home/u"))),
            PathBuf::from("/home/u/.pico/agent/omp-host/host.ts"),
        );
    }

    static ENV_LOCK: Mutex<()> = Mutex::new(());

    fn with_bin_env<T>(value: Option<&str>, f: impl FnOnce() -> T) -> T {
        let _guard = ENV_LOCK.lock();
        let prev = std::env::var_os(HOST_BIN_ENV);
        unsafe {
            match value {
                Some(v) => std::env::set_var(HOST_BIN_ENV, v),
                None => std::env::remove_var(HOST_BIN_ENV),
            }
        }
        let out = f();
        unsafe {
            match prev {
                Some(v) => std::env::set_var(HOST_BIN_ENV, v),
                None => std::env::remove_var(HOST_BIN_ENV),
            }
        }
        out
    }

    #[test]
    fn build_command_runs_bun_with_host_env() {
        let host = HostConfig {
            env: vec![
                ("CAMOFOX_BASE_URL".to_owned(), "http://127.0.0.1:9377".to_owned()),
                ("CAMOFOX_USER_ID".to_owned(), "default".to_owned()),
            ],
        };
        with_bin_env(None, || {
            let cmd = build_command(&host);
            let std_cmd = cmd.as_std();
            assert_eq!(std_cmd.get_program(), "bun");
            let args: Vec<String> = std_cmd.get_args().map(|a| a.to_string_lossy().into_owned()).collect();
            assert_eq!(args.first().map(String::as_str), Some("run"));
            let envs: HashMap<String, String> = std_cmd
                .get_envs()
                .filter_map(|(k, v)| Some((k.to_string_lossy().into_owned(), v?.to_string_lossy().into_owned())))
                .collect();
            assert_eq!(envs.get("CAMOFOX_BASE_URL").map(String::as_str), Some("http://127.0.0.1:9377"));
            assert_eq!(envs.get("CAMOFOX_USER_ID").map(String::as_str), Some("default"));
        });
    }

    #[test]
    fn build_command_default_injects_no_env() {
        with_bin_env(None, || {
            let cmd = build_command(&HostConfig::default());
            assert_eq!(cmd.as_std().get_envs().count(), 0);
        });
    }

    #[test]
    fn build_command_override_spawns_bin_directly() {
        let host = HostConfig {
            env: vec![("CAMOFOX_BASE_URL".to_owned(), "http://127.0.0.1:9377".to_owned())],
        };
        with_bin_env(Some("/opt/pico/scripted-omp"), || {
            let cmd = build_command(&host);
            let std_cmd = cmd.as_std();
            assert_eq!(std_cmd.get_program(), "/opt/pico/scripted-omp");
            assert_eq!(std_cmd.get_args().count(), 0);
            let envs: HashMap<String, String> = std_cmd
                .get_envs()
                .filter_map(|(k, v)| Some((k.to_string_lossy().into_owned(), v?.to_string_lossy().into_owned())))
                .collect();
            assert_eq!(envs.get("CAMOFOX_BASE_URL").map(String::as_str), Some("http://127.0.0.1:9377"));
        });
    }
}
