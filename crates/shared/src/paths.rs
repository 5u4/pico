use std::path::{Path, PathBuf};

pub const DEFAULT_PROFILE: &str = "default";

fn home() -> color_eyre::Result<PathBuf> {
    std::env::home_dir().ok_or_else(|| color_eyre::eyre::eyre!("cannot determine home directory"))
}

pub fn pico_home() -> color_eyre::Result<PathBuf> {
    if let Some(val) = std::env::var_os("PICO_HOME")
        && !val.is_empty()
    {
        let path = PathBuf::from(val);
        if !path.is_absolute() {
            return Err(color_eyre::eyre::eyre!(
                "PICO_HOME must be an absolute path, got {}",
                path.display()
            ));
        }
        return Ok(path);
    }
    Ok(home()?.join(".pico"))
}

pub fn agent_repo() -> color_eyre::Result<PathBuf> {
    Ok(pico_home()?.join("agent"))
}

pub fn pico_build_target_dir() -> color_eyre::Result<PathBuf> {
    Ok(home()?.join(".cache").join("build").join("pico-target"))
}

pub fn local_install_root() -> color_eyre::Result<PathBuf> {
    Ok(home()?.join(".local"))
}

pub fn supervisor_dir() -> color_eyre::Result<PathBuf> {
    Ok(pico_home()?.join("supervisor"))
}

pub fn worker_root() -> color_eyre::Result<PathBuf> {
    Ok(pico_home()?.join("worker"))
}

pub fn worker_secret(root: &Path, name: &str) -> PathBuf {
    root.join("secrets").join(name)
}

pub fn worker_config(root: &Path) -> PathBuf {
    root.join("worker.toml")
}

pub fn discord_config(root: &Path) -> PathBuf {
    root.join("discord.toml")
}

pub fn profile_dir(root: &Path, name: &str) -> PathBuf {
    root.join("profiles").join(name)
}

pub fn profile_config(root: &Path, name: &str) -> PathBuf {
    profile_dir(root, name).join("profile.toml")
}

pub fn profile_identity(root: &Path, name: &str) -> PathBuf {
    profile_dir(root, name).join("identity.md")
}

pub fn profile_session_dir(root: &Path, name: &str, platform: &str, thread_id: &str) -> PathBuf {
    profile_dir(root, name).join("sessions").join(platform).join(thread_id)
}

pub fn default_worktrees_dir(root: &Path) -> PathBuf {
    root.join("worktrees")
}

pub fn worker_db(root: &Path) -> PathBuf {
    root.join("pico.db")
}

pub fn camofox_dir(root: &Path) -> PathBuf {
    root.join("extensions").join("camofox")
}

pub fn camofox_profile_dir(root: &Path) -> PathBuf {
    camofox_dir(root).join("profiles")
}

pub const SCHEDULE_STATES: [&str; 3] = ["active", "disabled", "triggered"];

pub fn schedules_dir(root: &Path) -> PathBuf {
    root.join("schedules")
}

pub fn schedule_state_dir(root: &Path, state: &str) -> PathBuf {
    schedules_dir(root).join(state)
}

pub fn schedule_dir(root: &Path, state: &str, id: &str) -> PathBuf {
    schedule_state_dir(root, state).join(id)
}

pub fn schedule_runs_dir(root: &Path, state: &str, id: &str) -> PathBuf {
    schedule_dir(root, state, id).join("runs")
}

pub fn find_schedule_dir(root: &Path, id: &str) -> Option<(&'static str, PathBuf)> {
    SCHEDULE_STATES.into_iter().find_map(|state| {
        let dir = schedule_dir(root, state, id);
        dir.is_dir().then_some((state, dir))
    })
}

pub fn expand_home(raw: &str) -> PathBuf {
    if raw == "~"
        && let Some(home) = std::env::home_dir()
    {
        return home;
    }
    if let Some(rest) = raw.strip_prefix("~/")
        && let Some(home) = std::env::home_dir()
    {
        return home.join(rest);
    }
    PathBuf::from(raw)
}

pub fn to_portable(path: &Path, base: &Path) -> String {
    match path.strip_prefix(base) {
        Ok(rel) if !rel.as_os_str().is_empty() => rel.to_string_lossy().into_owned(),
        Ok(_) => ".".to_owned(),
        Err(_) => path.to_string_lossy().into_owned(),
    }
}

pub fn from_portable(stored: &str, base: &Path) -> Option<PathBuf> {
    let path = expand_home(stored);
    if path.is_absolute() {
        return Some(path);
    }
    if path.components().any(|c| matches!(c, std::path::Component::ParentDir)) {
        return None;
    }
    Some(base.join(path))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn under_base_roundtrips_relative() {
        let base = Path::new("/home/pico/.pico");
        let abs = Path::new("/home/pico/.pico/worker/worktrees/c/t");
        let stored = to_portable(abs, base);
        assert_eq!(stored, "worker/worktrees/c/t");
        assert_eq!(from_portable(&stored, base).unwrap(), abs);
    }

    #[test]
    fn outside_base_stays_absolute() {
        let base = Path::new("/home/pico/.pico");
        let abs = Path::new("/srv/external/repo");
        let stored = to_portable(abs, base);
        assert_eq!(stored, "/srv/external/repo");
        assert_eq!(from_portable(&stored, base).unwrap(), abs);
    }

    #[test]
    fn legacy_absolute_under_base_still_resolves() {
        let base = Path::new("/home/pico/.pico");
        assert_eq!(
            from_portable("/home/pico/.pico/worker/worktrees/c/t", base).unwrap(),
            Path::new("/home/pico/.pico/worker/worktrees/c/t")
        );
    }

    #[test]
    fn rejects_relative_parent_escape() {
        let base = Path::new("/home/pico/.pico");
        assert!(from_portable("../outside", base).is_none());
        assert!(from_portable("worker/../../escape", base).is_none());
    }

    #[test]
    fn schedule_paths_compose_state_layout() {
        let root = Path::new("/r");
        assert_eq!(schedules_dir(root), Path::new("/r/schedules"));
        assert_eq!(schedule_state_dir(root, "active"), Path::new("/r/schedules/active"));
        assert_eq!(schedule_dir(root, "disabled", "id1"), Path::new("/r/schedules/disabled/id1"));
        assert_eq!(
            schedule_runs_dir(root, "triggered", "id1"),
            Path::new("/r/schedules/triggered/id1/runs")
        );
    }

    #[test]
    fn find_schedule_dir_locates_across_states() {
        let root = std::env::temp_dir().join(format!("pico-paths-find-{}", std::process::id()));
        std::fs::remove_dir_all(&root).ok();
        let id = "20260101000000-x";
        std::fs::create_dir_all(schedule_dir(&root, "disabled", id)).unwrap();
        let (state, dir) = find_schedule_dir(&root, id).unwrap();
        assert_eq!(state, "disabled");
        assert_eq!(dir, schedule_dir(&root, "disabled", id));
        assert!(find_schedule_dir(&root, "missing").is_none());
        std::fs::remove_dir_all(&root).ok();
    }
}
