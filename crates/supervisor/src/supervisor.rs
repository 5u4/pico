use std::{
    collections::VecDeque,
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    },
    time::{Duration, Instant},
};

use color_eyre::eyre::{WrapErr, eyre};
use pico_shared::proto::{DeployRecord, DeployTarget, Request, Response, StatusReport};
use tokio::sync::{Mutex as AsyncMutex, oneshot};
use tokio_util::{sync::CancellationToken, task::TaskTracker};

use crate::{config::Config, slots::Slots};

const HISTORY_CAP: usize = 5;

/// How long a control client has to deliver its request frame before the
/// connection is dropped. Bounds a stalled or malicious client so it can't pin
/// a handler task — and thus stall the shutdown drain — indefinitely.
const REQUEST_READ_TIMEOUT: Duration = Duration::from_secs(10);

struct WorkerProc {
    child: tokio::process::Child,
    pid: Option<u32>,
    bin: PathBuf,
    started_at: Instant,
}

/// Owns the worker process, the deploy pipeline, and the control socket.
pub struct Supervisor {
    config: Config,
    worker_root: PathBuf,
    socket_path: PathBuf,
    slots: Slots,
    worker: AsyncMutex<Option<WorkerProc>>,
    history: Mutex<VecDeque<DeployRecord>>,
    deploy_lock: AsyncMutex<()>,
    pending_ready: Mutex<Option<(String, oneshot::Sender<()>)>>,
    cancel: CancellationToken,
    tracker: TaskTracker,
}

impl Supervisor {
    pub fn new(config: Config, worker_root: PathBuf, socket_path: PathBuf, slots: Slots) -> Self {
        Self {
            config,
            worker_root,
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

    /// Adopt the `current` slot binary if one exists. Must run only once the
    /// accept loop is live: the spawned worker validates by sending a ready ping
    /// back over the control socket, so booting before [`Self::serve`] is
    /// accepting would dead-lock on a ping nothing receives. Failure is
    /// non-fatal — the socket stays up so a `deploy` can recover.
    async fn boot(&self) {
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
                tracing::info!(binary = %current.display(), ?pid, "booted worker from current slot");
            }
            Err(e) => {
                tracing::warn!(error = %format!("{e:#}"), "boot spawn failed; awaiting deploy");
            }
        }
    }

    pub async fn serve(self: Arc<Self>) -> color_eyre::Result<()> {
        let socket = self.socket_path.clone();
        if let Some(parent) = socket.parent() {
            std::fs::create_dir_all(parent)?;
        }
        match std::fs::remove_file(&socket) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e.into()),
        }
        let listener =
            tokio::net::UnixListener::bind(&socket).wrap_err_with(|| format!("bind {}", socket.display()))?;
        tracing::info!(socket = %socket.display(), "supervisor listening");

        let watcher = self.cancel.clone();
        tokio::spawn(async move {
            match pico_shared::signal::wait_for_shutdown().await {
                Ok(()) => tracing::info!("shutdown signal received; draining"),
                Err(e) => {
                    tracing::error!(error = %format!("{e:#}"), "signal setup failed; shutdown not handled");
                    return;
                }
            }
            watcher.cancel();
        });

        let accept = {
            let me = Arc::clone(&self);
            tokio::spawn(async move { me.accept_loop(listener).await })
        };

        // Socket is accepting now, so a worker adopted from the current slot can
        // deliver its ready ping. Booting earlier would dead-lock on it.
        self.boot().await;

        let result = match accept.await {
            Ok(result) => result,
            Err(e) => Err(eyre!("accept task panicked: {e}")),
        };

        self.shutdown().await;
        result
    }

    async fn accept_loop(self: Arc<Self>, listener: tokio::net::UnixListener) -> color_eyre::Result<()> {
        loop {
            let stream = tokio::select! {
                biased;
                () = self.cancel.cancelled() => return Ok(()),
                accepted = listener.accept() => match accepted {
                    Ok((stream, _addr)) => stream,
                    Err(e) => return Err(e).wrap_err("accept failed"),
                },
            };
            let me = Arc::clone(&self);
            self.tracker.spawn(async move {
                if let Err(e) = me.handle_conn(stream).await {
                    tracing::warn!(error = %format!("{e:#}"), "connection error");
                }
            });
        }
    }

    /// Stop accepting, drain in-flight handlers so an in-flight deploy finishes
    /// (rather than leaving the slots half-updated), then stop the worker and
    /// remove the control socket. Runs on every exit from [`Self::serve`].
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
            Err(e) => tracing::warn!(error = %e, "failed to remove control socket"),
        }
    }

    async fn handle_conn(self: Arc<Self>, stream: tokio::net::UnixStream) -> color_eyre::Result<()> {
        let (read_half, mut write_half) = stream.into_split();
        let mut reader = tokio::io::BufReader::new(read_half);
        let read = tokio::select! {
            biased;
            () = self.cancel.cancelled() => return Ok(()),
            read = tokio::time::timeout(
                REQUEST_READ_TIMEOUT,
                pico_shared::proto::read_frame::<Request, _>(&mut reader),
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
                return Ok(());
            }
            Request::Deploy { target } => self.deploy(target).await,
            Request::Rollback => self.rollback().await,
            Request::Status => self.status().await,
            Request::Stop => self.stop().await,
        };
        pico_shared::proto::write_frame(&mut write_half, &resp).await
    }

    fn signal_ready(&self, token: &str) {
        let mut pending = self.pending_ready.lock().expect("pending_ready poisoned");
        let matches = pending.as_ref().is_some_and(|(expected, _)| expected == token);
        if matches {
            if let Some((_, tx)) = pending.take() {
                let _ = tx.send(());
            }
        } else {
            tracing::debug!("ignoring ready ping with unknown token");
        }
    }

    async fn deploy(&self, target: DeployTarget) -> Response {
        let _guard = self.deploy_lock.lock().await;
        let desc = describe(&target);

        let bin = match crate::build::resolve(&target, self.config.repo_path.as_deref(), self.slots.builds_dir()).await
        {
            Ok(bin) => bin,
            Err(e) => {
                return Response::Error {
                    message: format!("build failed: {e:#}"),
                };
            }
        };

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

        match self.spawn_and_validate(&bin).await {
            Ok(proc) => {
                let pid = proc.pid;
                *self.worker.lock().await = Some(proc);
                let note = match self.slots.promote(&bin) {
                    Ok(()) => String::new(),
                    Err(e) => {
                        tracing::warn!(error = %format!("{e:#}"), "slot promote failed");
                        format!(" (warning: slot update failed: {e:#})")
                    }
                };
                self.record(&desc, "ok");
                Response::Ok {
                    detail: format!("deployed {} (pid {}){note}", bin.display(), fmt_pid(pid)),
                }
            }
            Err(e) => match previous {
                Some(prev) => match self.spawn_and_validate(&prev).await {
                    Ok(proc) => {
                        *self.worker.lock().await = Some(proc);
                        self.record(&desc, "rolled_back");
                        Response::Error {
                            message: format!("deploy failed ({e:#}); rolled back to {}", prev.display()),
                        }
                    }
                    Err(e2) => {
                        self.record(&desc, "failed");
                        Response::Error {
                            message: format!("deploy failed ({e:#}); rollback also failed ({e2:#}); no worker running"),
                        }
                    }
                },
                None => {
                    self.record(&desc, "failed");
                    Response::Error {
                        message: format!("deploy failed ({e:#}); no previous slot; no worker running"),
                    }
                }
            },
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

        if let Some(old) = self.worker.lock().await.take() {
            self.kill_worker(old).await;
        }

        match self.spawn_and_validate(&prev).await {
            Ok(proc) => {
                *self.worker.lock().await = Some(proc);
                if let Err(e) = self.slots.swap() {
                    return Response::Error {
                        message: format!("rolled back to {} but slot swap failed: {e:#}", prev.display()),
                    };
                }
                self.record("rollback", "ok");
                Response::Ok {
                    detail: format!("rolled back to {}", prev.display()),
                }
            }
            Err(e) => {
                self.record("rollback", "failed");
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
        let (running, pid, uptime_secs) = match &*self.worker.lock().await {
            Some(w) => (true, w.pid, Some(w.started_at.elapsed().as_secs())),
            None => (false, None, None),
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

    /// Spawn `worker --path <root> --socket <sock>` from `bin` and wait for its
    /// `ready` ping within `health_timeout`. On any failure the child is killed
    /// before the error returns, so no orphan survives.
    async fn spawn_and_validate(&self, bin: &Path) -> color_eyre::Result<WorkerProc> {
        let token = ready_token();
        let (tx, rx) = oneshot::channel();
        *self.pending_ready.lock().expect("pending_ready poisoned") = Some((token.clone(), tx));

        let mut child = match tokio::process::Command::new(bin)
            .arg("--path")
            .arg(&self.worker_root)
            .arg("--socket")
            .arg(&self.socket_path)
            .arg("--ready-token")
            .arg(&token)
            .spawn()
        {
            Ok(child) => child,
            Err(e) => {
                self.pending_ready.lock().expect("pending_ready poisoned").take();
                return Err(e).wrap_err_with(|| format!("spawn {}", bin.display()));
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

        self.pending_ready.lock().expect("pending_ready poisoned").take();

        match outcome {
            Ok(()) => Ok(WorkerProc {
                child,
                pid,
                bin: bin.to_path_buf(),
                started_at: Instant::now(),
            }),
            Err(e) => {
                let _ = child.start_kill();
                let _ = child.wait().await;
                Err(e)
            }
        }
    }

    async fn kill_worker(&self, mut proc: WorkerProc) {
        tracing::info!(binary = %proc.bin.display(), pid = ?proc.pid, "stopping worker");
        if let Some(pid) = proc.pid {
            // SAFETY: kill(2) with a pid we own; an invalid pid is a harmless ESRCH.
            unsafe {
                libc::kill(pid as libc::pid_t, libc::SIGTERM);
            }
        }
        tokio::select! {
            _ = proc.child.wait() => {}
            () = tokio::time::sleep(self.config.health_timeout()) => {
                let _ = proc.child.start_kill();
                let _ = proc.child.wait().await;
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

fn describe(target: &DeployTarget) -> String {
    match target {
        DeployTarget::Rev { rev } => format!("rev:{rev}"),
        DeployTarget::Path { path } => format!("path:{}", path.display()),
    }
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
