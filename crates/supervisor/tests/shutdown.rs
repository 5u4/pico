//! End-to-end check that a `SIGTERM` to the supervisor drains in-flight work,
//! stops the worker it owns (no orphan), and tears the control socket down —
//! the graceful-shutdown contract. Drives a real supervisor + worker process
//! over the control socket, with `$HOME` redirected to a temp dir so the run is
//! hermetic.

use std::{
    io::{BufRead, BufReader, Write},
    os::unix::net::UnixStream,
    path::{Path, PathBuf},
    process::{Child, Command},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

/// A sibling binary in the same target dir as this test's supervisor binary.
fn bin(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_BIN_EXE_supervisor")).with_file_name(name)
}

/// `kill(pid, 0)` probes existence without delivering a signal.
fn alive(pid: i32) -> bool {
    unsafe { libc::kill(pid, 0) == 0 }
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

/// Send one newline-delimited JSON request, return the parsed response frame.
fn request(socket: &Path, frame: &str) -> Option<serde_json::Value> {
    let mut stream = UnixStream::connect(socket).ok()?;
    stream.write_all(frame.as_bytes()).ok()?;
    stream.write_all(b"\n").ok()?;
    stream.flush().ok()?;
    let mut line = String::new();
    BufReader::new(&mut stream).read_line(&mut line).ok()?;
    serde_json::from_str(line.trim()).ok()
}

fn running_pid(socket: &Path) -> Option<u32> {
    let v = request(socket, "{\"cmd\":\"status\"}")?;
    if v.get("running")?.as_bool()? {
        Some(v.get("pid")?.as_u64()? as u32)
    } else {
        None
    }
}

/// `cargo test -p supervisor` builds the supervisor bin but not the worker bin
/// from the sibling crate; build it on demand so the test stands alone.
fn ensure_worker() -> PathBuf {
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

#[test]
fn sigterm_drains_and_stops_worker() {
    let worker = ensure_worker();
    let nanos = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
    let home = std::env::temp_dir().join(format!("pico-it-{}-{nanos}", std::process::id()));
    let sup_dir = home.join(".pico").join("supervisor");
    std::fs::create_dir_all(&sup_dir).unwrap();
    // macOS caps Unix socket paths near 104 bytes, so keep the socket short and
    // out of the deep temp `$HOME`. Short health timeout keeps waits brief.
    let socket = PathBuf::from(format!("/tmp/pico-it-{nanos}.sock"));
    std::fs::write(
        sup_dir.join("supervisor.toml"),
        format!("health_timeout_secs = 5\nsocket_path = \"{}\"\n", socket.display()),
    )
    .unwrap();

    let mut sup = Command::new(bin("supervisor"))
        .env("HOME", &home)
        .spawn()
        .expect("spawn supervisor");

    let abort = |sup: &mut Child, msg: String| -> ! {
        let _ = sup.kill();
        let _ = sup.wait();
        let _ = std::fs::remove_dir_all(&home);
        panic!("{msg}");
    };

    // Wait until the control socket is accepting.
    if poll(Duration::from_secs(10), || request(&socket, "{\"cmd\":\"status\"}")).is_none() {
        abort(&mut sup, "supervisor never started serving".into());
    }

    // Bring a worker up over the live socket via deploy.
    let path = serde_json::Value::String(worker.to_string_lossy().into_owned());
    let deploy = format!("{{\"cmd\":\"deploy\",\"target\":{{\"kind\":\"path\",\"path\":{path}}}}}");
    match request(&socket, &deploy) {
        Some(v) if v.get("status").and_then(|s| s.as_str()) == Some("ok") => {}
        other => abort(&mut sup, format!("deploy did not succeed: {other:?}")),
    }

    let worker_pid = match running_pid(&socket) {
        Some(p) => p as i32,
        None => abort(&mut sup, "worker not running after deploy".into()),
    };
    assert!(alive(worker_pid), "worker should be live before shutdown");

    unsafe {
        libc::kill(sup.id() as i32, libc::SIGTERM);
    }

    let exited = poll(Duration::from_secs(15), || sup.try_wait().ok().flatten());
    let worker_dead = poll(Duration::from_secs(8), || (!alive(worker_pid)).then_some(())).is_some();
    let socket_gone = !socket.exists();

    // Reap any survivors before asserting so a failure doesn't leak processes.
    if exited.is_none() {
        let _ = sup.kill();
        let _ = sup.wait();
    }
    if !worker_dead {
        unsafe {
            libc::kill(worker_pid, libc::SIGKILL);
        }
    }
    let _ = std::fs::remove_dir_all(&home);

    assert!(
        matches!(exited, Some(st) if st.success()),
        "supervisor did not exit cleanly: {exited:?}"
    );
    assert!(worker_dead, "worker was orphaned after supervisor shutdown");
    assert!(socket_gone, "control socket left behind after shutdown");
}

#[test]
fn boot_adopts_current_slot() {
    let worker = ensure_worker();
    let nanos = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
    let home = std::env::temp_dir().join(format!("pico-it-{}-{nanos}", std::process::id()));
    let sup_dir = home.join(".pico").join("supervisor");
    let slots = sup_dir.join("slots");
    std::fs::create_dir_all(&slots).unwrap();
    let socket = PathBuf::from(format!("/tmp/pico-it-{nanos}.sock"));
    std::fs::write(
        sup_dir.join("supervisor.toml"),
        format!("health_timeout_secs = 5\nsocket_path = \"{}\"\n", socket.display()),
    )
    .unwrap();
    // current slot -> the built worker; the supervisor must adopt it on boot,
    // which only works because serve is accepting before boot validates.
    std::os::unix::fs::symlink(&worker, slots.join("current")).unwrap();

    let mut sup = Command::new(bin("supervisor"))
        .env("HOME", &home)
        .spawn()
        .expect("spawn supervisor");

    let booted = poll(Duration::from_secs(15), || running_pid(&socket));

    // Stop the supervisor and clean up regardless of the outcome.
    unsafe {
        libc::kill(sup.id() as i32, libc::SIGTERM);
    }
    let _ = poll(Duration::from_secs(15), || sup.try_wait().ok().flatten());
    let _ = sup.kill();
    let _ = sup.wait();
    if let Some(pid) = booted
        && alive(pid as i32)
    {
        unsafe {
            libc::kill(pid as i32, libc::SIGKILL);
        }
    }
    let _ = std::fs::remove_dir_all(&home);

    assert!(booted.is_some(), "supervisor did not adopt the current-slot worker on boot");
}
