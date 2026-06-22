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
use pico_shared::proto::{DeployRecord, DeployReport, ReadyAck, Request, Response, StatusReport};
use tokio::sync::{Mutex as AsyncMutex, oneshot};
use tokio_util::{sync::CancellationToken, task::TaskTracker};

use crate::{config::Config, slots::Slots};

const HISTORY_CAP: usize = 5;

const REQUEST_READ_TIMEOUT: Duration = Duration::from_secs(10);

struct WorkerProc {
    child: tokio::process::Child,
    pid: Option<u32>,
    bin: PathBuf,
    version: Option<String>,
    build: Option<String>,
    started_at: Instant,
}

#[derive(Default, Clone)]
struct Meta {
    version: Option<String>,
    build: Option<String>,
}

type PendingReady = (String, oneshot::Sender<()>, Option<DeployReport>);

pub struct Supervisor {
    config: Config,
    worker_root: PathBuf,
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

    async fn inspect(&self, bin: &Path) -> Meta {
        let (version, build) = tokio::join!(crate::stage::worker_version(bin), crate::stage::build_id(bin));
        Meta {
            version: version.ok(),
            build: build.ok(),
        }
    }

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
        let meta = self.inspect(&current).await;
        match self.spawn_and_validate(&current, &meta, None).await {
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
                    if is_peer_disconnect(&e) {
                        tracing::debug!(error = %format!("{e:#}"), "control peer disconnected before reply");
                    } else {
                        tracing::warn!(error = %format!("{e:#}"), "connection error");
                    }
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
                let report = self.signal_ready(&token);
                return pico_shared::proto::write_frame(&mut write_half, &ReadyAck { report }).await;
            }
            Request::Deploy { path, report_to } => self.deploy(path, report_to).await,
            Request::Rollback => self.rollback().await,
            Request::Status => self.status().await,
            Request::Stop => self.stop().await,
        };
        pico_shared::proto::write_frame(&mut write_half, &resp).await
    }

    fn signal_ready(&self, token: &str) -> Option<DeployReport> {
        let mut pending = self.pending_ready.lock().expect("pending_ready poisoned");
        if pending.as_ref().is_some_and(|(expected, ..)| expected == token) {
            let (_, tx, report) = pending.take().expect("pending_ready checked non-empty");
            let _ = tx.send(());
            report
        } else {
            tracing::debug!("ignoring ready ping with unknown token");
            None
        }
    }

    async fn deploy(&self, path: PathBuf, report_to: Option<String>) -> Response {
        let _guard = self.deploy_lock.lock().await;

        let bin = match crate::stage::stage(&path, self.slots.builds_dir()).await {
            Ok(bin) => bin,
            Err(e) => {
                return Response::Error {
                    message: format!("stage failed: {e:#}"),
                };
            }
        };

        let meta = self.inspect(&bin).await;
        let desc = meta.version.clone().unwrap_or_else(|| path.display().to_string());

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

        let report_fresh = report_to.clone().map(|to| DeployReport {
            report_to: to,
            text: format!("deployed {desc}"),
        });
        match self.spawn_and_validate(&bin, &meta, report_fresh).await {
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
                self.record(&desc, meta.build.as_deref(), "ok");
                Response::Ok {
                    detail: format!("deployed {desc} (pid {}){note}", fmt_pid(pid)),
                }
            }
            Err(e) => match previous {
                Some(prev) => {
                    let prev_meta = self.inspect(&prev).await;
                    let prev_desc = prev_meta.version.clone().unwrap_or_else(|| prev.display().to_string());
                    let report_rollback = report_to.map(|to| DeployReport {
                        report_to: to,
                        text: format!("deploy failed ({e:#}); rolled back to {prev_desc}"),
                    });
                    match self.spawn_and_validate(&prev, &prev_meta, report_rollback).await {
                        Ok(proc) => {
                            *self.worker.lock().await = Some(proc);
                            self.record(&desc, meta.build.as_deref(), "rolled_back");
                            Response::Error {
                                message: format!("deploy failed ({e:#}); rolled back to {prev_desc}"),
                            }
                        }
                        Err(e2) => {
                            self.record(&desc, meta.build.as_deref(), "failed");
                            tracing::error!(
                                deploy_error = %format!("{e:#}"),
                                rollback_error = %format!("{e2:#}"),
                                "deploy failed and rollback failed — NO WORKER RUNNING"
                            );
                            Response::Error {
                                message: format!(
                                    "deploy failed ({e:#}); rollback also failed ({e2:#}); no worker running"
                                ),
                            }
                        }
                    }
                }
                None => {
                    self.record(&desc, meta.build.as_deref(), "failed");
                    tracing::error!(
                        deploy_error = %format!("{e:#}"),
                        "deploy failed and no previous slot — NO WORKER RUNNING"
                    );
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

        let meta = self.inspect(&prev).await;
        let desc = meta.version.clone().unwrap_or_else(|| prev.display().to_string());

        if let Some(old) = self.worker.lock().await.take() {
            self.kill_worker(old).await;
        }

        match self.spawn_and_validate(&prev, &meta, None).await {
            Ok(proc) => {
                *self.worker.lock().await = Some(proc);
                if let Err(e) = self.slots.swap() {
                    return Response::Error {
                        message: format!("rolled back to {desc} but slot swap failed: {e:#}"),
                    };
                }
                self.record(&desc, meta.build.as_deref(), "ok");
                Response::Ok {
                    detail: format!("rolled back to {desc}"),
                }
            }
            Err(e) => {
                self.record(&desc, meta.build.as_deref(), "failed");
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
        let (running, pid, uptime_secs, version, build) = match &*self.worker.lock().await {
            Some(w) => (
                true,
                w.pid,
                Some(w.started_at.elapsed().as_secs()),
                w.version.clone(),
                w.build.clone(),
            ),
            None => (false, None, None, None, None),
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
            build,
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

    async fn spawn_and_validate(
        &self,
        bin: &Path,
        meta: &Meta,
        report: Option<DeployReport>,
    ) -> color_eyre::Result<WorkerProc> {
        let token = ready_token();
        let (tx, rx) = oneshot::channel();
        *self.pending_ready.lock().expect("pending_ready poisoned") = Some((token.clone(), tx, report));

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
                version: meta.version.clone(),
                build: meta.build.clone(),
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

    fn record(&self, target: &str, build: Option<&str>, outcome: &str) {
        let mut history = self.history.lock().expect("history poisoned");
        history.push_back(DeployRecord {
            target: target.to_string(),
            build: build.map(str::to_owned),
            outcome: outcome.to_string(),
            at_unix: now_unix(),
        });
        while history.len() > HISTORY_CAP {
            history.pop_front();
        }
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

fn is_peer_disconnect(e: &color_eyre::Report) -> bool {
    e.chain().any(|cause| {
        cause
            .downcast_ref::<std::io::Error>()
            .is_some_and(|io| matches!(io.kind(), std::io::ErrorKind::BrokenPipe | std::io::ErrorKind::ConnectionReset))
    })
}
