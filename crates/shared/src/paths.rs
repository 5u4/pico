use std::path::{Path, PathBuf};

pub const DEFAULT_WORKER: &str = "default";

fn home() -> color_eyre::Result<PathBuf> {
    std::env::home_dir().ok_or_else(|| color_eyre::eyre::eyre!("cannot determine home directory"))
}

pub fn pico_home() -> color_eyre::Result<PathBuf> {
    Ok(home()?.join(".pico"))
}

pub fn agent_repo() -> color_eyre::Result<PathBuf> {
    Ok(pico_home()?.join("agent"))
}

pub fn pico_build_target_dir() -> color_eyre::Result<PathBuf> {
    Ok(home()?.join(".cache").join("build").join("pico-target"))
}

pub fn supervisor_dir() -> color_eyre::Result<PathBuf> {
    Ok(pico_home()?.join("supervisor"))
}

pub fn worker_root(name: &str) -> color_eyre::Result<PathBuf> {
    Ok(pico_home()?.join("workers").join(name))
}

pub fn worker_secret(root: &Path, name: &str) -> PathBuf {
    root.join("secrets").join(name)
}

pub fn worker_bindings(root: &Path) -> PathBuf {
    root.join("bindings.toml")
}

pub fn worker_config(root: &Path) -> PathBuf {
    root.join("config.toml")
}

pub fn profile_dir(root: &Path, name: &str) -> PathBuf {
    root.join("profiles").join(name)
}

pub fn profile_config(root: &Path, name: &str) -> PathBuf {
    profile_dir(root, name).join("config.toml")
}

pub fn profile_identity(root: &Path, name: &str) -> PathBuf {
    profile_dir(root, name).join("identity.md")
}

pub fn profile_append(root: &Path, name: &str) -> PathBuf {
    profile_dir(root, name).join("append.md")
}

pub fn profile_session_dir(root: &Path, name: &str, thread_id: &str) -> PathBuf {
    profile_dir(root, name).join("sessions").join(thread_id)
}

pub fn default_worktrees_dir(root: &Path) -> PathBuf {
    root.join("worktrees")
}

pub fn thread_marker(root: &Path, thread_id: &str) -> PathBuf {
    root.join("threads").join(format!("{thread_id}.toml"))
}

pub fn worker_db(root: &Path) -> PathBuf {
    root.join("pico.db")
}

pub fn camofox_dir(root: &Path) -> PathBuf {
    root.join("camofox")
}

pub fn camofox_extension(root: &Path) -> PathBuf {
    camofox_dir(root).join("extension.ts")
}

pub fn camofox_profile_dir(root: &Path) -> PathBuf {
    camofox_dir(root).join("profiles")
}
