use std::path::{Path, PathBuf};

/// Manages the supervisor's `builds/` tree and `slots/{current,previous}` symlinks.
pub struct Slots {
    slots_dir: PathBuf,
    builds_dir: PathBuf,
}

impl Slots {
    /// Create from the supervisor base dir; ensures `<base>/slots` and `<base>/builds` exist.
    pub fn new(base: &Path) -> color_eyre::Result<Self> {
        let slots_dir = base.join("slots");
        let builds_dir = base.join("builds");
        std::fs::create_dir_all(&slots_dir)?;
        std::fs::create_dir_all(&builds_dir)?;
        Ok(Self { slots_dir, builds_dir })
    }

    /// `<base>/builds` — where resolved binaries are written.
    pub fn builds_dir(&self) -> &Path {
        &self.builds_dir
    }

    /// Resolve the `current` symlink target, or `None` if the link doesn't exist.
    pub fn current_target(&self) -> color_eyre::Result<Option<PathBuf>> {
        self.read_link("current")
    }

    /// Resolve the `previous` symlink target, or `None` if the link doesn't exist.
    pub fn previous_target(&self) -> color_eyre::Result<Option<PathBuf>> {
        self.read_link("previous")
    }

    /// Point `current` at `bin`, moving the prior `current` target into `previous`.
    pub fn promote(&self, bin: &Path) -> color_eyre::Result<()> {
        if let Some(old) = self.current_target()? {
            self.set_link("previous", &old)?;
        }
        self.set_link("current", bin)
    }

    /// Exchange the `current` and `previous` symlinks (used by rollback).
    pub fn swap(&self) -> color_eyre::Result<()> {
        let current = self.current_target()?;
        let previous = self.previous_target()?;
        if let Some(c) = current {
            self.set_link("previous", &c)?;
        }
        if let Some(p) = previous {
            self.set_link("current", &p)?;
        }
        Ok(())
    }

    fn read_link(&self, name: &str) -> color_eyre::Result<Option<PathBuf>> {
        match std::fs::read_link(self.slots_dir.join(name)) {
            Ok(target) => Ok(Some(target)),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(err) => Err(err.into()),
        }
    }

    fn set_link(&self, name: &str, target: &Path) -> color_eyre::Result<()> {
        let tmp = self.slots_dir.join(format!("{name}.tmp"));
        let final_link = self.slots_dir.join(name);
        match std::fs::remove_file(&tmp) {
            Ok(()) => {}
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
            Err(err) => return Err(err.into()),
        }
        std::os::unix::fs::symlink(target, &tmp)?;
        std::fs::rename(&tmp, &final_link)?;
        Ok(())
    }
}
