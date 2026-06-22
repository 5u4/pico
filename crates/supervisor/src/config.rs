use std::{
    path::{Path, PathBuf},
    time::Duration,
};

use serde::Deserialize;

fn default_health_timeout_secs() -> u64 {
    30
}

#[derive(Deserialize)]
pub struct Config {
    #[serde(default)]
    pub socket_path: Option<PathBuf>,
    #[serde(default = "default_health_timeout_secs")]
    pub health_timeout_secs: u64,
    #[serde(default)]
    pub workers: Vec<WorkerEntry>,
}

#[derive(Deserialize)]
pub struct WorkerEntry {
    pub root: PathBuf,
}

impl Config {
    pub fn load(supervisor_dir: &Path) -> color_eyre::Result<Self> {
        let text = match std::fs::read_to_string(supervisor_dir.join("supervisor.toml")) {
            Ok(text) => text,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
            Err(e) => return Err(e.into()),
        };
        Ok(toml::from_str(&text)?)
    }

    pub fn health_timeout(&self) -> Duration {
        Duration::from_secs(self.health_timeout_secs)
    }

    pub fn worker_root(&self) -> color_eyre::Result<PathBuf> {
        match self.workers.first() {
            Some(w) => Ok(w.root.clone()),
            None => pico_shared::paths::worker_root(pico_shared::paths::DEFAULT_WORKER),
        }
    }
}
