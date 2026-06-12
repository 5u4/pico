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
