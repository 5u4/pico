use std::{
    collections::HashMap,
    path::{Path, PathBuf},
};

use pico_core::config::StreamingBehavior;
use serde::Deserialize;

pub struct DiscordConfig {
    guilds: HashMap<String, GuildDefault>,
    render: pico_core::config::Render,
}

pub struct GuildDefault {
    pub profile: String,
    pub cwd: PathBuf,
    pub home_channel: Option<String>,
}

impl DiscordConfig {
    pub fn guild(&self, guild_id: &str) -> Option<&GuildDefault> {
        self.guilds.get(guild_id)
    }

    pub fn render(&self) -> pico_core::config::Render {
        self.render
    }
}

#[derive(Deserialize, Default)]
#[serde(deny_unknown_fields)]
struct RawDiscordConfig {
    #[serde(default)]
    guild: Vec<RawGuild>,
    #[serde(default)]
    render: Option<RawRender>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawGuild {
    #[serde(deserialize_with = "de_snowflake")]
    id: String,
    cwd: String,
    #[serde(default)]
    profile: Option<String>,
    #[serde(default, deserialize_with = "de_snowflake_opt")]
    home_channel: Option<String>,
}

#[derive(Deserialize, Default)]
#[serde(deny_unknown_fields)]
struct RawRender {
    #[serde(default)]
    streaming_behavior: StreamingBehavior,
}

pub fn load(path: &Path) -> color_eyre::Result<DiscordConfig> {
    let raw: RawDiscordConfig = pico_shared::config::read_toml_or_default(path)?;

    let mut guilds = HashMap::with_capacity(raw.guild.len());
    for g in raw.guild {
        if !is_valid_snowflake(&g.id) {
            return Err(color_eyre::eyre::eyre!(
                "invalid guild id {:?} (must match ^[0-9]{{17,20}}$)",
                g.id
            ));
        }
        let profile = g
            .profile
            .unwrap_or_else(|| pico_shared::paths::DEFAULT_PROFILE.to_owned());
        if !pico_shared::validate::is_valid_profile(&profile) {
            return Err(color_eyre::eyre::eyre!(
                "guild {}: invalid profile {profile:?} (must match ^[A-Za-z0-9_-]+$)",
                g.id
            ));
        }
        let cwd = pico_shared::paths::expand_home(&g.cwd);
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
        if let Some(home) = &g.home_channel
            && !is_valid_snowflake(home)
        {
            return Err(color_eyre::eyre::eyre!(
                "guild {}: invalid home_channel {home:?} (must match ^[0-9]{{17,20}}$)",
                g.id
            ));
        }
        guilds.insert(
            g.id,
            GuildDefault {
                profile,
                cwd,
                home_channel: g.home_channel,
            },
        );
    }

    let render = raw.render.unwrap_or_default().into();

    Ok(DiscordConfig { guilds, render })
}

impl From<RawRender> for pico_core::config::Render {
    fn from(raw: RawRender) -> Self {
        pico_core::config::Render {
            streaming_behavior: raw.streaming_behavior,
        }
    }
}

fn is_valid_snowflake(id: &str) -> bool {
    (17..=20).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_digit())
}

fn de_snowflake<'de, D>(de: D) -> Result<String, D::Error>
where
    D: serde::Deserializer<'de>,
{
    struct Snowflake;
    impl serde::de::Visitor<'_> for Snowflake {
        type Value = String;
        fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
            f.write_str("a Discord snowflake id as a quoted string or bare integer")
        }
        fn visit_str<E: serde::de::Error>(self, v: &str) -> Result<String, E> {
            Ok(v.to_owned())
        }
        fn visit_i64<E: serde::de::Error>(self, v: i64) -> Result<String, E> {
            Ok(v.to_string())
        }
        fn visit_u64<E: serde::de::Error>(self, v: u64) -> Result<String, E> {
            Ok(v.to_string())
        }
    }
    de.deserialize_any(Snowflake)
}

fn de_snowflake_opt<'de, D>(de: D) -> Result<Option<String>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    struct OptSnowflake;
    impl<'de> serde::de::Visitor<'de> for OptSnowflake {
        type Value = Option<String>;
        fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
            f.write_str("an optional Discord snowflake id as a quoted string or bare integer")
        }
        fn visit_none<E: serde::de::Error>(self) -> Result<Option<String>, E> {
            Ok(None)
        }
        fn visit_unit<E: serde::de::Error>(self) -> Result<Option<String>, E> {
            Ok(None)
        }
        fn visit_some<D2>(self, de: D2) -> Result<Option<String>, D2::Error>
        where
            D2: serde::Deserializer<'de>,
        {
            de_snowflake(de).map(Some)
        }
    }
    de.deserialize_option(OptSnowflake)
}

#[cfg(test)]
mod tests {
    use std::{
        path::PathBuf,
        sync::atomic::{AtomicU64, Ordering},
    };

    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        static N: AtomicU64 = AtomicU64::new(0);
        let n = N.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("pico-discord-config-{}-{}-{}", tag, std::process::id(), n));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn reads_guilds_with_default_and_explicit_profile() {
        let dir = temp_dir("guilds");
        let path = dir.join("discord.toml");
        std::fs::write(
            &path,
            "[[guild]]\nid = \"123456789012345678\"\ncwd = \"/tmp\"\n\n[[guild]]\nid = \"234567890123456789\"\nprofile = \"dev\"\ncwd = \"/var\"\n",
        )
        .unwrap();

        let cfg = load(&path).unwrap();
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
    fn reads_home_channel_and_defaults_none() {
        let dir = temp_dir("home_channel");
        let path = dir.join("discord.toml");
        std::fs::write(
            &path,
            "[[guild]]\nid = \"123456789012345678\"\ncwd = \"/tmp\"\nhome_channel = \"234567890123456789\"\n\n[[guild]]\nid = \"345678901234567890\"\ncwd = \"/var\"\n",
        )
        .unwrap();
        let cfg = load(&path).unwrap();
        assert_eq!(
            cfg.guild("123456789012345678").unwrap().home_channel.as_deref(),
            Some("234567890123456789")
        );
        assert_eq!(cfg.guild("345678901234567890").unwrap().home_channel, None);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn rejects_bad_home_channel() {
        let dir = temp_dir("bad_home");
        let path = dir.join("discord.toml");
        std::fs::write(
            &path,
            "[[guild]]\nid = \"123456789012345678\"\ncwd = \"/tmp\"\nhome_channel = \"nope\"\n",
        )
        .unwrap();
        assert!(load(&path).is_err());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn missing_file_is_empty() {
        let dir = temp_dir("missing");
        let cfg = load(&dir.join("discord.toml")).unwrap();
        assert!(cfg.guild("123456789012345678").is_none());
        assert_eq!(cfg.render().streaming_behavior, StreamingBehavior::Steer);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn accepts_bare_integer_id() {
        let dir = temp_dir("intid");
        let path = dir.join("discord.toml");
        std::fs::write(&path, "[[guild]]\nid = 123456789012345678\ncwd = \"/tmp\"\n").unwrap();
        assert!(load(&path).unwrap().guild("123456789012345678").is_some());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn expands_home_in_cwd() {
        let Some(home) = std::env::home_dir() else {
            return;
        };
        let dir = temp_dir("home");
        let path = dir.join("discord.toml");
        std::fs::write(&path, "[[guild]]\nid = \"123456789012345678\"\ncwd = \"~/picotest\"\n").unwrap();
        let cfg = load(&path).unwrap();
        assert_eq!(cfg.guild("123456789012345678").unwrap().cwd, home.join("picotest"));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn rejects_bad_guild_id() {
        let dir = temp_dir("badid");
        let path = dir.join("discord.toml");
        std::fs::write(&path, "[[guild]]\nid = \"abc\"\ncwd = \"/tmp\"\n").unwrap();
        assert!(load(&path).is_err());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn rejects_relative_cwd() {
        let dir = temp_dir("rel");
        let path = dir.join("discord.toml");
        std::fs::write(&path, "[[guild]]\nid = \"123456789012345678\"\ncwd = \"relative/dir\"\n").unwrap();
        assert!(load(&path).is_err());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn rejects_duplicate_guild() {
        let dir = temp_dir("dup");
        let path = dir.join("discord.toml");
        std::fs::write(
            &path,
            "[[guild]]\nid = \"123456789012345678\"\ncwd = \"/tmp\"\n\n[[guild]]\nid = \"123456789012345678\"\ncwd = \"/var\"\n",
        )
        .unwrap();
        assert!(load(&path).is_err());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn reads_render_streaming() {
        let dir = temp_dir("render");
        let path = dir.join("discord.toml");
        std::fs::write(&path, "[render]\nstreaming_behavior = \"follow_up\"\n").unwrap();
        let cfg = load(&path).unwrap();
        assert_eq!(cfg.render().streaming_behavior, StreamingBehavior::FollowUp);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn rejects_invalid_streaming_behavior() {
        let dir = temp_dir("badstream");
        let path = dir.join("discord.toml");
        std::fs::write(&path, "[render]\nstreaming_behavior = \"replace\"\n").unwrap();
        assert!(load(&path).is_err());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn rejects_unknown_key() {
        let dir = temp_dir("unknown");
        let path = dir.join("discord.toml");
        std::fs::write(&path, "[memory]\nenabled = true\n").unwrap();
        assert!(load(&path).is_err());
        std::fs::remove_dir_all(&dir).ok();
    }
}
