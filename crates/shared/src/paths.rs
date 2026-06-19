use std::path::{Path, PathBuf};

/// Name of the default worker root under `workers/`.
pub const DEFAULT_WORKER: &str = "default";

/// `~/.pico` — the root every supervisor and worker directory hangs off.
///
/// Errors if the home directory can't be resolved.
pub fn pico_home() -> color_eyre::Result<PathBuf> {
    let home = std::env::home_dir().ok_or_else(|| color_eyre::eyre::eyre!("cannot determine home directory"))?;
    Ok(home.join(".pico"))
}

/// `~/.pico/supervisor` — the supervisor domain (one per host).
pub fn supervisor_dir() -> color_eyre::Result<PathBuf> {
    Ok(pico_home()?.join("supervisor"))
}

/// `~/.pico/workers/<name>` — a worker root (its state + identity).
pub fn worker_root(name: &str) -> color_eyre::Result<PathBuf> {
    Ok(pico_home()?.join("workers").join(name))
}

/// `<root>/secrets/<name>` — a credential file under a worker root. Takes the
/// root explicitly because `worker --path` can point anywhere, not just under
/// `$HOME`; recomputing from `pico_home()` would ignore that override.
pub fn worker_secret(root: &Path, name: &str) -> PathBuf {
    root.join("secrets").join(name)
}

/// `<root>/bindings.toml` — channel→(profile, cwd) routing table for this root.
pub fn worker_bindings(root: &Path) -> PathBuf {
    root.join("bindings.toml")
}

/// `<root>/config.toml` — worker-root config: the served-guild registry
/// (`guild_id` → default profile/cwd for unbound channels).
pub fn worker_config(root: &Path) -> PathBuf {
    root.join("config.toml")
}

/// `<root>/profiles/<name>` — a profile's state directory.
pub fn profile_dir(root: &Path, name: &str) -> PathBuf {
    root.join("profiles").join(name)
}

/// `<root>/profiles/<name>/config.toml` — a profile's feature/model config.
pub fn profile_config(root: &Path, name: &str) -> PathBuf {
    profile_dir(root, name).join("config.toml")
}

/// `<root>/profiles/<name>/identity.md` — a profile's appended system prompt.
pub fn profile_identity(root: &Path, name: &str) -> PathBuf {
    profile_dir(root, name).join("identity.md")
}

/// `<root>/profiles/<name>/sessions/<thread_id>` — the OMP `--session-dir` for
/// one Discord thread. Derived from `thread_id`, so a respawned `omp` child
/// resumes the thread's session via `--continue` with no stored mapping.
pub fn profile_session_dir(root: &Path, name: &str, thread_id: &str) -> PathBuf {
    profile_dir(root, name).join("sessions").join(thread_id)
}

/// `<root>/worktrees` — default parent for per-thread git worktrees when the
/// worker config's `[worktree] dir` is unset. Taken from the root (like every
/// other worker path) so it honors a `worker --path` override.
pub fn default_worktrees_dir(root: &Path) -> PathBuf {
    root.join("worktrees")
}

/// `<root>/threads/<thread_id>.toml` — a thread's frozen route marker (profile +
/// cwd, plus worktree origin), pinning it so a later channel rebind doesn't
/// migrate an existing thread. Keyed by thread id, independent of profile.
pub fn thread_marker(root: &Path, thread_id: &str) -> PathBuf {
    root.join("threads").join(format!("{thread_id}.toml"))
}

/// `<root>/pico.db` — the worker's SQLite store (approvals + future subsystems).
/// WAL sidecars (`pico.db-wal`, `pico.db-shm`) sit alongside.
pub fn worker_db(root: &Path) -> PathBuf {
    root.join("pico.db")
}

/// `<root>/camofox` — working dir for the worker-owned Camoufox daemon.
pub fn camofox_dir(root: &Path) -> PathBuf {
    root.join("camofox")
}

/// `<root>/camofox/extension.ts` — the omp extension the worker writes for
/// browser-enabled profiles (embedded in the binary, rewritten at startup so
/// it stays lockstep with the worker version).
pub fn camofox_extension(root: &Path) -> PathBuf {
    camofox_dir(root).join("extension.ts")
}

/// `<root>/camofox/profiles` — `CAMOFOX_PROFILE_DIR`: Camoufox's per-userId
/// (= per-profile) cookie/storage jars. Under the worker root so a profile's
/// logins persist on the state volume across restarts.
pub fn camofox_profile_dir(root: &Path) -> PathBuf {
    camofox_dir(root).join("profiles")
}
