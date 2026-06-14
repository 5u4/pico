use std::{
    collections::HashMap,
    path::{Path, PathBuf},
};

use color_eyre::eyre::WrapErr;
use serde::Deserialize;

pub struct ProfileConfig {
    pub model: Option<String>,
    pub surface_thinking: bool,
}

#[derive(Deserialize)]
struct RawConfig {
    #[serde(default)]
    llm: Option<RawLlm>,
    #[serde(default)]
    discord: Option<RawDiscord>,
}

#[derive(Deserialize)]
struct RawLlm {
    #[serde(default)]
    model: Option<String>,
}

#[derive(Deserialize)]
struct RawDiscord {
    #[serde(default)]
    surface_thinking: bool,
}

pub fn load(config_path: &Path) -> color_eyre::Result<ProfileConfig> {
    let text = match std::fs::read_to_string(config_path) {
        Ok(text) => text,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Ok(ProfileConfig {
                model: None,
                surface_thinking: false,
            });
        }
        Err(e) => {
            return Err(e).wrap_err_with(|| format!("reading {}", config_path.display()));
        }
    };

    let raw: RawConfig = toml::from_str(&text).wrap_err_with(|| format!("parsing {}", config_path.display()))?;
    Ok(ProfileConfig {
        model: raw.llm.and_then(|llm| llm.model),
        surface_thinking: raw.discord.is_some_and(|d| d.surface_thinking),
    })
}

pub struct GuildDefault {
    pub profile: String,
    pub cwd: PathBuf,
}

/// The worker root's served-guild registry. Only a guild with an entry here is
/// served at all; an unbound channel in one routes its turns to that guild's
/// default `(profile, cwd)`.
pub struct RootConfig {
    guilds: HashMap<String, GuildDefault>,
}

impl RootConfig {
    pub fn guild(&self, guild_id: &str) -> Option<&GuildDefault> {
        self.guilds.get(guild_id)
    }
}

#[derive(serde::Deserialize)]
struct RawRootConfig {
    #[serde(default)]
    guild: Vec<RawGuild>,
}

#[derive(serde::Deserialize)]
struct RawGuild {
    #[serde(deserialize_with = "crate::bindings::de_snowflake")]
    id: String,
    cwd: String,
    #[serde(default)]
    profile: Option<String>,
}

/// Load the served-guild registry from `<root>/config.toml`. A missing file is
/// an empty registry. Validates id/profile shape and that each cwd is absolute,
/// but deliberately NOT that the cwd exists: existence is re-checked per message
/// so a directory torn down on the host surfaces as an in-channel error instead
/// of a silent drop the user has to read logs to diagnose.
pub fn load_root(config_path: &Path) -> color_eyre::Result<RootConfig> {
    let text = match std::fs::read_to_string(config_path) {
        Ok(text) => text,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Ok(RootConfig { guilds: HashMap::new() });
        }
        Err(e) => {
            return Err(e).wrap_err_with(|| format!("reading {}", config_path.display()));
        }
    };

    let raw: RawRootConfig = toml::from_str(&text).wrap_err_with(|| format!("parsing {}", config_path.display()))?;
    let mut guilds = HashMap::with_capacity(raw.guild.len());
    for g in raw.guild {
        if !crate::bindings::is_valid_snowflake(&g.id) {
            return Err(color_eyre::eyre::eyre!(
                "invalid guild id {:?} (must match ^[0-9]{{17,20}}$)",
                g.id
            ));
        }
        let profile = g
            .profile
            .unwrap_or_else(|| pico_shared::paths::DEFAULT_WORKER.to_owned());
        if !crate::bindings::is_valid_profile(&profile) {
            return Err(color_eyre::eyre::eyre!(
                "guild {}: invalid profile {profile:?} (must match ^[A-Za-z0-9_-]+$)",
                g.id
            ));
        }
        let cwd = crate::bindings::expand_home(&g.cwd);
        if !cwd.is_absolute() {
            return Err(color_eyre::eyre::eyre!(
                "guild {}: cwd {} must be an absolute path",
                g.id,
                cwd.display()
            ));
        }
        if guilds.contains_key(&g.id) {
            return Err(color_eyre::eyre::eyre!("duplicate guild {}", g.id));
        }
        guilds.insert(g.id, GuildDefault { profile, cwd });
    }
    Ok(RootConfig { guilds })
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

    #[test]
    fn reads_surface_thinking_and_defaults_off() {
        let dir = temp_dir("thinking");
        let on = dir.join("on.toml");
        std::fs::write(&on, "[discord]\nsurface_thinking = true\n").unwrap();
        assert!(super::load(&on).unwrap().surface_thinking);

        let bare = dir.join("bare.toml");
        std::fs::write(&bare, "[llm]\nmodel = \"x\"\n").unwrap();
        assert!(!super::load(&bare).unwrap().surface_thinking);

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn load_root_reads_guilds_with_default_and_explicit_profile() {
        let dir = temp_dir("guilds");
        let path = dir.join("config.toml");
        std::fs::write(
            &path,
            "[[guild]]\nid = \"123456789012345678\"\ncwd = \"/tmp\"\n\n[[guild]]\nid = \"234567890123456789\"\nprofile = \"dev\"\ncwd = \"/var\"\n",
        )
        .unwrap();

        let cfg = super::load_root(&path).unwrap();
        let a = cfg.guild("123456789012345678").unwrap();
        assert_eq!(a.profile, "default");
        assert_eq!(a.cwd, PathBuf::from("/tmp"));
        let b = cfg.guild("234567890123456789").unwrap();
        assert_eq!(b.profile, "dev");
        assert_eq!(b.cwd, PathBuf::from("/var"));
        assert!(cfg.guild("999999999999999999").is_none());

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn load_root_missing_file_is_empty() {
        let dir = temp_dir("rootmissing");
        let cfg = super::load_root(&dir.join("config.toml")).unwrap();
        assert!(cfg.guild("123456789012345678").is_none());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn load_root_accepts_bare_integer_id() {
        let dir = temp_dir("rootintid");
        let path = dir.join("config.toml");
        std::fs::write(&path, "[[guild]]\nid = 123456789012345678\ncwd = \"/tmp\"\n").unwrap();
        let cfg = super::load_root(&path).unwrap();
        assert!(cfg.guild("123456789012345678").is_some());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn load_root_expands_home_in_cwd() {
        let Some(home) = std::env::home_dir() else {
            return;
        };
        let dir = temp_dir("roothome");
        let path = dir.join("config.toml");
        std::fs::write(&path, "[[guild]]\nid = \"123456789012345678\"\ncwd = \"~/picotest\"\n").unwrap();
        let cfg = super::load_root(&path).unwrap();
        assert_eq!(cfg.guild("123456789012345678").unwrap().cwd, home.join("picotest"));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn load_root_rejects_bad_guild_id() {
        let dir = temp_dir("rootbadid");
        let path = dir.join("config.toml");
        std::fs::write(&path, "[[guild]]\nid = \"abc\"\ncwd = \"/tmp\"\n").unwrap();
        assert!(super::load_root(&path).is_err());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn load_root_rejects_relative_cwd() {
        let dir = temp_dir("rootrel");
        let path = dir.join("config.toml");
        std::fs::write(&path, "[[guild]]\nid = \"123456789012345678\"\ncwd = \"relative/dir\"\n").unwrap();
        assert!(super::load_root(&path).is_err());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn load_root_rejects_duplicate_guild() {
        let dir = temp_dir("rootdup");
        let path = dir.join("config.toml");
        std::fs::write(
            &path,
            "[[guild]]\nid = \"123456789012345678\"\ncwd = \"/tmp\"\n\n[[guild]]\nid = \"123456789012345678\"\ncwd = \"/var\"\n",
        )
        .unwrap();
        assert!(super::load_root(&path).is_err());
        std::fs::remove_dir_all(&dir).ok();
    }
}
