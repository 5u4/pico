use std::{
    collections::HashMap,
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

const IDLE_TIMEOUT: Duration = Duration::from_secs(10 * 60);

const SWEEP_INTERVAL: Duration = Duration::from_secs(60);

pub struct ThreadSession {
    pub client: OmpSessionHandle,
    pub events: mpsc::UnboundedReceiver<OmpEvent>,
}

pub struct ThreadHandle {
    inner: tokio::sync::Mutex<ThreadSession>,
    last_active: AtomicU64,
}

impl ThreadHandle {
    pub async fn lock(&self) -> tokio::sync::MutexGuard<'_, ThreadSession> {
        self.last_active.store(now_millis(), Ordering::Relaxed);
        self.inner.lock().await
    }

    async fn close(&self) -> color_eyre::Result<()> {
        self.inner.lock().await.client.close().await
    }
}

pub struct OmpPool {
    host_config: HostConfig,
    host: tokio::sync::Mutex<Option<Arc<OmpHost>>>,
    sessions: Mutex<HashMap<String, Arc<ThreadHandle>>>,
    open_lock: tokio::sync::Mutex<()>,
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
    pub fn new(host_config: HostConfig, cancel: CancellationToken, tracker: &TaskTracker) -> Arc<OmpPool> {
        let pool = Arc::new(OmpPool {
            host_config,
            host: tokio::sync::Mutex::new(None),
            sessions: Mutex::new(HashMap::new()),
            open_lock: tokio::sync::Mutex::new(()),
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

    async fn host(&self) -> color_eyre::Result<Arc<OmpHost>> {
        let mut slot = self.host.lock().await;
        if let Some(host) = slot.as_ref() {
            if host.is_alive() {
                return Ok(Arc::clone(host));
            }
            self.sessions.lock().clear();
        }
        let host = OmpHost::spawn(&self.host_config, &self.cancel, &self.tracker).await?;
        *slot = Some(Arc::clone(&host));
        Ok(host)
    }

    pub async fn get_or_spawn(&self, thread_id: &str, config: &SessionConfig) -> color_eyre::Result<Arc<ThreadHandle>> {
        let host = self.host().await?;
        if let Some(handle) = self.sessions.lock().get(thread_id) {
            return Ok(Arc::clone(handle));
        }

        let _open = self.open_lock.lock().await;
        if let Some(handle) = self.sessions.lock().get(thread_id) {
            return Ok(Arc::clone(handle));
        }

        let (client, events) = host.open_session(thread_id, config).await?;
        let handle = Arc::new(ThreadHandle {
            inner: tokio::sync::Mutex::new(ThreadSession { client, events }),
            last_active: AtomicU64::new(now_millis()),
        });
        self.sessions.lock().insert(thread_id.to_owned(), Arc::clone(&handle));
        Ok(handle)
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

    pub async fn complete(&self, system: &str, prompt: &str) -> Option<String> {
        let host = match self.host().await {
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
        let evicted: Vec<Arc<ThreadHandle>> = {
            let mut map = self.sessions.lock();
            let mut drained = Vec::new();
            map.retain(|_, handle| {
                let idle = now.saturating_sub(handle.last_active.load(Ordering::Relaxed)) > cutoff;
                if idle && Arc::strong_count(handle) == 1 {
                    drained.push(Arc::clone(handle));
                    false
                } else {
                    true
                }
            });
            drained
        };
        for handle in evicted {
            if let Err(e) = handle.close().await {
                tracing::warn!(error = %format!("{e:#}"), "closing an idle session failed");
            }
        }
    }
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
        let _pool = OmpPool::new(HostConfig::default(), cancel.clone(), &tracker);
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
        let pool = OmpPool::new(HostConfig::default(), cancel.clone(), &tracker);
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
}
