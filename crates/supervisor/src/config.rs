use std::{
    path::{Path, PathBuf},
    time::Duration,
};

use serde::Deserialize;

fn default_health_timeout_secs() -> u64 {
    30
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Config {
    #[serde(default)]
    pub socket_path: Option<PathBuf>,
    #[serde(default = "default_health_timeout_secs")]
    pub health_timeout_secs: u64,
}

impl Config {
    pub fn load(supervisor_dir: &Path) -> color_eyre::Result<Self> {
        pico_shared::config::read_toml_or_default(&supervisor_dir.join("supervisor.toml"))
    }

    pub fn health_timeout(&self) -> Duration {
        Duration::from_secs(self.health_timeout_secs)
    }
}
