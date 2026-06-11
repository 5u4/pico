use std::{
    path::{Path, PathBuf},
    time::Duration,
};

use serde::Deserialize;

const DEFAULT_HEALTH_TIMEOUT_SECS: u64 = 30;

/// Supervisor configuration, loaded from `<supervisor_dir>/supervisor.toml`.
/// A missing file yields all defaults so the socket is usable with zero setup
/// (`deploy path:` works; `deploy rev:` needs `repo_path`).
#[derive(Deserialize)]
#[serde(default)]
pub struct Config {
    /// Control-socket override; `None` means `<supervisor_dir>/pico.sock`,
    /// resolved by the caller that knows the supervisor dir.
    pub socket_path: Option<PathBuf>,
    pub repo_path: Option<PathBuf>,
    pub health_timeout_secs: u64,
    #[serde(rename = "worker")]
    pub workers: Vec<WorkerEntry>,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            socket_path: None,
            repo_path: None,
            health_timeout_secs: DEFAULT_HEALTH_TIMEOUT_SECS,
            workers: Vec::new(),
        }
    }
}

#[derive(Deserialize)]
pub struct WorkerEntry {
    pub root: PathBuf,
}

impl Config {
    pub fn load(supervisor_dir: &Path) -> color_eyre::Result<Self> {
        match std::fs::read_to_string(supervisor_dir.join("supervisor.toml")) {
            Ok(text) => Ok(toml::from_str(&text)?),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Self::default()),
            Err(e) => Err(e.into()),
        }
    }

    pub fn health_timeout(&self) -> Duration {
        Duration::from_secs(self.health_timeout_secs)
    }

    /// Root of the single worker this supervisor manages today: the first
    /// `[[worker]]` entry, else `~/.pico/workers/default`.
    pub fn worker_root(&self) -> color_eyre::Result<PathBuf> {
        match self.workers.first() {
            Some(w) => Ok(w.root.clone()),
            None => pico_shared::paths::worker_root(pico_shared::paths::DEFAULT_WORKER),
        }
    }
}
