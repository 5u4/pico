use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    time::Duration,
};

use color_eyre::eyre::WrapErr;
use serde::Deserialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StreamingBehavior {
    FollowUp,
    #[default]
    Steer,
}

pub struct ProfileConfig {
    pub model: Option<String>,
    pub surface_thinking: bool,
    pub streaming_behavior: StreamingBehavior,
    pub browser_enabled: bool,
}

#[derive(Deserialize)]
struct RawConfig {
    #[serde(default)]
    llm: Option<RawLlm>,
    #[serde(default)]
    discord: Option<RawDiscord>,
    #[serde(default)]
    browser: Option<RawBrowser>,
}

#[derive(Deserialize)]
struct RawLlm {
    #[serde(default)]
    model: Option<String>,
}

#[derive(Deserialize, Default)]
struct RawDiscord {
    #[serde(default)]
    surface_thinking: bool,
    #[serde(default)]
    streaming_behavior: StreamingBehavior,
}

#[derive(Deserialize, Default)]
struct RawBrowser {
    #[serde(default)]
    enabled: bool,
}

pub fn load(config_path: &Path) -> color_eyre::Result<ProfileConfig> {
    let text = match std::fs::read_to_string(config_path) {
        Ok(text) => text,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Ok(ProfileConfig {
                model: None,
                surface_thinking: false,
                streaming_behavior: StreamingBehavior::default(),
                browser_enabled: false,
            });
        }
        Err(e) => {
            return Err(e).wrap_err_with(|| format!("reading {}", config_path.display()));
        }
    };

    let raw: RawConfig = toml::from_str(&text).wrap_err_with(|| format!("parsing {}", config_path.display()))?;
    let discord = raw.discord.unwrap_or_default();
    Ok(ProfileConfig {
        model: raw.llm.and_then(|llm| llm.model),
        surface_thinking: discord.surface_thinking,
        streaming_behavior: discord.streaming_behavior,
        browser_enabled: raw.browser.is_some_and(|b| b.enabled),
    })
}

pub fn any_browser_enabled(root: &Path) -> bool {
    let Ok(entries) = std::fs::read_dir(root.join("profiles")) else {
        return false;
    };
    entries
        .flatten()
        .any(|entry| entry.path().is_dir() && load(&entry.path().join("config.toml")).is_ok_and(|c| c.browser_enabled))
}

pub struct GuildDefault {
    pub profile: String,
    pub cwd: PathBuf,
}

pub struct RootConfig {
    guilds: HashMap<String, GuildDefault>,
    worktrees_dir: Option<PathBuf>,
    approvers: Vec<String>,
    approval_timeout: Duration,
    timezone: chrono_tz::Tz,
}

impl RootConfig {
    pub fn guild(&self, guild_id: &str) -> Option<&GuildDefault> {
        self.guilds.get(guild_id)
    }

    pub fn worktrees_dir(&self) -> Option<&Path> {
        self.worktrees_dir.as_deref()
    }

    pub fn approvers(&self) -> &[String] {
        &self.approvers
    }

    pub fn approval_timeout(&self) -> Duration {
        self.approval_timeout
    }

    pub fn timezone(&self) -> chrono_tz::Tz {
        self.timezone
    }
}

#[derive(serde::Deserialize)]
struct RawRootConfig {
    #[serde(default)]
    guild: Vec<RawGuild>,
    #[serde(default)]
    worktree: Option<RawWorktree>,
    #[serde(default)]
    approval: Option<RawApproval>,
    #[serde(default)]
    timezone: Option<String>,
}

#[derive(serde::Deserialize)]
struct RawWorktree {
    dir: String,
}

const DEFAULT_APPROVAL_TIMEOUT_SECS: u64 = 3600;

#[derive(serde::Deserialize)]
struct RawApproval {
    #[serde(default)]
    approvers: Vec<Approver>,
    #[serde(default)]
    timeout_secs: Option<u64>,
}

#[derive(serde::Deserialize)]
#[serde(transparent)]
struct Approver(#[serde(deserialize_with = "crate::bindings::de_snowflake")] String);

#[derive(serde::Deserialize)]
struct RawGuild {
    #[serde(deserialize_with = "crate::bindings::de_snowflake")]
    id: String,
    cwd: String,
    #[serde(default)]
    profile: Option<String>,
}

pub fn load_root(config_path: &Path) -> color_eyre::Result<RootConfig> {
    let text = match std::fs::read_to_string(config_path) {
        Ok(text) => text,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Ok(RootConfig {
                guilds: HashMap::new(),
                worktrees_dir: None,
                approvers: Vec::new(),
                approval_timeout: Duration::from_secs(DEFAULT_APPROVAL_TIMEOUT_SECS),
                timezone: chrono_tz::UTC,
            });
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
            .unwrap_or_else(|| pico_shared::paths::DEFAULT_PROFILE.to_owned());
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
    let worktrees_dir = match raw.worktree {
        Some(w) => {
            let dir = crate::bindings::expand_home(&w.dir);
            if !dir.is_absolute() {
                return Err(color_eyre::eyre::eyre!(
                    "[worktree] dir {} must be an absolute path",
                    dir.display()
                ));
            }
            Some(dir)
        }
        None => None,
    };
    let mut approvers = Vec::new();
    let mut approval_timeout = Duration::from_secs(DEFAULT_APPROVAL_TIMEOUT_SECS);
    if let Some(approval) = raw.approval {
        for Approver(id) in approval.approvers {
            if !crate::bindings::is_valid_snowflake(&id) {
                return Err(color_eyre::eyre::eyre!(
                    "[approval] approver id {id:?} is not a valid snowflake (^[0-9]{{17,20}}$)"
                ));
            }
            if id.parse::<u64>().is_err() {
                return Err(color_eyre::eyre::eyre!(
                    "[approval] approver id {id:?} overflows a 64-bit Discord snowflake"
                ));
            }
            approvers.push(id);
        }
        if let Some(secs) = approval.timeout_secs {
            if secs == 0 {
                return Err(color_eyre::eyre::eyre!("[approval] timeout_secs must be greater than 0"));
            }
            approval_timeout = Duration::from_secs(secs);
        }
    }
    let timezone = match raw.timezone {
        Some(name) => name.parse::<chrono_tz::Tz>().map_err(|_| {
            color_eyre::eyre::eyre!("invalid timezone {name:?} (expected an IANA name like \"America/Vancouver\")")
        })?,
        None => chrono_tz::UTC,
    };
    Ok(RootConfig {
        guilds,
        worktrees_dir,
        approvers,
        approval_timeout,
        timezone,
    })
}

#[cfg(test)]
mod tests {
    use std::{
        path::PathBuf,
        sync::atomic::{AtomicU64, Ordering},
        time::Duration,
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
    fn browser_enabled_parses() {
        let dir = temp_dir("browser");
        let path = dir.join("config.toml");

        std::fs::write(&path, "[browser]\nenabled = true\n").unwrap();
        assert!(super::load(&path).unwrap().browser_enabled);

        std::fs::write(&path, "[browser]\n").unwrap();
        assert!(!super::load(&path).unwrap().browser_enabled);

        std::fs::write(&path, "[llm]\nmodel = \"x\"\n").unwrap();
        assert!(!super::load(&path).unwrap().browser_enabled);

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn any_browser_enabled_scans_profiles() {
        let root = temp_dir("anybrowser");
        assert!(!super::any_browser_enabled(&root));

        let write_profile = |name: &str, body: &str| {
            let dir = root.join("profiles").join(name);
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(dir.join("config.toml"), body).unwrap();
        };

        write_profile("a", "[llm]\nmodel = \"x\"\n");
        write_profile("b", "[browser]\nenabled = false\n");
        assert!(!super::any_browser_enabled(&root));

        write_profile("c", "[browser]\nenabled = true\n");
        assert!(super::any_browser_enabled(&root));

        std::fs::remove_dir_all(&root).ok();
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
    fn reads_streaming_behavior_and_defaults_steer() {
        use super::StreamingBehavior;
        let dir = temp_dir("streaming");

        let bare = dir.join("bare.toml");
        std::fs::write(&bare, "[llm]\nmodel = \"x\"\n").unwrap();
        assert_eq!(super::load(&bare).unwrap().streaming_behavior, StreamingBehavior::Steer);

        let fu = dir.join("fu.toml");
        std::fs::write(&fu, "[discord]\nstreaming_behavior = \"follow_up\"\n").unwrap();
        assert_eq!(super::load(&fu).unwrap().streaming_behavior, StreamingBehavior::FollowUp);

        let st = dir.join("steer.toml");
        std::fs::write(&st, "[discord]\nstreaming_behavior = \"steer\"\n").unwrap();
        assert_eq!(super::load(&st).unwrap().streaming_behavior, StreamingBehavior::Steer);

        let bad = dir.join("bad.toml");
        std::fs::write(&bad, "[discord]\nstreaming_behavior = \"replace\"\n").unwrap();
        assert!(super::load(&bad).is_err());

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

    #[test]
    fn load_root_reads_worktrees_dir() {
        let dir = temp_dir("rootwt");
        let path = dir.join("config.toml");
        std::fs::write(&path, "[worktree]\ndir = \"/srv/worktrees\"\n").unwrap();
        let cfg = super::load_root(&path).unwrap();
        assert_eq!(cfg.worktrees_dir(), Some(PathBuf::from("/srv/worktrees").as_path()));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn load_root_worktrees_dir_absent_is_none() {
        let dir = temp_dir("rootwtnone");
        let path = dir.join("config.toml");
        std::fs::write(&path, "[[guild]]\nid = \"123456789012345678\"\ncwd = \"/tmp\"\n").unwrap();
        assert!(super::load_root(&path).unwrap().worktrees_dir().is_none());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn load_root_rejects_relative_worktrees_dir() {
        let dir = temp_dir("rootwtrel");
        let path = dir.join("config.toml");
        std::fs::write(&path, "[worktree]\ndir = \"relative/wt\"\n").unwrap();
        assert!(super::load_root(&path).is_err());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn load_root_reads_approvers_quoted_and_bare_with_timeout() {
        let dir = temp_dir("rootapprovers");
        let path = dir.join("config.toml");
        std::fs::write(
            &path,
            "[approval]\napprovers = [\"123456789012345678\", 234567890123456789]\ntimeout_secs = 120\n",
        )
        .unwrap();
        let cfg = super::load_root(&path).unwrap();
        assert_eq!(cfg.approvers(), ["123456789012345678", "234567890123456789"]);
        assert_eq!(cfg.approval_timeout(), Duration::from_secs(120));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn load_root_approval_defaults_when_absent() {
        let dir = temp_dir("rootapprnone");
        let path = dir.join("config.toml");
        std::fs::write(&path, "[[guild]]\nid = \"123456789012345678\"\ncwd = \"/tmp\"\n").unwrap();
        let cfg = super::load_root(&path).unwrap();
        assert!(cfg.approvers().is_empty());
        assert_eq!(cfg.approval_timeout(), Duration::from_secs(3600));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn load_root_approval_timeout_defaults_when_omitted() {
        let dir = temp_dir("rootapprtimeoutdefault");
        let path = dir.join("config.toml");
        std::fs::write(&path, "[approval]\napprovers = [\"123456789012345678\"]\n").unwrap();
        let cfg = super::load_root(&path).unwrap();
        assert_eq!(cfg.approval_timeout(), Duration::from_secs(3600));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn load_root_rejects_bad_approver_id() {
        let dir = temp_dir("rootapprbad");
        let path = dir.join("config.toml");
        std::fs::write(&path, "[approval]\napprovers = [\"nope\"]\n").unwrap();
        assert!(super::load_root(&path).is_err());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn load_root_rejects_u64_overflow_approver() {
        let dir = temp_dir("rootapproverflow");
        let path = dir.join("config.toml");
        std::fs::write(&path, "[approval]\napprovers = [\"99999999999999999999\"]\n").unwrap();
        assert!(super::load_root(&path).is_err());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn load_root_rejects_zero_timeout() {
        let dir = temp_dir("rootapprzero");
        let path = dir.join("config.toml");
        std::fs::write(&path, "[approval]\napprovers = [\"123456789012345678\"]\ntimeout_secs = 0\n").unwrap();
        assert!(super::load_root(&path).is_err());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn load_root_reads_iana_timezone() {
        let dir = temp_dir("roottz");
        let path = dir.join("config.toml");
        std::fs::write(&path, "timezone = \"America/Vancouver\"\n").unwrap();
        let cfg = super::load_root(&path).unwrap();
        assert_eq!(cfg.timezone(), chrono_tz::America::Vancouver);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn load_root_defaults_timezone_to_utc() {
        let dir = temp_dir("roottzdefault");
        let path = dir.join("config.toml");
        std::fs::write(&path, "[[guild]]\nid = \"123456789012345678\"\ncwd = \"/tmp\"\n").unwrap();
        let cfg = super::load_root(&path).unwrap();
        assert_eq!(cfg.timezone(), chrono_tz::UTC);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn load_root_rejects_invalid_timezone() {
        let dir = temp_dir("roottzbad");
        let path = dir.join("config.toml");
        std::fs::write(&path, "timezone = \"Mars/Olympus\"\n").unwrap();
        assert!(super::load_root(&path).is_err());
        std::fs::remove_dir_all(&dir).ok();
    }
}
