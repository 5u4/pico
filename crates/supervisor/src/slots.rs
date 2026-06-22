use std::path::{Path, PathBuf};

pub struct Slots {
    slots_dir: PathBuf,
    builds_dir: PathBuf,
}

impl Slots {
    pub fn new(base: &Path) -> color_eyre::Result<Self> {
        let slots_dir = base.join("slots");
        let builds_dir = base.join("builds");
        std::fs::create_dir_all(&slots_dir)?;
        std::fs::create_dir_all(&builds_dir)?;
        Ok(Self { slots_dir, builds_dir })
    }

    pub fn builds_dir(&self) -> &Path {
        &self.builds_dir
    }

    pub fn current_target(&self) -> color_eyre::Result<Option<PathBuf>> {
        self.read_link("current")
    }

    pub fn previous_target(&self) -> color_eyre::Result<Option<PathBuf>> {
        self.read_link("previous")
    }

    pub fn promote(&self, bin: &Path) -> color_eyre::Result<()> {
        if let Some(old) = self.current_target()? {
            self.set_link("previous", &old)?;
        }
        self.set_link("current", bin)
    }

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
