//! Per-Discord-thread `omp --mode rpc` child registry. One child per thread,
//! keyed by thread id; lazily spawned on first use and idle-evicted after
//! [`IDLE_TIMEOUT`]. A respawn resumes the thread's session via the child's
//! `--session-dir` + `--continue`, so eviction is transparent to the user —
//! it only adds cold-start latency, never loses conversation history.

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
    client::{OmpClient, SpawnConfig},
    protocol::OmpEvent,
};

const IDLE_TIMEOUT: Duration = Duration::from_secs(10 * 60);

const SWEEP_INTERVAL: Duration = Duration::from_secs(60);

/// One thread's live `omp` child and its event stream. Guarded by a per-thread
/// async mutex so turns on the same thread serialise; different threads run on
/// separate children and proceed concurrently.
pub struct ThreadSession {
    pub client: OmpClient,
    pub events: mpsc::UnboundedReceiver<OmpEvent>,
}

pub struct ThreadHandle {
    inner: tokio::sync::Mutex<ThreadSession>,
    last_active: AtomicU64,
}

impl ThreadHandle {
    /// Lock the session for a turn, stamping it active so the evictor leaves it
    /// alone. The guard borrows the client + event stream for the whole turn.
    pub async fn lock(&self) -> tokio::sync::MutexGuard<'_, ThreadSession> {
        self.last_active.store(now_millis(), Ordering::Relaxed);
        self.inner.lock().await
    }
}

pub struct OmpPool {
    sessions: Mutex<HashMap<String, Arc<ThreadHandle>>>,
    cancel: CancellationToken,
    tracker: TaskTracker,
}

impl OmpPool {
    /// Build the pool and spawn its idle-evictor on `tracker`. The sweep stops
    /// at the next tick once `cancel` fires, so worker shutdown joins it via the
    /// tracker rather than aborting mid-sweep. `cancel`/`tracker` are also handed
    /// to each spawned `omp` child's stdio tasks.
    pub fn new(cancel: CancellationToken, tracker: &TaskTracker) -> Arc<OmpPool> {
        let pool = Arc::new(OmpPool {
            sessions: Mutex::new(HashMap::new()),
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
                    _ = tick.tick() => evictor.evict_idle(),
                }
            }
        });
        pool
    }

    /// Return the thread's handle, spawning the `omp` child if absent or
    /// previously evicted. `config` is recomputed by the caller each turn (cwd,
    /// model, `--session-dir`, `--continue`), so a respawn resumes the session.
    pub async fn get_or_spawn(&self, thread_id: &str, config: &SpawnConfig) -> color_eyre::Result<Arc<ThreadHandle>> {
        if let Some(handle) = self.sessions.lock().get(thread_id) {
            return Ok(Arc::clone(handle));
        }

        // Spawn outside the map lock (spawn awaits the child's ready frame).
        let (client, events) = OmpClient::spawn(config, &self.cancel, &self.tracker).await?;
        let handle = Arc::new(ThreadHandle {
            inner: tokio::sync::Mutex::new(ThreadSession { client, events }),
            last_active: AtomicU64::new(now_millis()),
        });

        let mut map = self.sessions.lock();
        // A concurrent caller may have spawned the same thread's child while we
        // were awaiting ready; keep theirs and let ours drop (kill_on_drop).
        if let Some(existing) = map.get(thread_id) {
            return Ok(Arc::clone(existing));
        }
        map.insert(thread_id.to_owned(), Arc::clone(&handle));
        Ok(handle)
    }

    /// Drop a dead thread's child so the next [`get_or_spawn`](Self::get_or_spawn)
    /// respawns it (resuming via `--continue`); `kill_on_drop` fires once the turn releases its clone.
    pub(crate) fn forget(&self, thread_id: &str) {
        self.sessions.lock().remove(thread_id);
    }

    /// Drop children idle past [`IDLE_TIMEOUT`]. `strong_count == 1` means only
    /// the map references the handle, i.e. no turn is in flight (a turn holds a
    /// clone for its whole duration); checking it under the map lock — which
    /// `get_or_spawn` also needs to hand out a clone — closes the race. Dropping
    /// the handle kills the child via `kill_on_drop`.
    fn evict_idle(&self) {
        let now = now_millis();
        let cutoff = IDLE_TIMEOUT.as_millis() as u64;
        self.sessions.lock().retain(|_, handle| {
            !(now.saturating_sub(handle.last_active.load(Ordering::Relaxed)) > cutoff && Arc::strong_count(handle) == 1)
        });
    }
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn evictor_stops_on_cancel_so_the_tracker_drains() {
        let cancel = CancellationToken::new();
        let tracker = TaskTracker::new();
        let _pool = OmpPool::new(cancel.clone(), &tracker);
        cancel.cancel();
        tracker.close();
        tokio::time::timeout(Duration::from_secs(5), tracker.wait())
            .await
            .expect("evictor ignored cancellation; shutdown drain would hang");
    }
}
