//! End-to-end tests for the supervisor's process orchestration: deploy,
//! rollback, stop, and graceful shutdown. Every test drives a real supervisor
//! (and the worker it spawns) over the control socket.
//!
//! Hermetic by construction: [`Fixture`] redirects `$HOME` to a fresh temp dir,
//! so a supervisor under test resolves `~/.pico` *inside* that temp dir and
//! never touches the developer's real `~/.pico`. The control socket lives under
//! `/tmp` because macOS caps `sun_path` near 104 bytes — too short for the deep
//! temp `$HOME`. Cleanup (stop the supervisor, remove the temp dir) runs on
//! `Drop`, so it happens even when a test panics.

use std::{
    io::{BufRead, BufReader, Write},
    os::unix::net::UnixStream,
    path::{Path, PathBuf},
    process::{Child, Command, ExitStatus},
    sync::{Mutex, MutexGuard},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use serde_json::Value;

/// A sibling binary in the same target dir as this test's supervisor binary.
fn bin(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_BIN_EXE_supervisor")).with_file_name(name)
}

/// `cargo test -p supervisor` builds the supervisor bin but not the worker bin
/// from the sibling crate; build it on demand so the test stands alone.
fn worker_bin() -> PathBuf {
    let worker = bin("worker");
    if !worker.exists() {
        let cargo = std::env::var("CARGO").unwrap_or_else(|_| "cargo".into());
        let status = Command::new(cargo)
            .args(["build", "-p", "worker"])
            .status()
            .expect("run cargo build -p worker");
        assert!(status.success(), "failed to build worker binary");
    }
    worker
}

/// `kill(pid, 0)` probes existence without delivering a signal.
fn alive(pid: u32) -> bool {
    unsafe { libc::kill(pid as i32, 0) == 0 }
}

fn sigterm(pid: u32) {
    unsafe {
        libc::kill(pid as i32, libc::SIGTERM);
    }
}

fn poll<T>(within: Duration, mut f: impl FnMut() -> Option<T>) -> Option<T> {
    let deadline = Instant::now() + within;
    loop {
        if let Some(v) = f() {
            return Some(v);
        }
        if Instant::now() >= deadline {
            return None;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

fn status_is(v: &Value, status: &str) -> bool {
    v["status"].as_str() == Some(status)
}

fn message(v: &Value) -> &str {
    v["message"].as_str().unwrap_or("")
}

/// Serializes the suite: each test drives a full supervisor + worker process
/// tree, and running nine of those in parallel oversubscribes the machine
/// enough that worker startup can blow the readiness timeout. Held for the
/// whole test via [`Fixture`].
static SERIAL: Mutex<()> = Mutex::new(());

/// A running supervisor with `$HOME` redirected to a private temp dir.
struct Fixture {
    // Released only after `Drop` finishes cleaning up, so the next test starts
    // against a quiet machine. Declared first so it outlives the other fields.
    _serial: MutexGuard<'static, ()>,
    home: PathBuf,
    socket: PathBuf,
    sup: Child,
}

impl Fixture {
    /// Start a supervisor. `slot`, if given, seeds the `current` slot symlink
    /// before launch so the supervisor adopts it on boot.
    fn start(slot: Option<&Path>) -> Self {
        let serial = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
        let nanos = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let home = std::env::temp_dir().join(format!("pico-it-{}-{nanos}", std::process::id()));
        let sup_dir = home.join(".pico").join("supervisor");
        let slots = sup_dir.join("slots");
        std::fs::create_dir_all(&slots).unwrap();
        let socket = PathBuf::from(format!("/tmp/pico-it-{nanos}.sock"));
        std::fs::write(
            sup_dir.join("supervisor.toml"),
            format!("health_timeout_secs = 10\nsocket_path = \"{}\"\n", socket.display()),
        )
        .unwrap();
        if let Some(slot) = slot {
            std::os::unix::fs::symlink(slot, slots.join("current")).unwrap();
        }

        let sup = Command::new(bin("supervisor"))
            .env("HOME", &home)
            .spawn()
            .expect("spawn supervisor");

        let fixture = Self {
            _serial: serial,
            home,
            socket,
            sup,
        };
        assert!(
            poll(Duration::from_secs(10), || fixture.try_request("{\"cmd\":\"status\"}")).is_some(),
            "supervisor never started serving",
        );
        fixture
    }

    fn try_request(&self, frame: &str) -> Option<Value> {
        let mut stream = UnixStream::connect(&self.socket).ok()?;
        stream.write_all(frame.as_bytes()).ok()?;
        stream.write_all(b"\n").ok()?;
        stream.flush().ok()?;
        let mut line = String::new();
        BufReader::new(&mut stream).read_line(&mut line).ok()?;
        serde_json::from_str(line.trim()).ok()
    }

    fn request(&self, frame: &str) -> Value {
        self.try_request(frame).expect("control request failed")
    }

    fn status(&self) -> Value {
        self.request("{\"cmd\":\"status\"}")
    }

    fn running_pid(&self) -> Option<u32> {
        let s = self.status();
        if s["running"].as_bool()? {
            Some(s["pid"].as_u64()? as u32)
        } else {
            None
        }
    }

    fn current_slot(&self) -> Option<String> {
        self.status()["current"].as_str().map(str::to_owned)
    }

    fn deploy_path(&self, path: &Path) -> Value {
        let path = Value::String(path.to_string_lossy().into_owned());
        self.request(&format!(
            "{{\"cmd\":\"deploy\",\"target\":{{\"kind\":\"path\",\"path\":{path}}}}}"
        ))
    }

    fn socket(&self) -> &Path {
        &self.socket
    }

    fn pid(&self) -> u32 {
        self.sup.id()
    }

    fn wait_exit(&mut self, within: Duration) -> Option<ExitStatus> {
        poll(within, || self.sup.try_wait().ok().flatten())
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        // Graceful stop (so the worker is reaped, not orphaned), force-kill if
        // it ignores us, then remove the temp $HOME — even on a panic.
        sigterm(self.sup.id());
        if poll(Duration::from_secs(10), || self.sup.try_wait().ok().flatten()).is_none() {
            let _ = self.sup.kill();
            let _ = self.sup.wait();
        }
        let _ = std::fs::remove_file(&self.socket);
        let _ = std::fs::remove_dir_all(&self.home);
    }
}

#[test]
fn deploy_then_sigterm_drains_and_stops_worker() {
    let mut fx = Fixture::start(None);
    let resp = fx.deploy_path(&worker_bin());
    assert!(status_is(&resp, "ok"), "deploy did not succeed: {resp}");
    let worker = fx.running_pid().expect("worker running after deploy");
    assert!(alive(worker));

    sigterm(fx.pid());
    let exited = fx.wait_exit(Duration::from_secs(15));
    let worker_dead = poll(Duration::from_secs(8), || (!alive(worker)).then_some(())).is_some();
    let socket_gone = !fx.socket().exists();

    assert!(
        matches!(exited, Some(st) if st.success()),
        "supervisor did not exit cleanly: {exited:?}"
    );
    assert!(worker_dead, "worker was orphaned after supervisor shutdown");
    assert!(socket_gone, "control socket left behind after shutdown");
}

#[test]
fn boot_adopts_current_slot() {
    let fx = Fixture::start(Some(&worker_bin()));
    let booted = poll(Duration::from_secs(15), || fx.running_pid());
    assert!(booted.is_some(), "supervisor did not adopt the current-slot worker on boot");
}

#[test]
fn shutdown_does_not_hang_on_idle_client() {
    let mut fx = Fixture::start(None);
    // Connect but send nothing: the handler parks in read_frame. Give it a beat
    // to reach that read so it is genuinely in-flight when the signal lands.
    let idle = UnixStream::connect(fx.socket()).expect("connect idle client");
    std::thread::sleep(Duration::from_millis(500));

    sigterm(fx.pid());
    // Must finish well under REQUEST_READ_TIMEOUT (10s), not wait the read out.
    let exited = fx.wait_exit(Duration::from_secs(8));
    let clean = matches!(exited, Some(st) if st.success());
    drop(idle);
    assert!(clean, "supervisor hung on shutdown with an idle client connected: {exited:?}");
}

#[test]
fn redeploy_replaces_worker() {
    let fx = Fixture::start(None);
    let worker = worker_bin();
    assert!(status_is(&fx.deploy_path(&worker), "ok"), "first deploy failed");
    let first = fx.running_pid().expect("worker running after first deploy");

    assert!(status_is(&fx.deploy_path(&worker), "ok"), "second deploy failed");
    let second = fx.running_pid().expect("worker running after second deploy");

    assert_ne!(first, second, "redeploy reused the same worker pid");
    assert!(
        poll(Duration::from_secs(5), || (!alive(first)).then_some(())).is_some(),
        "previous worker {first} was not stopped on redeploy",
    );
}

#[test]
fn failed_build_keeps_current_worker() {
    let fx = Fixture::start(None);
    assert!(status_is(&fx.deploy_path(&worker_bin()), "ok"), "initial deploy failed");
    let worker = fx.running_pid().expect("worker running after deploy");

    // A path that does not exist fails in the build/copy step, before the
    // running worker is touched.
    let resp = fx.deploy_path(Path::new("/nonexistent/pico-worker"));
    assert!(status_is(&resp, "error"), "missing-path deploy should fail: {resp}");
    assert!(message(&resp).contains("build failed"), "unexpected error: {resp}");
    assert_eq!(fx.running_pid(), Some(worker), "running worker changed after a failed build");
}

#[test]
fn failed_deploy_rolls_back_to_previous() {
    let fx = Fixture::start(None);
    assert!(status_is(&fx.deploy_path(&worker_bin()), "ok"), "initial deploy failed");
    let good_slot = fx.current_slot().expect("current slot after deploy");

    // A real file that is not executable: the copy succeeds but the spawn fails,
    // exercising the kill-old -> spawn-new-fails -> roll-back path.
    let junk = fx.home.join("not-a-binary");
    std::fs::write(&junk, b"not a binary").unwrap();
    let resp = fx.deploy_path(&junk);

    assert!(status_is(&resp, "error"), "non-executable deploy should fail: {resp}");
    assert!(message(&resp).contains("rolled back"), "expected rollback: {resp}");
    assert!(fx.running_pid().is_some(), "no worker running after rollback");
    assert_eq!(
        fx.current_slot().as_deref(),
        Some(good_slot.as_str()),
        "current slot moved despite rollback"
    );
}

#[test]
fn rollback_restores_previous_slot() {
    let fx = Fixture::start(None);
    let worker = worker_bin();
    let a = fx.deploy_path(&worker);
    assert!(status_is(&a, "ok"), "deploy A failed: {a}");
    let slot_a = fx.current_slot().expect("current after deploy A");
    let b = fx.deploy_path(&worker);
    assert!(status_is(&b, "ok"), "deploy B failed: {b}");
    let slot_b = fx.current_slot().expect("current after deploy B");
    assert_ne!(slot_a, slot_b, "two deploys produced the same slot");

    let resp = fx.request("{\"cmd\":\"rollback\"}");
    assert!(status_is(&resp, "ok"), "rollback failed: {resp}");
    assert!(fx.running_pid().is_some(), "no worker running after rollback");
    assert_eq!(
        fx.current_slot().as_deref(),
        Some(slot_a.as_str()),
        "rollback did not restore the previous slot"
    );
}

#[test]
fn rollback_without_previous_errors() {
    let fx = Fixture::start(None);
    let resp = fx.request("{\"cmd\":\"rollback\"}");
    assert!(status_is(&resp, "error"), "rollback with no history should error: {resp}");
    assert!(message(&resp).contains("no previous"), "unexpected error: {resp}");
}

#[test]
fn stop_terminates_worker() {
    let fx = Fixture::start(None);
    assert!(status_is(&fx.deploy_path(&worker_bin()), "ok"), "deploy failed");
    let worker = fx.running_pid().expect("worker running after deploy");

    let resp = fx.request("{\"cmd\":\"stop\"}");
    assert!(status_is(&resp, "ok"), "stop failed: {resp}");
    assert_eq!(fx.running_pid(), None, "status still reports a running worker after stop");
    assert!(
        poll(Duration::from_secs(5), || (!alive(worker)).then_some(())).is_some(),
        "worker {worker} survived stop",
    );
}
