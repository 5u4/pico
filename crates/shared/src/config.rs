use std::path::Path;

use color_eyre::eyre::WrapErr;
use serde::de::DeserializeOwned;

pub fn read_toml_or_default<T>(path: &Path) -> color_eyre::Result<T>
where
    T: DeserializeOwned,
{
    let text = match std::fs::read_to_string(path) {
        Ok(text) => text,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(e) => return Err(e).wrap_err_with(|| format!("reading {}", path.display())),
    };
    toml::from_str(&text).wrap_err_with(|| format!("parsing {}", path.display()))
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicU64, Ordering};

    use serde::Deserialize;

    use super::*;

    #[derive(Deserialize, PartialEq, Debug)]
    #[serde(deny_unknown_fields)]
    struct Sample {
        #[serde(default)]
        name: Option<String>,
        #[serde(default = "default_count")]
        count: u64,
    }

    fn default_count() -> u64 {
        7
    }

    fn tmp_path(tag: &str) -> std::path::PathBuf {
        static N: AtomicU64 = AtomicU64::new(0);
        std::env::temp_dir().join(format!(
            "pico-cfg-{}-{}-{}.toml",
            tag,
            std::process::id(),
            N.fetch_add(1, Ordering::Relaxed)
        ))
    }

    #[test]
    fn missing_file_yields_serde_defaults() {
        let path = tmp_path("missing");
        let cfg: Sample = read_toml_or_default(&path).unwrap();
        assert_eq!(cfg, Sample { name: None, count: 7 });
    }

    #[test]
    fn present_file_overrides_defaults() {
        let path = tmp_path("present");
        std::fs::write(&path, "name = \"x\"\ncount = 3\n").unwrap();
        let cfg: Sample = read_toml_or_default(&path).unwrap();
        std::fs::remove_file(&path).ok();
        assert_eq!(
            cfg,
            Sample {
                name: Some("x".to_owned()),
                count: 3
            }
        );
    }

    #[test]
    fn unknown_key_is_rejected() {
        let path = tmp_path("unknown");
        std::fs::write(&path, "bogus = 1\n").unwrap();
        let err = read_toml_or_default::<Sample>(&path).unwrap_err();
        std::fs::remove_file(&path).ok();
        assert!(format!("{err:#}").contains("bogus"), "error should name the unknown key");
    }
}
