use std::{
    collections::VecDeque,
    path::{Path, PathBuf},
    process::Stdio,
    sync::{
        Mutex,
        atomic::{AtomicU64, Ordering},
    },
    time::{Duration, Instant},
};

use color_eyre::eyre::{WrapErr, eyre};
use tokio::sync::{Mutex as AsyncMutex, oneshot};
use tokio_util::{sync::CancellationToken, task::TaskTracker};

use crate::{
    config::Config,
    proto::{DeployRecord, ReadyAck, Request, Response, StatusReport, read_frame, write_frame},
    slots::Slots,
};

const HISTORY_CAP: usize = 5;
const REQUEST_READ_TIMEOUT: Duration = Duration::from_secs(10);
const WORKER_ENTRY: &str = "src/index.ts";

struct WorkerProc {
    child: tokio::process::Child,
    pid: Option<u32>,
    slot: PathBuf,
    version: Option<String>,
    started_at: Instant,
}

type PendingReady = (String, oneshot::Sender<()>);

pub struct Supervisor {
    config: Config,
    bun: PathBuf,
    socket_path: PathBuf,
    slots: Slots,
    worker: AsyncMutex<Option<WorkerProc>>,
    history: Mutex<VecDeque<DeployRecord>>,
    deploy_lock: AsyncMutex<()>,
    pending_ready: Mutex<Option<PendingReady>>,
    cancel: CancellationToken,
    tracker: TaskTracker,
}

impl Supervisor {
    pub fn new(config: Config, bun: PathBuf, socket_path: PathBuf, slots: Slots) -> Self {
        Self {
            config,
            bun,
            socket_path,
            slots,
            worker: AsyncMutex::new(None),
            history: Mutex::new(VecDeque::new()),
            deploy_lock: AsyncMutex::new(()),
            pending_ready: Mutex::new(None),
            cancel: CancellationToken::new(),
            tracker: TaskTracker::new(),
        }
    }

    async fn boot(self: &std::sync::Arc<Self>) {
        let current = match self.slots.current_target() {
            Ok(Some(current)) => current,
            Ok(None) => {
                tracing::info!("no current slot; awaiting deploy");
                return;
            }
            Err(e) => {
                tracing::warn!(error = %format!("{e:#}"), "reading current slot failed; awaiting deploy");
                return;
            }
        };
        match self.spawn_and_validate(&current).await {
            Ok(proc) => {
                let pid = proc.pid;
                *self.worker.lock().await = Some(proc);
                tracing::info!(slot = %current.display(), ?pid, "booted worker from current slot");
            }
            Err(e) => {
                tracing::warn!(error = %format!("{e:#}"), "boot spawn failed; awaiting deploy");
            }
        }
    }

    pub async fn serve(self: std::sync::Arc<Self>) -> color_eyre::Result<()> {
        let socket = self.socket_path.clone();
        if let Some(parent) = socket.parent() {
            std::fs::create_dir_all(parent)?;
        }
        match std::fs::remove_file(&socket) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e.into()),
        }
        let listener = tokio::net::UnixListener::bind(&socket)
            .wrap_err_with(|| format!("bind {}", socket.display()))?;
        tracing::info!(socket = %socket.display(), "supervisor listening");

        let watcher = self.cancel.clone();
        tokio::spawn(async move {
            match wait_for_shutdown().await {
                Ok(()) => tracing::info!("shutdown signal received; draining"),
                Err(e) => {
                    tracing::error!(error = %format!("{e:#}"), "signal setup failed; shutdown not handled");
                    return;
                }
            }
            watcher.cancel();
        });

        let accept = {
            let me = std::sync::Arc::clone(&self);
            tokio::spawn(async move { me.accept_loop(listener).await })
        };

        self.boot().await;

        let result = match accept.await {
            Ok(result) => result,
            Err(e) => Err(eyre!("accept task panicked: {e}")),
        };

        self.shutdown().await;
        result
    }

    async fn accept_loop(
        self: std::sync::Arc<Self>,
        listener: tokio::net::UnixListener,
    ) -> color_eyre::Result<()> {
        loop {
            let stream = tokio::select! {
                biased;
                () = self.cancel.cancelled() => return Ok(()),
                accepted = listener.accept() => match accepted {
                    Ok((stream, _addr)) => stream,
                    Err(e) => return Err(e).wrap_err("accept failed"),
                },
            };
            let me = std::sync::Arc::clone(&self);
            self.tracker.spawn(async move {
                if let Err(e) = me.handle_conn(stream).await {
                    tracing::warn!(error = %format!("{e:#}"), "connection error");
                }
            });
        }
    }

    async fn shutdown(&self) {
        self.cancel.cancel();
        self.tracker.close();
        self.tracker.wait().await;
        if let Some(worker) = self.worker.lock().await.take() {
            self.kill_worker(worker).await;
        }
        match std::fs::remove_file(&self.socket_path) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => tracing::warn!(error = %format!("{e:#}"), "failed to remove control socket"),
        }
    }

    async fn handle_conn(
        self: std::sync::Arc<Self>,
        stream: tokio::net::UnixStream,
    ) -> color_eyre::Result<()> {
        let (read_half, mut write_half) = stream.into_split();
        let mut reader = tokio::io::BufReader::new(read_half);
        let read = tokio::select! {
            biased;
            () = self.cancel.cancelled() => return Ok(()),
            read = tokio::time::timeout(
                REQUEST_READ_TIMEOUT,
                read_frame::<Request, _>(&mut reader),
            ) => read,
        };
        let Some(req) = (match read {
            Ok(frame) => frame?,
            Err(_elapsed) => {
                tracing::debug!("control client idle past read timeout; dropping connection");
                return Ok(());
            }
        }) else {
            return Ok(());
        };
        let resp = match req {
            Request::Ready { token } => {
                self.signal_ready(&token);
                return write_frame(&mut write_half, &ReadyAck {}).await;
            }
            Request::Deploy { path } => self.deploy(path).await,
            Request::Rollback => self.rollback().await,
            Request::Status => self.status().await,
            Request::Stop => self.stop().await,
        };
        write_frame(&mut write_half, &resp).await
    }

    fn signal_ready(&self, token: &str) {
        let mut pending = self.pending_ready.lock().expect("pending_ready poisoned");
        if pending
            .as_ref()
            .is_some_and(|(expected, _)| expected == token)
        {
            let (_, tx) = pending.take().expect("pending_ready checked non-empty");
            let _ = tx.send(());
            tracing::info!("worker reported ready");
        } else {
            tracing::debug!("ignoring ready ping with unknown token");
        }
    }

    async fn deploy(&self, slot: PathBuf) -> Response {
        let _guard = self.deploy_lock.lock().await;

        if !slot.join(WORKER_ENTRY).is_file() {
            return Response::Error {
                message: format!("slot {} has no {WORKER_ENTRY}", slot.display()),
            };
        }
        let version = commit_sha(&slot).await;
        let desc = version
            .clone()
            .unwrap_or_else(|| slot.display().to_string());
        tracing::info!(slot = %slot.display(), desc = %desc, "deploy starting");

        let previous = match self.slots.current_target() {
            Ok(p) => p,
            Err(e) => {
                return Response::Error {
                    message: format!("{e:#}"),
                };
            }
        };

        if let Some(old) = self.worker.lock().await.take() {
            self.kill_worker(old).await;
        }

        match self.spawn_and_validate(&slot).await {
            Ok(proc) => {
                let pid = proc.pid;
                tracing::info!(desc = %desc, ?pid, "deploy succeeded");
                *self.worker.lock().await = Some(proc);
                let note = match self.slots.promote(&slot) {
                    Ok(()) => String::new(),
                    Err(e) => {
                        tracing::warn!(error = %format!("{e:#}"), "slot promote failed");
                        format!(" (warning: slot update failed: {e:#})")
                    }
                };
                self.record(&desc, "ok");
                Response::Ok {
                    detail: format!("deployed {desc} (pid {}){note}", fmt_pid(pid)),
                }
            }
            Err(e) => self.recover(previous, &desc, e).await,
        }
    }

    async fn recover(
        &self,
        previous: Option<PathBuf>,
        desc: &str,
        deploy_err: color_eyre::Report,
    ) -> Response {
        let Some(prev) = previous else {
            self.record(desc, "failed");
            tracing::error!(
                deploy_error = %format!("{deploy_err:#}"),
                "deploy failed and no previous slot — NO WORKER RUNNING"
            );
            return Response::Error {
                message: format!(
                    "deploy failed ({deploy_err:#}); no previous slot; no worker running"
                ),
            };
        };
        let prev_desc = commit_sha(&prev)
            .await
            .unwrap_or_else(|| prev.display().to_string());
        match self.spawn_and_validate(&prev).await {
            Ok(proc) => {
                *self.worker.lock().await = Some(proc);
                self.record(desc, "rolled_back");
                Response::Error {
                    message: format!("deploy failed ({deploy_err:#}); rolled back to {prev_desc}"),
                }
            }
            Err(e2) => {
                self.record(desc, "failed");
                tracing::error!(
                    deploy_error = %format!("{deploy_err:#}"),
                    rollback_error = %format!("{e2:#}"),
                    "deploy failed and rollback failed — NO WORKER RUNNING"
                );
                Response::Error {
                    message: format!(
                        "deploy failed ({deploy_err:#}); rollback also failed ({e2:#}); no worker running"
                    ),
                }
            }
        }
    }

    async fn rollback(&self) -> Response {
        let _guard = self.deploy_lock.lock().await;
        let prev = match self.slots.previous_target() {
            Ok(Some(p)) => p,
            Ok(None) => {
                return Response::Error {
                    message: "no previous slot to roll back to".into(),
                };
            }
            Err(e) => {
                return Response::Error {
                    message: format!("{e:#}"),
                };
            }
        };

        let desc = commit_sha(&prev)
            .await
            .unwrap_or_else(|| prev.display().to_string());
        tracing::info!(slot = %prev.display(), desc = %desc, "rollback starting");

        if let Some(old) = self.worker.lock().await.take() {
            self.kill_worker(old).await;
        }

        match self.spawn_and_validate(&prev).await {
            Ok(proc) => {
                *self.worker.lock().await = Some(proc);
                if let Err(e) = self.slots.swap() {
                    return Response::Error {
                        message: format!("rolled back to {desc} but slot swap failed: {e:#}"),
                    };
                }
                self.record(&desc, "ok");
                tracing::info!(desc = %desc, "rollback succeeded");
                Response::Ok {
                    detail: format!("rolled back to {desc}"),
                }
            }
            Err(e) => {
                self.record(&desc, "failed");
                tracing::error!(error = %format!("{e:#}"), "rollback failed — NO WORKER RUNNING");
                Response::Error {
                    message: format!("rollback failed: {e:#}; no worker running"),
                }
            }
        }
    }

    async fn status(&self) -> Response {
        let current = match self.slots.current_target() {
            Ok(c) => c.map(|p| p.display().to_string()),
            Err(e) => {
                return Response::Error {
                    message: format!("{e:#}"),
                };
            }
        };
        let (running, pid, uptime_secs, version) = match &*self.worker.lock().await {
            Some(w) => (
                true,
                w.pid,
                Some(w.started_at.elapsed().as_secs()),
                w.version.clone(),
            ),
            None => (false, None, None, None),
        };
        let deploys = self
            .history
            .lock()
            .expect("history poisoned")
            .iter()
            .rev()
            .cloned()
            .collect();
        Response::Status(StatusReport {
            running,
            pid,
            current,
            version,
            uptime_secs,
            deploys,
        })
    }

    async fn stop(&self) -> Response {
        match self.worker.lock().await.take() {
            Some(w) => {
                self.kill_worker(w).await;
                Response::Ok {
                    detail: "worker stopped".into(),
                }
            }
            None => Response::Ok {
                detail: "no worker running".into(),
            },
        }
    }

    async fn spawn_and_validate(&self, slot: &Path) -> color_eyre::Result<WorkerProc> {
        let token = ready_token();
        let (tx, rx) = oneshot::channel();
        *self.pending_ready.lock().expect("pending_ready poisoned") = Some((token.clone(), tx));

        let version = commit_sha(slot).await;
        let mut child = match tokio::process::Command::new(&self.bun)
            .arg("run")
            .arg(WORKER_ENTRY)
            .current_dir(slot)
            .env("NODE_ENV", "production")
            .env("PICO_SUPERVISOR_SOCKET", &self.socket_path)
            .env("PICO_READY_TOKEN", &token)
            .stdin(Stdio::null())
            .spawn()
        {
            Ok(child) => child,
            Err(e) => {
                self.pending_ready
                    .lock()
                    .expect("pending_ready poisoned")
                    .take();
                return Err(e).wrap_err_with(|| format!("spawn bun in {}", slot.display()));
            }
        };
        let pid = child.id();

        let outcome: color_eyre::Result<()> = tokio::select! {
            ready = rx => ready.map_err(|_| eyre!("ready channel closed before worker reported")),
            exit = child.wait() => match exit {
                Ok(status) => Err(eyre!("worker exited before ready: {status}")),
                Err(e) => Err(eyre!("waiting on worker: {e}")),
            },
            () = tokio::time::sleep(self.config.health_timeout()) => {
                Err(eyre!("worker not ready within {:?}", self.config.health_timeout()))
            }
        };

        self.pending_ready
            .lock()
            .expect("pending_ready poisoned")
            .take();

        match outcome {
            Ok(()) => {
                tracing::info!(?pid, slot = %slot.display(), "worker spawned and validated");
                Ok(WorkerProc {
                    child,
                    pid,
                    slot: slot.to_path_buf(),
                    version,
                    started_at: Instant::now(),
                })
            }
            Err(e) => {
                let _ = child.start_kill();
                let _ = child.wait().await;
                Err(e)
            }
        }
    }

    async fn kill_worker(&self, mut proc: WorkerProc) {
        tracing::info!(slot = %proc.slot.display(), pid = ?proc.pid, "stopping worker");
        if let Some(pid) = proc.pid {
            // SAFETY: kill(2) with a pid we spawned; an already-reaped pid is a harmless ESRCH.
            unsafe {
                libc::kill(pid as libc::pid_t, libc::SIGTERM);
            }
        }
        tokio::select! {
            _ = proc.child.wait() => {}
            () = tokio::time::sleep(self.config.health_timeout()) => {
                if let Err(e) = proc.child.start_kill() {
                    tracing::warn!(error = %format!("{e:#}"), "force-kill of unresponsive worker failed");
                }
                if let Err(e) = proc.child.wait().await {
                    tracing::warn!(error = %format!("{e:#}"), "waiting on force-killed worker failed");
                }
            }
        }
    }

    fn record(&self, target: &str, outcome: &str) {
        let mut history = self.history.lock().expect("history poisoned");
        history.push_back(DeployRecord {
            target: target.to_string(),
            outcome: outcome.to_string(),
            at_unix: now_unix(),
        });
        while history.len() > HISTORY_CAP {
            history.pop_front();
        }
    }
}

async fn commit_sha(slot: &Path) -> Option<String> {
    let output = tokio::process::Command::new("git")
        .arg("-C")
        .arg(slot)
        .args(["rev-parse", "--short", "HEAD"])
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .await
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let sha = String::from_utf8_lossy(&output.stdout).trim().to_owned();
    if sha.is_empty() { None } else { Some(sha) }
}

async fn wait_for_shutdown() -> color_eyre::Result<()> {
    use tokio::signal::unix::{SignalKind, signal};
    let mut term = signal(SignalKind::terminate())?;
    let mut int = signal(SignalKind::interrupt())?;
    tokio::select! {
        _ = term.recv() => {}
        _ = int.recv() => {}
    }
    Ok(())
}

fn fmt_pid(pid: Option<u32>) -> String {
    pid.map(|p| p.to_string()).unwrap_or_else(|| "?".into())
}

fn now_unix() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn ready_token() -> String {
    static SEQ: AtomicU64 = AtomicU64::new(0);
    let seq = SEQ.fetch_add(1, Ordering::Relaxed);
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("{}-{nanos}-{seq}", std::process::id())
}
