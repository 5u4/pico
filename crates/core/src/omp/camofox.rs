//! Worker-owned Camoufox daemon (`camofox-browser`): lazily spawned per
//! browser-enabled profile, driven by an injected omp extension over REST. One
//! per worker; the loopback port + access key are pinned so env baked into omp
//! children survives daemon restarts. Isolation is by `userId` (= profile).

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

/// Extension source, embedded so it ships in the binary; rewritten on startup.
const EXTENSION_SOURCE: &str = include_str!("camofox_extension.ts");

const DEFAULT_PORT: u16 = 9377;
const HEALTH_TIMEOUT: Duration = Duration::from_secs(15);
const HEALTH_POLL: Duration = Duration::from_millis(250);
const RETRY_COOLDOWN: Duration = Duration::from_secs(30);
const TERM_GRACE: Duration = Duration::from_secs(5);
const HEALTH_FAILS_BEFORE_RESPAWN: u32 = 3;

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
    extension_path: PathBuf,
    state: Mutex<State>,
    cancel: CancellationToken,
    tracker: TaskTracker,
}

impl CamofoxDaemon {
    /// Pins a free loopback port + access key, writes the extension, and arms a
    /// cancel-driven shutdown. Infallible: soft failures log and self-heal.
    pub fn new(root: &Path, cancel: CancellationToken, tracker: &TaskTracker) -> Arc<CamofoxDaemon> {
        let port = pick_free_port().unwrap_or(DEFAULT_PORT);
        let access_key = format!("{}{}", ulid::Ulid::new(), ulid::Ulid::new()).to_lowercase();
        let extension_path = pico_shared::paths::camofox_extension(root);
        if let Err(e) = write_extension(&extension_path) {
            tracing::warn!(error = %format!("{e:#}"), "writing camofox extension failed; browser tools will be unavailable");
        }
        let daemon = Arc::new(CamofoxDaemon {
            base_url: format!("http://127.0.0.1:{port}"),
            port,
            access_key,
            profile_dir: pico_shared::paths::camofox_profile_dir(root),
            extension_path,
            state: Mutex::new(State {
                child: None,
                retry_after: None,
                health_failures: 0,
            }),
            cancel: cancel.clone(),
            tracker: tracker.clone(),
        });
        // SIGTERM lets server.js tear down its Firefox/Xvfb tree; kill_on_drop backstops.
        let shutdown = Arc::clone(&daemon);
        tracker.spawn(async move {
            cancel.cancelled().await;
            shutdown.terminate().await;
        });
        daemon
    }

    /// Per-turn `--extension` path (omitted if the file is missing) + `CAMOFOX_*` env.
    pub fn injection(&self, profile: &str, thread_id: &str) -> (Vec<PathBuf>, Vec<(String, String)>) {
        let extensions = if self.extension_path.is_file() {
            vec![self.extension_path.clone()]
        } else {
            Vec::new()
        };
        let env = vec![
            ("CAMOFOX_BASE_URL".to_owned(), self.base_url.clone()),
            ("CAMOFOX_USER_ID".to_owned(), profile.to_owned()),
            ("CAMOFOX_SESSION_KEY".to_owned(), thread_id.to_owned()),
            ("CAMOFOX_ACCESS_KEY".to_owned(), self.access_key.clone()),
        ];
        (extensions, env)
    }

    /// Best-effort, single-flight: (re)spawn on the pinned port+key if the daemon
    /// died or hung. Never fails the caller; backs off after a failed start.
    pub async fn ensure_started(&self) {
        let mut st = self.state.lock().await;

        // A live child is trusted unless health fails repeatedly — the daemon is
        // shared, so one transient blip must not kill it mid-browse for a sibling.
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
            tracing::warn!(port = self.port, fails = st.health_failures, "camofox daemon unhealthy; respawning");
        }
        // Reap the dead/unhealthy child, then (re)spawn unless cancelled or backing off.
        if let Some(mut old) = st.child.take() {
            let _ = old.start_kill();
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

    fn spawn(&self) -> color_eyre::Result<Child> {
        std::fs::create_dir_all(&self.profile_dir)
            .wrap_err_with(|| format!("create camofox profile dir {}", self.profile_dir.display()))?;
        let mut cmd = ProcCommand::new("camofox-browser");
        cmd.env("CAMOFOX_PORT", self.port.to_string())
            .env("CAMOFOX_ACCESS_KEY", &self.access_key)
            // Telemetry phones home by default — disable it.
            .env("CAMOFOX_CRASH_REPORT_ENABLED", "false")
            // The access key (above) is what gates every route except /health
            // (camofox's accessKeyMiddleware); NODE_ENV=production is redundant
            // defense-in-depth. The server binds 0.0.0.0, but docker-compose
            // publishes no ports — reachable only inside the container's netns.
            .env("NODE_ENV", "production")
            .env("CAMOFOX_PROFILE_DIR", &self.profile_dir)
            .stdin(Stdio::null())
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

fn write_extension(path: &Path) -> color_eyre::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).wrap_err_with(|| format!("create {}", parent.display()))?;
    }
    std::fs::write(path, EXTENSION_SOURCE).wrap_err_with(|| format!("write {}", path.display()))?;
    Ok(())
}

/// Loopback `GET` reporting whether the status is 200 (avoids an HTTP-client dep).
async fn http_get_ok(port: u16, path: &str, bearer: &str) -> bool {
    let attempt = async {
        let mut stream = tokio::net::TcpStream::connect(("127.0.0.1", port)).await.ok()?;
        let req = format!(
            "GET {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer {bearer}\r\nConnection: close\r\n\r\n"
        );
        stream.write_all(req.as_bytes()).await.ok()?;
        // Loop until the status line arrives: one short read could mis-report health.
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
    tokio::time::timeout(Duration::from_secs(3), attempt).await.ok().flatten().unwrap_or(false)
}

/// Drain the daemon's stderr to the log so a full pipe can't block it.
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
    async fn injection_carries_pinned_url_key_and_per_turn_identity() {
        let tmp = std::env::temp_dir().join(format!("pico-camo-{}", ulid::Ulid::new()));
        let cancel = CancellationToken::new();
        let tracker = TaskTracker::new();
        let daemon = CamofoxDaemon::new(&tmp, cancel, &tracker);

        let (exts, env) = daemon.injection("acme", "thread-42");
        assert_eq!(exts, vec![pico_shared::paths::camofox_extension(&tmp)]);
        assert!(exts[0].is_file());

        let map: std::collections::HashMap<_, _> = env.into_iter().collect();
        assert_eq!(map["CAMOFOX_BASE_URL"], daemon.base_url);
        assert!(map["CAMOFOX_BASE_URL"].starts_with("http://127.0.0.1:"));
        assert_eq!(map["CAMOFOX_USER_ID"], "acme");
        assert_eq!(map["CAMOFOX_SESSION_KEY"], "thread-42");
        assert_eq!(map["CAMOFOX_ACCESS_KEY"], daemon.access_key);
        assert!(!daemon.access_key.is_empty());

        let (_, env2) = daemon.injection("acme", "thread-42");
        let map2: std::collections::HashMap<_, _> = env2.into_iter().collect();
        assert_eq!(map2["CAMOFOX_BASE_URL"], map["CAMOFOX_BASE_URL"]);
        assert_eq!(map2["CAMOFOX_ACCESS_KEY"], map["CAMOFOX_ACCESS_KEY"]);

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
