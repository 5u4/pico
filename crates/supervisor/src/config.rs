use std::{
    path::{Path, PathBuf},
    time::Duration,
};

use serde::Deserialize;

const DEFAULT_HEALTH_TIMEOUT_SECS: u64 = 30;

/// Supervisor configuration, loaded from `<supervisor_dir>/supervisor.toml`.
/// A missing file yields all defaults so the socket is usable with zero setup
/// (`deploy path:` works; `deploy rev:` needs `repo_path`).
pub struct Config {
    pub socket_path: PathBuf,
    pub repo_path: Option<PathBuf>,
    pub health_timeout: Duration,
    pub workers: Vec<WorkerEntry>,
}

#[derive(Deserialize)]
pub struct WorkerEntry {
    pub root: PathBuf,
}

#[derive(Default, Deserialize)]
struct Raw {
    socket_path: Option<PathBuf>,
    repo_path: Option<PathBuf>,
    health_timeout_secs: Option<u64>,
    #[serde(default, rename = "worker")]
    workers: Vec<WorkerEntry>,
}

impl Config {
    pub fn load(supervisor_dir: &Path) -> color_eyre::Result<Self> {
        let path = supervisor_dir.join("supervisor.toml");
        let raw: Raw = match std::fs::read_to_string(&path) {
            Ok(text) => toml::from_str(&text)?,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Raw::default(),
            Err(e) => return Err(e.into()),
        };

        Ok(Self {
            socket_path: raw.socket_path.unwrap_or_else(|| supervisor_dir.join("pico.sock")),
            repo_path: raw.repo_path,
            health_timeout: Duration::from_secs(raw.health_timeout_secs.unwrap_or(DEFAULT_HEALTH_TIMEOUT_SECS)),
            workers: raw.workers,
        })
    }

    /// Root of the single worker this supervisor manages today: the first
    /// `[[worker]]` entry, else `~/.pico/workers/default`.
    pub fn worker_root(&self) -> color_eyre::Result<PathBuf> {
        match self.workers.first() {
            Some(w) => Ok(w.root.clone()),
            None => Ok(pico_shared::paths::pico_home()?.join("workers").join("default")),
        }
    }
}
