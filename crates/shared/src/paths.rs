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
