use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use parking_lot::Mutex;
use tokio::sync::mpsc;
use tokio_util::{sync::CancellationToken, task::TaskTracker};

use crate::omp::{
    client::{HostConfig, OmpHost, OmpSessionHandle, SessionConfig},
    protocol::OmpEvent,
};

type HostSlot = Arc<tokio::sync::Mutex<Option<Arc<OmpHost>>>>;

type RendererSlot = Arc<Mutex<Option<mpsc::UnboundedSender<OmpEvent>>>>;

type LauncherSlot = Arc<Mutex<Option<Arc<dyn BackgroundTurnLauncher>>>>;

pub(crate) const IDLE_TIMEOUT: Duration = Duration::from_secs(10 * 60);

const SWEEP_INTERVAL: Duration = Duration::from_secs(60);

pub trait BackgroundTurnLauncher: Send + Sync {
    fn launch(
        &self,
        thread_id: String,
        client: OmpSessionHandle,
        token: TurnToken,
        events: mpsc::UnboundedReceiver<OmpEvent>,
    );
}

struct RendererGuard {
    slot: RendererSlot,
}

impl Drop for RendererGuard {
    fn drop(&mut self) {
        *self.slot.lock() = None;
    }
}

pub struct TurnToken {
    _turn: tokio::sync::OwnedMutexGuard<()>,
    _renderer: RendererGuard,
}

pub struct ThreadHandle {
    client: OmpSessionHandle,
    turn_lock: Arc<tokio::sync::Mutex<()>>,
    renderer: RendererSlot,
    last_active: AtomicU64,
    profile: String,
}

impl ThreadHandle {
    pub async fn begin_turn(&self) -> (TurnToken, mpsc::UnboundedReceiver<OmpEvent>) {
        self.last_active.store(now_millis(), Ordering::Relaxed);
        let turn = Arc::clone(&self.turn_lock).lock_owned().await;
        let rx = self.install_renderer();
        (
            TurnToken {
                _turn: turn,
                _renderer: RendererGuard {
                    slot: Arc::clone(&self.renderer),
                },
            },
            rx,
        )
    }

    fn install_renderer(&self) -> mpsc::UnboundedReceiver<OmpEvent> {
        let (tx, rx) = mpsc::unbounded_channel();
        *self.renderer.lock() = Some(tx);
        rx
    }

    pub fn profile(&self) -> &str {
        &self.profile
    }

    pub fn client(&self) -> &OmpSessionHandle {
        &self.client
    }

    fn is_busy(&self) -> bool {
        self.turn_lock.try_lock().is_err()
    }

    async fn close(&self) -> color_eyre::Result<()> {
        self.client.close().await
    }
}

pub struct OmpPool {
    root: PathBuf,
    host_config: HostConfig,
    hosts: tokio::sync::Mutex<HashMap<String, HostSlot>>,
    sessions: Mutex<HashMap<String, Arc<ThreadHandle>>>,
    open_lock: tokio::sync::Mutex<()>,
    launcher: LauncherSlot,
    cancel: CancellationToken,
    tracker: TaskTracker,
}

#[derive(PartialEq, Eq, Debug)]
pub enum CloseOutcome {
    Absent,
    Closed,
    Busy,
}

impl OmpPool {
    pub fn new(
        root: PathBuf,
        host_config: HostConfig,
        cancel: CancellationToken,
        tracker: &TaskTracker,
    ) -> Arc<OmpPool> {
        let pool = Arc::new(OmpPool {
            root,
            host_config,
            hosts: tokio::sync::Mutex::new(HashMap::new()),
            sessions: Mutex::new(HashMap::new()),
            open_lock: tokio::sync::Mutex::new(()),
            launcher: Arc::new(Mutex::new(None)),
            cancel: cancel.clone(),
            tracker: tracker.clone(),
        });
        let evictor = Arc::clone(&pool);
        tracker.spawn(async move {
            let mut tick = tokio::time::interval(SWEEP_INTERVAL);
            tick.tick().await;
            loop {
                tokio::select! {
                    () = cancel.cancelled() => break,
                    _ = tick.tick() => evictor.evict_idle().await,
                }
            }
        });
        pool
    }

    pub fn set_background_launcher(&self, launcher: Arc<dyn BackgroundTurnLauncher>) {
        *self.launcher.lock() = Some(launcher);
    }

    async fn host(&self, profile: &str) -> color_eyre::Result<Arc<OmpHost>> {
        let slot = {
            let mut hosts = self.hosts.lock().await;
            Arc::clone(
                hosts
                    .entry(profile.to_owned())
                    .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(None))),
            )
        };
        let mut guard = slot.lock().await;
        if let Some(host) = guard.as_ref()
            && host.is_alive()
        {
            return Ok(Arc::clone(host));
        }
        if guard.is_some() {
            self.sessions.lock().retain(|_, handle| handle.profile != profile);
            tracing::warn!(profile = %profile, "omp host was dead; respawned and reset this profile's sessions");
        }
        let config = profile_host_config(&self.host_config, &self.root, profile);
        let host = OmpHost::spawn(&config, &self.cancel, &self.tracker).await?;
        *guard = Some(Arc::clone(&host));
        Ok(host)
    }

    pub async fn get_or_spawn(&self, thread_id: &str, config: &SessionConfig) -> color_eyre::Result<Arc<ThreadHandle>> {
        if let Some(handle) = self.sessions.lock().get(thread_id)
            && handle.profile == config.profile
        {
            return Ok(Arc::clone(handle));
        }

        let host = self.host(&config.profile).await?;
        let _open = self.open_lock.lock().await;
        if let Some(handle) = self.sessions.lock().get(thread_id)
            && handle.profile == config.profile
        {
            return Ok(Arc::clone(handle));
        }

        let (client, events) = host.open_session(thread_id, config).await?;
        tracing::debug!(thread_id, profile = %config.profile, session_id = %client.session_id(), "opened omp session");
        let handle = Arc::new(ThreadHandle {
            client,
            turn_lock: Arc::new(tokio::sync::Mutex::new(())),
            renderer: Arc::new(Mutex::new(None)),
            last_active: AtomicU64::new(now_millis()),
            profile: config.profile.clone(),
        });
        self.spawn_pump(thread_id.to_owned(), &handle, events);
        self.sessions.lock().insert(thread_id.to_owned(), Arc::clone(&handle));
        Ok(handle)
    }

    fn spawn_pump(&self, thread_id: String, handle: &Arc<ThreadHandle>, mut events: mpsc::UnboundedReceiver<OmpEvent>) {
        let renderer = Arc::clone(&handle.renderer);
        let turn_lock = Arc::clone(&handle.turn_lock);
        let launcher = Arc::clone(&self.launcher);
        let client = handle.client.clone();
        let cancel = self.cancel.clone();
        self.tracker.spawn(async move {
            loop {
                let event = tokio::select! {
                    () = cancel.cancelled() => break,
                    recv = events.recv() => match recv {
                        Some(event) => event,
                        None => break,
                    },
                };
                forward_or_launch(&thread_id, &client, &renderer, &turn_lock, &launcher, event).await;
            }
        });
    }

    pub async fn forget(&self, thread_id: &str) {
        let handle = self.sessions.lock().remove(thread_id);
        if let Some(handle) = handle
            && let Err(e) = handle.close().await
        {
            tracing::debug!(error = %format!("{e:#}"), thread_id, "close on forget failed (session already gone)");
        }
    }

    pub async fn close(&self, thread_id: &str) -> CloseOutcome {
        let handle = {
            let mut map = self.sessions.lock();
            let outcome = close_decision(map.get(thread_id).map(Arc::strong_count));
            if outcome != CloseOutcome::Closed {
                return outcome;
            }
            map.remove(thread_id)
        };
        if let Some(handle) = handle
            && let Err(e) = handle.close().await
        {
            tracing::warn!(error = %format!("{e:#}"), thread_id, "close_session failed");
        }
        CloseOutcome::Closed
    }

    pub async fn complete(&self, profile: &str, system: &str, prompt: &str) -> Option<String> {
        let host = match self.host(profile).await {
            Ok(host) => host,
            Err(e) => {
                tracing::warn!(error = %format!("{e:#}"), "spawning omp host for completion failed");
                return None;
            }
        };
        match host.completion(system, prompt).await {
            Ok(result) => result,
            Err(e) => {
                tracing::warn!(error = %format!("{e:#}"), "omp host completion failed");
                None
            }
        }
    }

    async fn evict_idle(&self) {
        let now = now_millis();
        let cutoff = IDLE_TIMEOUT.as_millis() as u64;
        let evicted: Vec<(String, Arc<ThreadHandle>)> = {
            let mut map = self.sessions.lock();
            let mut drained = Vec::new();
            map.retain(|thread_id, handle| {
                let idle = now.saturating_sub(handle.last_active.load(Ordering::Relaxed)) > cutoff;
                if idle && Arc::strong_count(handle) == 1 && !handle.is_busy() {
                    drained.push((thread_id.clone(), Arc::clone(handle)));
                    false
                } else {
                    true
                }
            });
            drained
        };
        for (thread_id, handle) in evicted {
            match handle.close().await {
                Ok(()) => tracing::debug!(thread_id = thread_id.as_str(), "evicted idle omp session"),
                Err(e) => {
                    tracing::warn!(error = %format!("{e:#}"), thread_id = thread_id.as_str(), "closing an idle session failed")
                }
            }
        }
    }

    #[doc(hidden)]
    pub async fn host_count(&self) -> usize {
        self.hosts.lock().await.len()
    }
}

async fn forward_or_launch(
    thread_id: &str,
    client: &OmpSessionHandle,
    renderer: &RendererSlot,
    turn_lock: &Arc<tokio::sync::Mutex<()>>,
    launcher: &LauncherSlot,
    mut event: OmpEvent,
) {
    loop {
        let sink = renderer.lock().clone();
        if let Some(tx) = sink {
            match tx.send(event) {
                Ok(()) => return,
                Err(mpsc::error::SendError(returned)) => {
                    event = returned;
                    tokio::task::yield_now().await;
                    continue;
                }
            }
        }
        if !starts_background_turn(&event) {
            return;
        }
        let Ok(turn) = Arc::clone(turn_lock).try_lock_owned() else {
            tokio::task::yield_now().await;
            continue;
        };
        let launcher = launcher.lock().clone();
        let Some(launcher) = launcher else {
            return;
        };
        let (tx, rx) = mpsc::unbounded_channel();
        *renderer.lock() = Some(tx.clone());
        let token = TurnToken {
            _turn: turn,
            _renderer: RendererGuard {
                slot: Arc::clone(renderer),
            },
        };
        let _ = tx.send(event);
        launcher.launch(thread_id.to_owned(), client.clone(), token, rx);
        return;
    }
}

fn starts_background_turn(event: &OmpEvent) -> bool {
    matches!(event, OmpEvent::AgentStart)
}

fn profile_host_config(base: &HostConfig, root: &Path, profile: &str) -> HostConfig {
    let mut env = base.env.clone();
    env.push((
        "PICO_PROFILE_DIR".to_owned(),
        pico_shared::paths::profile_dir(root, profile)
            .to_string_lossy()
            .into_owned(),
    ));
    HostConfig { env }
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn close_decision(strong_count: Option<usize>) -> CloseOutcome {
    match strong_count {
        None => CloseOutcome::Absent,
        Some(c) if c > 1 => CloseOutcome::Busy,
        Some(_) => CloseOutcome::Closed,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn evictor_stops_on_cancel_so_the_tracker_drains() {
        let cancel = CancellationToken::new();
        let tracker = TaskTracker::new();
        let _pool = OmpPool::new(
            std::path::PathBuf::from("/tmp"),
            HostConfig::default(),
            cancel.clone(),
            &tracker,
        );
        cancel.cancel();
        tracker.close();
        tokio::time::timeout(Duration::from_secs(5), tracker.wait())
            .await
            .expect("evictor ignored cancellation; shutdown drain would hang");
    }

    #[tokio::test]
    async fn close_absent_thread_reports_absent() {
        let cancel = CancellationToken::new();
        let tracker = TaskTracker::new();
        let pool = OmpPool::new(
            std::path::PathBuf::from("/tmp"),
            HostConfig::default(),
            cancel.clone(),
            &tracker,
        );
        assert_eq!(pool.close("222222222222222222").await, CloseOutcome::Absent);
        cancel.cancel();
        tracker.close();
    }

    #[test]
    fn close_decision_busy_guard_thresholds() {
        assert_eq!(close_decision(None), CloseOutcome::Absent);
        assert_eq!(close_decision(Some(1)), CloseOutcome::Closed);
        assert_eq!(close_decision(Some(2)), CloseOutcome::Busy);
    }

    #[test]
    fn profile_host_config_appends_profile_dir_env() {
        let base = HostConfig {
            env: vec![("CAMOFOX_BASE_URL".to_owned(), "http://127.0.0.1:9377".to_owned())],
        };
        let alpha = profile_host_config(&base, Path::new("/srv/pico"), "alpha");
        let map: HashMap<String, String> = alpha.env.into_iter().collect();
        assert_eq!(map["CAMOFOX_BASE_URL"], "http://127.0.0.1:9377");
        assert_eq!(map["PICO_PROFILE_DIR"], "/srv/pico/profiles/alpha");

        let beta = profile_host_config(&base, Path::new("/srv/pico"), "beta");
        let beta_map: HashMap<String, String> = beta.env.into_iter().collect();
        assert_eq!(beta_map["PICO_PROFILE_DIR"], "/srv/pico/profiles/beta");
        assert_ne!(map["PICO_PROFILE_DIR"], beta_map["PICO_PROFILE_DIR"]);
    }

    #[test]
    fn only_agent_start_launches_a_background_turn() {
        use crate::omp::protocol::AssistantMessageEvent;

        assert!(starts_background_turn(&OmpEvent::AgentStart));
        assert!(!starts_background_turn(&OmpEvent::AgentEnd));
        assert!(!starts_background_turn(&OmpEvent::TurnEnd));
        assert!(!starts_background_turn(&OmpEvent::UiRequest(
            crate::omp::protocol::UiRequest::Ignore
        )));
        assert!(!starts_background_turn(&OmpEvent::CustomMessage {
            custom_type: "async-result".to_owned()
        }));
        assert!(!starts_background_turn(&OmpEvent::Message(AssistantMessageEvent::TextEnd {
            content: "hi".to_owned()
        })));
    }
}
