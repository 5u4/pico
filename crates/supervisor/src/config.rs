use std::{
    path::{Path, PathBuf},
    time::Duration,
};

use color_eyre::eyre::{WrapErr, eyre};
use serde::Deserialize;

fn default_health_timeout_secs() -> u64 {
    30
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Config {
    #[serde(default)]
    pub socket_path: Option<PathBuf>,
    #[serde(default)]
    pub bun_path: Option<PathBuf>,
    #[serde(default = "default_health_timeout_secs")]
    pub health_timeout_secs: u64,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            socket_path: None,
            bun_path: None,
            health_timeout_secs: default_health_timeout_secs(),
        }
    }
}

impl Config {
    pub fn load(supervisor_dir: &Path) -> color_eyre::Result<Self> {
        let path = supervisor_dir.join("supervisor.toml");
        match std::fs::read_to_string(&path) {
            Ok(text) => toml::from_str(&text).wrap_err_with(|| format!("parse {}", path.display())),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Self::default()),
            Err(e) => Err(e).wrap_err_with(|| format!("read {}", path.display())),
        }
    }

    pub fn health_timeout(&self) -> Duration {
        Duration::from_secs(self.health_timeout_secs)
    }

    pub fn resolve_bun(&self) -> color_eyre::Result<PathBuf> {
        if let Some(explicit) = &self.bun_path {
            if is_executable_file(explicit) {
                return Ok(explicit.clone());
            }
            return Err(eyre!("configured bun_path {} is not an executable file", explicit.display()));
        }
        for candidate in bun_candidates() {
            if is_executable_file(&candidate) {
                return Ok(candidate);
            }
        }
        Err(eyre!(
            "could not locate the bun executable; set bun_path in supervisor.toml or install bun to ~/.bun/bin/bun"
        ))
    }
}

fn bun_candidates() -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Some(install) = std::env::var_os("BUN_INSTALL") {
        out.push(Path::new(&install).join("bin").join("bun"));
    }
    if let Some(home) = std::env::var_os("HOME") {
        out.push(Path::new(&home).join(".bun").join("bin").join("bun"));
    }
    if let Some(path) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&path) {
            out.push(dir.join("bun"));
        }
    }
    out.push(PathBuf::from("bun"));
    out
}

fn is_executable_file(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    match std::fs::metadata(path) {
        Ok(meta) => meta.is_file() && meta.permissions().mode() & 0o111 != 0,
        Err(_) => false,
    }
}

pub fn supervisor_dir() -> color_eyre::Result<PathBuf> {
    let home = std::env::var_os("HOME").ok_or_else(|| eyre!("HOME is not set"))?;
    Ok(Path::new(&home).join(".pico").join("supervisor"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_when_file_absent() {
        let dir = tempfile::tempdir().unwrap();
        let config = Config::load(dir.path()).unwrap();
        assert_eq!(config.health_timeout_secs, 30);
        assert!(config.socket_path.is_none());
    }

    #[test]
    fn resolve_bun_honors_explicit_path() {
        let dir = tempfile::tempdir().unwrap();
        let fake = dir.path().join("bun");
        std::fs::write(&fake, "#!/bin/sh\n").unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&fake, std::fs::Permissions::from_mode(0o755)).unwrap();
        let config = Config {
            bun_path: Some(fake.clone()),
            ..Config::default()
        };
        assert_eq!(config.resolve_bun().unwrap(), fake);
    }

    #[test]
    fn resolve_bun_rejects_missing_explicit_path() {
        let config = Config {
            bun_path: Some(PathBuf::from("/no/such/bun")),
            ..Config::default()
        };
        assert!(config.resolve_bun().is_err());
    }
}
