use std::{
    path::{Path, PathBuf},
    time::Duration,
};

use serde::Deserialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StreamingBehavior {
    FollowUp,
    #[default]
    Steer,
    Queue,
}

#[derive(Clone, Copy)]
pub struct Render {
    pub streaming_behavior: StreamingBehavior,
}

pub struct ProfileConfig {
    pub model: Option<String>,
    pub browser_enabled: bool,
}

#[derive(Deserialize, Default)]
#[serde(deny_unknown_fields)]
struct RawConfig {
    #[serde(default)]
    llm: Option<RawLlm>,
    #[serde(default)]
    browser: Option<RawBrowser>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawLlm {
    #[serde(default)]
    model: Option<String>,
}

#[derive(Deserialize, Default)]
#[serde(deny_unknown_fields)]
struct RawBrowser {
    #[serde(default)]
    enabled: bool,
}

pub fn load(config_path: &Path) -> color_eyre::Result<ProfileConfig> {
    let raw: RawConfig = pico_shared::config::read_toml_or_default(config_path)?;
    Ok(ProfileConfig {
        model: raw.llm.and_then(|llm| llm.model),
        browser_enabled: raw.browser.is_some_and(|b| b.enabled),
    })
}

pub fn any_browser_enabled(root: &Path) -> bool {
    let Ok(entries) = std::fs::read_dir(root.join("profiles")) else {
        return false;
    };
    entries
        .flatten()
        .any(|entry| entry.path().is_dir() && load(&entry.path().join("profile.toml")).is_ok_and(|c| c.browser_enabled))
}

pub struct RootConfig {
    worktrees_dir: Option<PathBuf>,
    timezone: chrono_tz::Tz,
    platforms: Vec<String>,
    schedule: ScheduleConfig,
}

impl RootConfig {
    pub fn worktrees_dir(&self) -> Option<&Path> {
        self.worktrees_dir.as_deref()
    }

    pub fn timezone(&self) -> chrono_tz::Tz {
        self.timezone
    }

    pub fn platforms(&self) -> &[String] {
        &self.platforms
    }

    pub fn schedule(&self) -> ScheduleConfig {
        self.schedule
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ScheduleConfig {
    pub grace: Duration,
    pub script_timeout: Duration,
    pub cap: Duration,
    pub timezone: Option<chrono_tz::Tz>,
    pub run_history: usize,
}

#[derive(Deserialize, Default)]
#[serde(deny_unknown_fields)]
struct RawRootConfig {
    #[serde(default)]
    worktree: Option<RawWorktree>,
    #[serde(default)]
    timezone: Option<String>,
    #[serde(default)]
    platforms: Vec<String>,
    #[serde(default)]
    schedule: Option<RawSchedule>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawWorktree {
    dir: String,
}

#[derive(Deserialize, Default)]
#[serde(deny_unknown_fields)]
struct RawSchedule {
    #[serde(default)]
    grace_secs: Option<u64>,
    #[serde(default)]
    script_timeout_secs: Option<u64>,
    #[serde(default)]
    cap_secs: Option<u64>,
    #[serde(default)]
    run_history: Option<usize>,
}

pub fn load_root(config_path: &Path) -> color_eyre::Result<RootConfig> {
    let raw: RawRootConfig = pico_shared::config::read_toml_or_default(config_path)?;
    let worktrees_dir = match raw.worktree {
        Some(w) => {
            let dir = pico_shared::paths::expand_home(&w.dir);
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
    let timezone_configured = raw.timezone.is_some();
    let timezone = match raw.timezone {
        Some(name) => name.parse::<chrono_tz::Tz>().map_err(|_| {
            color_eyre::eyre::eyre!("invalid timezone {name:?} (expected an IANA name like \"America/Vancouver\")")
        })?,
        None => chrono_tz::UTC,
    };
    let raw_schedule = raw.schedule.unwrap_or_default();
    let schedule = ScheduleConfig {
        grace: Duration::from_secs(raw_schedule.grace_secs.unwrap_or(7200)),
        script_timeout: Duration::from_secs(raw_schedule.script_timeout_secs.unwrap_or(60)),
        cap: Duration::from_secs(raw_schedule.cap_secs.unwrap_or(60)),
        timezone: timezone_configured.then_some(timezone),
        run_history: raw_schedule.run_history.unwrap_or(20),
    };
    Ok(RootConfig {
        worktrees_dir,
        timezone,
        platforms: raw.platforms,
        schedule,
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
        std::fs::write(&path, "[browser]\nenabled = false\n").unwrap();
        let cfg = super::load(&path).unwrap();
        assert_eq!(cfg.model, None);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn rejects_unknown_profile_key() {
        let dir = temp_dir("unknownprofile");
        let path = dir.join("config.toml");
        std::fs::write(&path, "[discord]\nsurface_thinking = true\n").unwrap();
        assert!(super::load(&path).is_err());
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
            std::fs::write(dir.join("profile.toml"), body).unwrap();
        };
        write_profile("a", "[llm]\nmodel = \"x\"\n");
        write_profile("b", "[browser]\nenabled = false\n");
        assert!(!super::any_browser_enabled(&root));
        write_profile("c", "[browser]\nenabled = true\n");
        assert!(super::any_browser_enabled(&root));
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn load_root_reads_worktrees_dir() {
        let dir = temp_dir("rootwt");
        let path = dir.join("worker.toml");
        std::fs::write(&path, "[worktree]\ndir = \"/srv/worktrees\"\n").unwrap();
        let cfg = super::load_root(&path).unwrap();
        assert_eq!(cfg.worktrees_dir(), Some(PathBuf::from("/srv/worktrees").as_path()));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn load_root_worktrees_dir_absent_is_none() {
        let dir = temp_dir("rootwtnone");
        let path = dir.join("worker.toml");
        std::fs::write(&path, "timezone = \"UTC\"\n").unwrap();
        assert!(super::load_root(&path).unwrap().worktrees_dir().is_none());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn load_root_expands_home_in_worktrees_dir() {
        let Some(home) = std::env::home_dir() else {
            return;
        };
        let dir = temp_dir("rootwthome");
        let path = dir.join("worker.toml");
        std::fs::write(&path, "[worktree]\ndir = \"~/picowt\"\n").unwrap();
        let cfg = super::load_root(&path).unwrap();
        assert_eq!(cfg.worktrees_dir(), Some(home.join("picowt").as_path()));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn load_root_rejects_relative_worktrees_dir() {
        let dir = temp_dir("rootwtrel");
        let path = dir.join("worker.toml");
        std::fs::write(&path, "[worktree]\ndir = \"relative/wt\"\n").unwrap();
        assert!(super::load_root(&path).is_err());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn load_root_missing_file_defaults() {
        let dir = temp_dir("rootmissing");
        let cfg = super::load_root(&dir.join("worker.toml")).unwrap();
        assert!(cfg.worktrees_dir().is_none());
        assert_eq!(cfg.timezone(), chrono_tz::UTC);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn load_root_reads_iana_timezone() {
        let dir = temp_dir("roottz");
        let path = dir.join("worker.toml");
        std::fs::write(&path, "timezone = \"America/Vancouver\"\n").unwrap();
        let cfg = super::load_root(&path).unwrap();
        assert_eq!(cfg.timezone(), chrono_tz::America::Vancouver);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn load_root_defaults_timezone_to_utc() {
        let dir = temp_dir("roottzdefault");
        let path = dir.join("worker.toml");
        std::fs::write(&path, "[worktree]\ndir = \"/srv/wt\"\n").unwrap();
        let cfg = super::load_root(&path).unwrap();
        assert_eq!(cfg.timezone(), chrono_tz::UTC);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn load_root_rejects_invalid_timezone() {
        let dir = temp_dir("roottzbad");
        let path = dir.join("worker.toml");
        std::fs::write(&path, "timezone = \"Mars/Olympus\"\n").unwrap();
        assert!(super::load_root(&path).is_err());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn load_root_rejects_moved_guild_key() {
        let dir = temp_dir("rootunknown");
        let path = dir.join("worker.toml");
        std::fs::write(&path, "[[guild]]\nid = \"123456789012345678\"\ncwd = \"/tmp\"\n").unwrap();
        assert!(super::load_root(&path).is_err());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn load_root_reads_platforms_and_defaults_empty() {
        let dir = temp_dir("rootplatforms");
        let path = dir.join("worker.toml");
        std::fs::write(&path, "platforms = [\"discord\"]\n").unwrap();
        assert_eq!(super::load_root(&path).unwrap().platforms(), ["discord"]);

        std::fs::write(&path, "timezone = \"UTC\"\n").unwrap();
        assert!(super::load_root(&path).unwrap().platforms().is_empty());

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn load_root_reads_schedule_overrides_and_defaults() {
        let dir = temp_dir("rootschedule");
        let path = dir.join("worker.toml");
        std::fs::write(
            &path,
            "timezone = \"America/Vancouver\"\n[schedule]\ngrace_secs = 600\nscript_timeout_secs = 30\ncap_secs = 15\nrun_history = 5\n",
        )
        .unwrap();
        let sched = super::load_root(&path).unwrap().schedule();
        assert_eq!(sched.grace, std::time::Duration::from_secs(600));
        assert_eq!(sched.script_timeout, std::time::Duration::from_secs(30));
        assert_eq!(sched.cap, std::time::Duration::from_secs(15));
        assert_eq!(sched.run_history, 5);
        assert_eq!(sched.timezone, Some(chrono_tz::America::Vancouver));

        std::fs::write(&path, "[worktree]\ndir = \"/srv/wt\"\n").unwrap();
        let defaults = super::load_root(&path).unwrap().schedule();
        assert_eq!(defaults.grace, std::time::Duration::from_secs(7200));
        assert_eq!(defaults.script_timeout, std::time::Duration::from_secs(60));
        assert_eq!(defaults.cap, std::time::Duration::from_secs(60));
        assert_eq!(defaults.run_history, 20);
        assert_eq!(defaults.timezone, None);
        std::fs::remove_dir_all(&dir).ok();
    }
}
