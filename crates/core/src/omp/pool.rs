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

const SMOL_RESOLVE_TIMEOUT: Duration = Duration::from_secs(15);

pub struct ThreadSession {
    pub client: OmpClient,
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
}

pub struct OmpPool {
    sessions: Mutex<HashMap<String, Arc<ThreadHandle>>>,
    cancel: CancellationToken,
    tracker: TaskTracker,
    smol: tokio::sync::OnceCell<Option<String>>,
}

#[derive(PartialEq, Eq, Debug)]
pub(crate) enum CloseOutcome {
    Absent,
    Closed,
    Busy,
}

impl OmpPool {
    pub fn new(cancel: CancellationToken, tracker: &TaskTracker) -> Arc<OmpPool> {
        let pool = Arc::new(OmpPool {
            sessions: Mutex::new(HashMap::new()),
            cancel: cancel.clone(),
            tracker: tracker.clone(),
            smol: tokio::sync::OnceCell::new(),
        });
        let warm = Arc::clone(&pool);
        tracker.spawn(async move {
            tokio::select! {
                () = warm.cancel.cancelled() => {}
                _ = warm.smol_model() => {}
            }
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

    pub async fn get_or_spawn(&self, thread_id: &str, config: &SpawnConfig) -> color_eyre::Result<Arc<ThreadHandle>> {
        if let Some(handle) = self.sessions.lock().get(thread_id) {
            return Ok(Arc::clone(handle));
        }

        let (client, events) = OmpClient::spawn(config, &self.cancel, &self.tracker).await?;
        let handle = Arc::new(ThreadHandle {
            inner: tokio::sync::Mutex::new(ThreadSession { client, events }),
            last_active: AtomicU64::new(now_millis()),
        });

        let mut map = self.sessions.lock();
        if let Some(existing) = map.get(thread_id) {
            return Ok(Arc::clone(existing));
        }
        map.insert(thread_id.to_owned(), Arc::clone(&handle));
        Ok(handle)
    }

    pub(crate) fn forget(&self, thread_id: &str) {
        self.sessions.lock().remove(thread_id);
    }

    pub(crate) fn close(&self, thread_id: &str) -> CloseOutcome {
        let mut map = self.sessions.lock();
        let outcome = close_decision(map.get(thread_id).map(Arc::strong_count));
        if outcome == CloseOutcome::Closed {
            map.remove(thread_id);
        }
        outcome
    }

    pub async fn smol_model(&self) -> Option<String> {
        match self.smol.get_or_try_init(resolve_smol_model).await {
            Ok(model) => model.clone(),
            Err(()) => None,
        }
    }

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

fn close_decision(strong_count: Option<usize>) -> CloseOutcome {
    match strong_count {
        None => CloseOutcome::Absent,
        Some(c) if c > 1 => CloseOutcome::Busy,
        Some(_) => CloseOutcome::Closed,
    }
}

async fn resolve_smol_model() -> Result<Option<String>, ()> {
    let mut cmd = tokio::process::Command::new("omp");
    cmd.arg("config")
        .arg("get")
        .arg("modelRoles")
        .arg("--json")
        .kill_on_drop(true);
    let raw = match tokio::time::timeout(SMOL_RESOLVE_TIMEOUT, pico_shared::proc::run(&mut cmd)).await {
        Ok(Ok(raw)) => raw,
        Ok(Err(e)) => {
            tracing::warn!(error = %format!("{e:#}"), "resolving omp smol model failed; retrying next thread");
            return Err(());
        }
        Err(_) => {
            tracing::warn!("resolving omp smol model timed out after {SMOL_RESOLVE_TIMEOUT:?}; retrying next thread");
            return Err(());
        }
    };
    let roles: serde_json::Value = match serde_json::from_str(&raw) {
        Ok(v) => v,
        Err(e) => {
            tracing::warn!(error = %e, "parsing omp modelRoles failed; retrying next thread");
            return Err(());
        }
    };
    match smol_from_roles(&roles) {
        Some(model) => Ok(Some(model)),
        None => {
            tracing::warn!("omp modelRoles has no smol/default model; thread titles disabled");
            Ok(None)
        }
    }
}

fn smol_from_roles(roles: &serde_json::Value) -> Option<String> {
    let value = &roles["value"];
    ["smol", "default"]
        .into_iter()
        .filter_map(|role| value.get(role).and_then(serde_json::Value::as_str))
        .find(|model| !model.is_empty())
        .map(str::to_owned)
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

    #[tokio::test]
    async fn close_absent_thread_reports_absent() {
        let cancel = CancellationToken::new();
        let tracker = TaskTracker::new();
        let pool = OmpPool::new(cancel.clone(), &tracker);
        assert_eq!(pool.close("222222222222222222"), CloseOutcome::Absent);
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
    fn smol_from_roles_prefers_smol_then_default() {
        let roles = serde_json::json!({
            "value": { "smol": "github-copilot/gpt-4o-mini", "default": "github-copilot/claude-opus" }
        });
        assert_eq!(smol_from_roles(&roles).as_deref(), Some("github-copilot/gpt-4o-mini"));
    }

    #[test]
    fn smol_from_roles_falls_back_to_default_when_smol_absent_or_empty() {
        let absent = serde_json::json!({ "value": { "default": "github-copilot/claude-opus" } });
        assert_eq!(smol_from_roles(&absent).as_deref(), Some("github-copilot/claude-opus"));
        let empty = serde_json::json!({ "value": { "smol": "", "default": "github-copilot/claude-opus" } });
        assert_eq!(smol_from_roles(&empty).as_deref(), Some("github-copilot/claude-opus"));
    }

    #[test]
    fn smol_from_roles_none_when_unset_or_empty() {
        assert_eq!(smol_from_roles(&serde_json::json!({ "value": {} })), None);
        assert_eq!(smol_from_roles(&serde_json::json!({ "value": { "smol": "" } })), None);
        assert_eq!(smol_from_roles(&serde_json::json!({})), None);
    }
}
