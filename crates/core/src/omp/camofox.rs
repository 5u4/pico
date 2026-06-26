use std::{
    net::TcpListener,
    path::{Path, PathBuf},
    process::Stdio,
    sync::Arc,
    time::Duration,
};

use color_eyre::eyre::WrapErr;
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStderr, Command as ProcCommand},
    sync::Mutex,
    time::{Instant, sleep},
};
use tokio_util::{sync::CancellationToken, task::TaskTracker};

const DEFAULT_PORT: u16 = 9377;
const HEALTH_TIMEOUT: Duration = Duration::from_secs(15);
const HEALTH_POLL: Duration = Duration::from_millis(250);
const RETRY_COOLDOWN: Duration = Duration::from_secs(30);
const TERM_GRACE: Duration = Duration::from_secs(5);
const HEALTH_FAILS_BEFORE_RESPAWN: u32 = 3;
const DAEMON_IDLE: Duration = Duration::from_secs(super::pool::IDLE_TIMEOUT.as_secs() * 2);
const DAEMON_MAX_TABS: u32 = 30;

const BIN: &str = "camofox-browser";
const FETCH_CMD: &str = "camofox-fetch-engine";

struct State {
    child: Option<Child>,
    retry_after: Option<Instant>,
    health_failures: u32,
}

pub struct CamofoxDaemon {
    base_url: String,
    port: u16,
    access_key: String,
    profile_dir: PathBuf,
    state: Mutex<State>,
    cancel: CancellationToken,
    tracker: TaskTracker,
}

impl CamofoxDaemon {
    pub fn new(root: &Path, cancel: CancellationToken, tracker: &TaskTracker) -> Arc<CamofoxDaemon> {
        let port = pick_free_port().unwrap_or(DEFAULT_PORT);
        let access_key = format!("{}{}", ulid::Ulid::new(), ulid::Ulid::new()).to_lowercase();
        let daemon = Arc::new(CamofoxDaemon {
            base_url: format!("http://127.0.0.1:{port}"),
            port,
            access_key,
            profile_dir: pico_shared::paths::camofox_profile_dir(root),
            state: Mutex::new(State {
                child: None,
                retry_after: None,
                health_failures: 0,
            }),
            cancel: cancel.clone(),
            tracker: tracker.clone(),
        });
        let shutdown = Arc::clone(&daemon);
        tracker.spawn(async move {
            cancel.cancelled().await;
            shutdown.terminate().await;
        });
        daemon
    }

    pub fn host_env(&self, enabled: bool) -> Vec<(String, String)> {
        vec![
            ("CAMOFOX_BASE_URL".to_owned(), self.base_url.clone()),
            ("CAMOFOX_USER_ID".to_owned(), pico_shared::paths::DEFAULT_PROFILE.to_owned()),
            ("CAMOFOX_ACCESS_KEY".to_owned(), self.access_key.clone()),
            ("CAMOFOX_ENABLED".to_owned(), if enabled { "1" } else { "0" }.to_owned()),
        ]
    }

    pub async fn ensure_started(&self) {
        let mut st = self.state.lock().await;

        let alive = matches!(st.child.as_mut().map(|c| c.try_wait()), Some(Ok(None)));
        if alive {
            if self.health_ok().await {
                st.health_failures = 0;
                return;
            }
            st.health_failures += 1;
            if st.health_failures < HEALTH_FAILS_BEFORE_RESPAWN {
                return;
            }
            tracing::warn!(
                port = self.port,
                fails = st.health_failures,
                "camofox daemon unhealthy; respawning"
            );
        }
        if let Some(mut old) = st.child.take() {
            let _ = old.start_kill();
            self.tracker.spawn(async move {
                let _ = old.wait().await;
            });
        }
        st.health_failures = 0;
        if self.cancel.is_cancelled() || st.retry_after.is_some_and(|t| Instant::now() < t) {
            return;
        }

        match self.spawn() {
            Ok(child) => {
                st.child = Some(child);
                if self.wait_healthy().await {
                    st.retry_after = None;
                } else {
                    tracing::warn!(port = self.port, "camofox daemon did not become healthy in time");
                    st.retry_after = Some(Instant::now() + RETRY_COOLDOWN);
                }
            }
            Err(e) => {
                tracing::warn!(error = %format!("{e:#}"), "spawning camofox daemon failed");
                st.retry_after = Some(Instant::now() + RETRY_COOLDOWN);
            }
        }
    }

    fn daemon_env(&self) -> Vec<(String, String)> {
        vec![
            ("CAMOFOX_PORT".to_owned(), self.port.to_string()),
            ("CAMOFOX_ACCESS_KEY".to_owned(), self.access_key.clone()),
            ("CAMOFOX_CRASH_REPORT_ENABLED".to_owned(), "false".to_owned()),
            ("NODE_ENV".to_owned(), "production".to_owned()),
            (
                "CAMOFOX_PROFILE_DIR".to_owned(),
                self.profile_dir.to_string_lossy().into_owned(),
            ),
            ("SESSION_TIMEOUT_MS".to_owned(), DAEMON_IDLE.as_millis().to_string()),
            ("TAB_INACTIVITY_MS".to_owned(), DAEMON_IDLE.as_millis().to_string()),
            ("BROWSER_IDLE_TIMEOUT_MS".to_owned(), DAEMON_IDLE.as_millis().to_string()),
            ("MAX_TABS_PER_SESSION".to_owned(), DAEMON_MAX_TABS.to_string()),
        ]
    }

    fn spawn(&self) -> color_eyre::Result<Child> {
        std::fs::create_dir_all(&self.profile_dir)
            .wrap_err_with(|| format!("create camofox profile dir {}", self.profile_dir.display()))?;
        let mut cmd = ProcCommand::new(BIN);
        for (k, v) in self.daemon_env() {
            cmd.env(k, v);
        }
        cmd.stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        let mut child = cmd.spawn().wrap_err("spawn `camofox-browser`")?;
        if let Some(stderr) = child.stderr.take() {
            self.tracker.spawn(drain_stderr(stderr, self.cancel.clone()));
        }
        tracing::info!(port = self.port, "spawned camofox daemon");
        Ok(child)
    }

    async fn wait_healthy(&self) -> bool {
        let deadline = Instant::now() + HEALTH_TIMEOUT;
        loop {
            if self.health_ok().await {
                return true;
            }
            if Instant::now() >= deadline || self.cancel.is_cancelled() {
                return false;
            }
            sleep(HEALTH_POLL).await;
        }
    }

    async fn health_ok(&self) -> bool {
        http_get_ok(self.port, "/health", &self.access_key).await
    }

    async fn terminate(&self) {
        let mut st = self.state.lock().await;
        if let Some(child) = st.child.as_mut()
            && let Some(pid) = child.id()
        {
            unsafe {
                libc::kill(pid as libc::pid_t, libc::SIGTERM);
            }
            let _ = tokio::time::timeout(TERM_GRACE, child.wait()).await;
        }
        st.child = None;
    }
}

fn pick_free_port() -> Option<u16> {
    TcpListener::bind(("127.0.0.1", 0))
        .ok()
        .and_then(|l| l.local_addr().ok())
        .map(|addr| addr.port())
}

pub async fn ensure_engine(cancel: CancellationToken) {
    if engine_present() {
        return;
    }
    tracing::info!("Camoufox engine missing; fetching (~650 MB, one-time)");
    let child = ProcCommand::new(FETCH_CMD)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .kill_on_drop(true)
        .spawn();
    let mut child = match child {
        Ok(child) => child,
        Err(e) => {
            tracing::warn!(error = %e, command = FETCH_CMD, "could not fetch Camoufox engine (image deps missing?)");
            return;
        }
    };
    let waited = tokio::select! {
        () = cancel.cancelled() => None,
        status = child.wait() => Some(status),
    };
    match waited {
        None => {
            let _ = child.start_kill();
            let _ = child.wait().await;
        }
        Some(Ok(status)) if status.success() => tracing::info!("Camoufox engine ready"),
        Some(Ok(status)) => tracing::warn!(
            code = ?status.code(),
            "fetching Camoufox engine failed; browser tools stay unavailable until it succeeds",
        ),
        Some(Err(e)) => tracing::warn!(error = %e, "waiting on Camoufox engine fetch failed"),
    }
}

fn engine_present() -> bool {
    std::env::var_os("HOME").is_some_and(|home| Path::new(&home).join(".cache/camoufox/version.json").is_file())
}

async fn http_get_ok(port: u16, path: &str, bearer: &str) -> bool {
    let attempt = async {
        let mut stream = tokio::net::TcpStream::connect(("127.0.0.1", port)).await.ok()?;
        let req = format!(
            "GET {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer {bearer}\r\nConnection: close\r\n\r\n"
        );
        stream.write_all(req.as_bytes()).await.ok()?;
        let mut head = Vec::with_capacity(32);
        let mut chunk = [0u8; 32];
        while head.len() < 12 {
            let n = stream.read(&mut chunk).await.ok()?;
            if n == 0 {
                break;
            }
            head.extend_from_slice(&chunk[..n]);
        }
        Some(head.starts_with(b"HTTP/1.1 200") || head.starts_with(b"HTTP/1.0 200"))
    };
    tokio::time::timeout(Duration::from_secs(3), attempt)
        .await
        .ok()
        .flatten()
        .unwrap_or(false)
}

async fn drain_stderr(stderr: ChildStderr, cancel: CancellationToken) {
    let mut lines = BufReader::new(stderr).lines();
    loop {
        tokio::select! {
            () = cancel.cancelled() => break,
            line = lines.next_line() => match line {
                Ok(Some(line)) => tracing::warn!(target: "camofox", "{line}"),
                _ => break,
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pick_free_port_returns_a_port() {
        assert!(pick_free_port().is_some());
    }

    #[tokio::test]
    async fn host_env_carries_pinned_url_default_profile_and_key() {
        let tmp = std::env::temp_dir().join(format!("pico-camo-{}", ulid::Ulid::new()));
        let cancel = CancellationToken::new();
        let tracker = TaskTracker::new();
        let daemon = CamofoxDaemon::new(&tmp, cancel, &tracker);

        let map: std::collections::HashMap<_, _> = daemon.host_env(true).into_iter().collect();
        assert_eq!(map["CAMOFOX_BASE_URL"], daemon.base_url);
        assert!(map["CAMOFOX_BASE_URL"].starts_with("http://127.0.0.1:"));
        assert_eq!(map["CAMOFOX_USER_ID"], "default");
        assert_eq!(map["CAMOFOX_ACCESS_KEY"], daemon.access_key);
        assert!(!daemon.access_key.is_empty());
        assert_eq!(map["CAMOFOX_ENABLED"], "1");

        let disabled: std::collections::HashMap<_, _> = daemon.host_env(false).into_iter().collect();
        assert_eq!(disabled["CAMOFOX_ENABLED"], "0");

        std::fs::remove_dir_all(&tmp).ok();
    }

    #[tokio::test]
    async fn daemon_env_extends_idle_beyond_thread_session() {
        let tmp = std::env::temp_dir().join(format!("pico-camo-{}", ulid::Ulid::new()));
        let cancel = CancellationToken::new();
        let tracker = TaskTracker::new();
        let daemon = CamofoxDaemon::new(&tmp, cancel, &tracker);

        let map: std::collections::HashMap<_, _> = daemon.daemon_env().into_iter().collect();
        let idle = DAEMON_IDLE.as_millis().to_string();
        assert_eq!(map["SESSION_TIMEOUT_MS"], idle);
        assert_eq!(map["TAB_INACTIVITY_MS"], idle);
        assert_eq!(map["BROWSER_IDLE_TIMEOUT_MS"], idle);
        assert_eq!(map["MAX_TABS_PER_SESSION"], DAEMON_MAX_TABS.to_string());
        assert!(DAEMON_IDLE > crate::omp::pool::IDLE_TIMEOUT);
        assert!(!map["CAMOFOX_PROFILE_DIR"].is_empty());

        std::fs::remove_dir_all(&tmp).ok();
    }

    #[tokio::test]
    async fn health_ok_reads_status_line() {
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            let (mut s, _) = listener.accept().await.unwrap();
            let mut buf = [0u8; 1024];
            let _ = s.read(&mut buf).await;
            let _ = s.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n").await;
        });
        assert!(http_get_ok(port, "/health", "k").await);

        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            let (mut s, _) = listener.accept().await.unwrap();
            let mut buf = [0u8; 1024];
            let _ = s.read(&mut buf).await;
            let _ = s.write_all(b"HTTP/1.1 503 Service Unavailable\r\n\r\n").await;
        });
        assert!(!http_get_ok(port, "/health", "k").await);

        let dead = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let dead_port = dead.local_addr().unwrap().port();
        drop(dead);
        assert!(!http_get_ok(dead_port, "/health", "k").await);
    }
}
