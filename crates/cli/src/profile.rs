use std::path::{Path, PathBuf};

use clap::Subcommand;
use color_eyre::eyre::WrapErr;

#[derive(Subcommand)]
pub enum ProfileCommand {
    Create { name: String },
    List,
}

pub fn run(cmd: ProfileCommand) -> color_eyre::Result<()> {
    let root = pico_shared::paths::worker_root()?;
    match cmd {
        ProfileCommand::Create { name } => {
            let dir = create(&root, &name)?;
            println!("created profile {name}");
            println!("  dir: {}", dir.display());
        }
        ProfileCommand::List => {
            for name in list(&root)? {
                println!("{name}");
            }
        }
    }
    Ok(())
}

fn create(root: &Path, name: &str) -> color_eyre::Result<PathBuf> {
    if !pico_shared::validate::is_valid_profile(name) {
        return Err(color_eyre::eyre::eyre!(
            "invalid profile name {name:?} (must match ^[A-Za-z0-9_-]+$)"
        ));
    }
    let dir = pico_shared::paths::profile_dir(root, name);
    if dir.exists() {
        return Err(color_eyre::eyre::eyre!("profile {name:?} already exists at {}", dir.display()));
    }
    std::fs::create_dir_all(&dir).wrap_err_with(|| format!("create profile dir {}", dir.display()))?;
    Ok(dir)
}

fn list(root: &Path) -> color_eyre::Result<Vec<String>> {
    let entries = match std::fs::read_dir(pico_shared::paths::profiles_dir(root)) {
        Ok(entries) => entries,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(vec![]),
        Err(err) => return Err(err.into()),
    };
    let mut names = Vec::new();
    for entry in entries {
        let entry = entry?;
        if entry.path().is_dir() {
            names.push(entry.file_name().to_string_lossy().into_owned());
        }
    }
    names.sort();
    Ok(names)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root() -> PathBuf {
        std::env::temp_dir().join(format!("pico-profile-test-{}", ulid::Ulid::new()))
    }

    #[test]
    fn create_makes_dir() {
        let root = temp_root();
        let dir = create(&root, "alpha").unwrap();
        assert_eq!(dir, pico_shared::paths::profile_dir(&root, "alpha"));
        assert!(dir.is_dir());
        assert!(!pico_shared::paths::profile_config(&root, "alpha").exists());
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn create_rejects_invalid_name() {
        let root = temp_root();
        let err = create(&root, "bad name").unwrap_err();
        assert!(format!("{err:#}").contains("invalid profile name"));
        assert!(!pico_shared::paths::profile_dir(&root, "bad name").exists());
        assert!(create(&root, "").is_err());
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn create_rejects_existing() {
        let root = temp_root();
        create(&root, "dup").unwrap();
        let err = create(&root, "dup").unwrap_err();
        assert!(format!("{err:#}").contains("already exists"));
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn list_empty_when_missing() {
        let root = temp_root();
        assert_eq!(list(&root).unwrap(), Vec::<String>::new());
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn list_returns_sorted_dirs_only() {
        let root = temp_root();
        create(&root, "zeta").unwrap();
        create(&root, "alpha").unwrap();
        std::fs::write(pico_shared::paths::profiles_dir(&root).join("notaprofile.txt"), b"").unwrap();
        assert_eq!(list(&root).unwrap(), vec!["alpha".to_string(), "zeta".to_string()]);
        std::fs::remove_dir_all(&root).ok();
    }
}
