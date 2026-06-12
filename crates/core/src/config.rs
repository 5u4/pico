use std::path::Path;

use color_eyre::eyre::WrapErr;
use serde::Deserialize;

pub struct ProfileConfig {
    pub model: Option<String>,
}

#[derive(Deserialize)]
struct RawConfig {
    #[serde(default)]
    llm: Option<RawLlm>,
}

#[derive(Deserialize)]
struct RawLlm {
    #[serde(default)]
    model: Option<String>,
}

pub fn load(config_path: &Path) -> color_eyre::Result<ProfileConfig> {
    let text = match std::fs::read_to_string(config_path) {
        Ok(text) => text,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Ok(ProfileConfig { model: None });
        }
        Err(e) => {
            return Err(e).wrap_err_with(|| format!("reading {}", config_path.display()));
        }
    };

    let raw: RawConfig = toml::from_str(&text).wrap_err_with(|| format!("parsing {}", config_path.display()))?;
    Ok(ProfileConfig {
        model: raw.llm.and_then(|llm| llm.model),
    })
}

#[cfg(test)]
mod tests {
    use std::{
        path::PathBuf,
        sync::atomic::{AtomicU64, Ordering},
    };

    fn temp_dir(tag: &str) -> PathBuf {
        static N: AtomicU64 = AtomicU64::new(0);
        let n = N.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("pico-config-{}-{}-{}", tag, std::process::id(), n));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn reads_model() {
        let dir = temp_dir("model");
        let path = dir.join("config.toml");
        std::fs::write(&path, "[llm]\nmodel = \"x\"\n").unwrap();

        let cfg = super::load(&path).unwrap();
        assert_eq!(cfg.model.as_deref(), Some("x"));

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn missing_file_is_none() {
        let dir = temp_dir("missing");
        let cfg = super::load(&dir.join("config.toml")).unwrap();
        assert_eq!(cfg.model, None);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn no_llm_table_is_none() {
        let dir = temp_dir("nollm");
        let path = dir.join("config.toml");
        std::fs::write(&path, "other = \"value\"\n").unwrap();

        let cfg = super::load(&path).unwrap();
        assert_eq!(cfg.model, None);

        std::fs::remove_dir_all(&dir).ok();
    }
}
