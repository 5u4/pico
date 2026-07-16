use std::path::{Path, PathBuf};

use color_eyre::eyre::WrapErr;

pub struct Slots {
    slots_dir: PathBuf,
}

impl Slots {
    pub fn new(base: &Path) -> color_eyre::Result<Self> {
        let slots_dir = base.join("slots");
        std::fs::create_dir_all(&slots_dir).wrap_err_with(|| format!("create {}", slots_dir.display()))?;
        Ok(Self { slots_dir })
    }

    pub fn current_target(&self) -> color_eyre::Result<Option<PathBuf>> {
        self.read_link("current")
    }

    pub fn previous_target(&self) -> color_eyre::Result<Option<PathBuf>> {
        self.read_link("previous")
    }

    pub fn promote(&self, slot: &Path) -> color_eyre::Result<()> {
        if let Some(old) = self.current_target()? {
            self.set_link("previous", &old)?;
        }
        self.set_link("current", slot)
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn promote_moves_current_to_previous() {
        let dir = tempfile::tempdir().unwrap();
        let slots = Slots::new(dir.path()).unwrap();
        let a = dir.path().join("slot-a");
        let b = dir.path().join("slot-b");
        std::fs::create_dir_all(&a).unwrap();
        std::fs::create_dir_all(&b).unwrap();

        assert_eq!(slots.current_target().unwrap(), None);
        slots.promote(&a).unwrap();
        assert_eq!(slots.current_target().unwrap(), Some(a.clone()));
        assert_eq!(slots.previous_target().unwrap(), None);

        slots.promote(&b).unwrap();
        assert_eq!(slots.current_target().unwrap(), Some(b.clone()));
        assert_eq!(slots.previous_target().unwrap(), Some(a.clone()));
    }

    #[test]
    fn swap_exchanges_current_and_previous() {
        let dir = tempfile::tempdir().unwrap();
        let slots = Slots::new(dir.path()).unwrap();
        let a = dir.path().join("slot-a");
        let b = dir.path().join("slot-b");
        std::fs::create_dir_all(&a).unwrap();
        std::fs::create_dir_all(&b).unwrap();

        slots.promote(&a).unwrap();
        slots.promote(&b).unwrap();
        slots.swap().unwrap();
        assert_eq!(slots.current_target().unwrap(), Some(a));
        assert_eq!(slots.previous_target().unwrap(), Some(b));
    }
}
