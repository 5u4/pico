use std::{
    collections::HashMap,
    path::{Path, PathBuf},
};

use color_eyre::eyre::WrapErr;
use serde::{Deserialize, Serialize};

pub struct Binding {
    pub channel_id: String,
    pub profile: String,
    pub cwd: PathBuf,
}

pub struct Bindings {
    inner: HashMap<String, Binding>,
}

impl Bindings {
    pub fn get(&self, channel_id: &str) -> Option<&Binding> {
        self.inner.get(channel_id)
    }

    pub fn is_empty(&self) -> bool {
        self.inner.is_empty()
    }

    pub fn len(&self) -> usize {
        self.inner.len()
    }
}

#[derive(Deserialize, Serialize)]
struct RawBinding {
    channel_id: String,
    profile: String,
    kind: String,
    cwd: String,
}

#[derive(Deserialize, Serialize)]
struct RawFile {
    #[serde(default)]
    binding: Vec<RawBinding>,
}

pub fn load(path: &Path) -> color_eyre::Result<Bindings> {
    let file = match read_raw(path)? {
        Some(file) => file,
        None => {
            return Ok(Bindings { inner: HashMap::new() });
        }
    };

    let mut inner = HashMap::with_capacity(file.binding.len());
    for raw in file.binding {
        if raw.kind != "regular" {
            return Err(color_eyre::eyre::eyre!(
                "binding for channel {id}: unsupported kind {kind:?} (only \"regular\" in stage 1)",
                id = raw.channel_id,
                kind = raw.kind,
            ));
        }
        let cwd = expand_home(&raw.cwd);
        if inner.contains_key(&raw.channel_id) {
            return Err(color_eyre::eyre::eyre!("duplicate binding for channel {}", raw.channel_id));
        }
        inner.insert(
            raw.channel_id.clone(),
            Binding {
                channel_id: raw.channel_id,
                profile: raw.profile,
                cwd,
            },
        );
    }

    Ok(Bindings { inner })
}

pub fn set(path: &Path, channel_id: &str, profile: &str, cwd: &Path) -> color_eyre::Result<()> {
    if !is_valid_channel_id(channel_id) {
        return Err(color_eyre::eyre::eyre!(
            "invalid channel id {channel_id:?} (must match ^[0-9]{{17,20}}$)"
        ));
    }

    let cwd = match cwd.to_str() {
        Some(s) => expand_home(s),
        None => cwd.to_path_buf(),
    };
    if !cwd.is_absolute() {
        return Err(color_eyre::eyre::eyre!("cwd {} must be an absolute path", cwd.display()));
    }
    match std::fs::metadata(&cwd) {
        Ok(meta) if meta.is_dir() => {}
        Ok(_) => {
            return Err(color_eyre::eyre::eyre!("cwd {} is not a directory", cwd.display()));
        }
        Err(e) => {
            return Err(e).wrap_err_with(|| format!("cwd {} is not accessible", cwd.display()));
        }
    }

    let mut file = read_raw(path)?.unwrap_or(RawFile { binding: Vec::new() });
    let entry = RawBinding {
        channel_id: channel_id.to_string(),
        profile: profile.to_string(),
        kind: "regular".to_string(),
        cwd: cwd.to_string_lossy().into_owned(),
    };
    match file.binding.iter_mut().find(|b| b.channel_id == channel_id) {
        Some(existing) => *existing = entry,
        None => file.binding.push(entry),
    }

    write_atomic(path, &file)
}

pub fn unset(path: &Path, channel_id: &str) -> color_eyre::Result<bool> {
    let mut file = match read_raw(path)? {
        Some(file) => file,
        None => return Ok(false),
    };

    let before = file.binding.len();
    file.binding.retain(|b| b.channel_id != channel_id);
    if file.binding.len() == before {
        return Ok(false);
    }

    write_atomic(path, &file)?;
    Ok(true)
}

fn read_raw(path: &Path) -> color_eyre::Result<Option<RawFile>> {
    match std::fs::read_to_string(path) {
        Ok(text) => {
            let file = toml::from_str(&text).wrap_err_with(|| format!("parsing {}", path.display()))?;
            Ok(Some(file))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e).wrap_err_with(|| format!("reading {}", path.display())),
    }
}

fn write_atomic(path: &Path, file: &RawFile) -> color_eyre::Result<()> {
    let text = toml::to_string(file).wrap_err("serializing bindings")?;
    let dir = path.parent().unwrap_or_else(|| Path::new("."));
    std::fs::create_dir_all(dir).wrap_err_with(|| format!("creating {}", dir.display()))?;

    let mut tmp_name = std::ffi::OsString::from(".");
    tmp_name.push(
        path.file_name()
            .unwrap_or_else(|| std::ffi::OsStr::new("bindings.toml")),
    );
    tmp_name.push(format!(".tmp.{}", std::process::id()));
    let tmp = dir.join(tmp_name);

    std::fs::write(&tmp, text).wrap_err_with(|| format!("writing {}", tmp.display()))?;
    std::fs::rename(&tmp, path).wrap_err_with(|| format!("renaming {} -> {}", tmp.display(), path.display()))?;
    Ok(())
}

fn is_valid_channel_id(id: &str) -> bool {
    (17..=20).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_digit())
}

fn expand_home(raw: &str) -> PathBuf {
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

#[cfg(test)]
mod tests {
    use std::{
        path::PathBuf,
        sync::atomic::{AtomicU64, Ordering},
    };

    fn temp_dir(tag: &str) -> PathBuf {
        static N: AtomicU64 = AtomicU64::new(0);
        let n = N.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("pico-bindings-{}-{}-{}", tag, std::process::id(), n));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn loads_two_bindings() {
        let dir = temp_dir("load2");
        let path = dir.join("bindings.toml");
        std::fs::write(
            &path,
            r#"
[[binding]]
channel_id = "1234567890123456789"
profile = "sen"
kind = "regular"
cwd = "/tmp"

[[binding]]
channel_id = "9876543210987654321"
profile = "dev"
kind = "regular"
cwd = "/var"
"#,
        )
        .unwrap();

        let bindings = super::load(&path).unwrap();
        assert_eq!(bindings.len(), 2);
        assert!(!bindings.is_empty());
        assert_eq!(bindings.get("1234567890123456789").unwrap().profile, "sen");
        assert_eq!(bindings.get("9876543210987654321").unwrap().cwd, PathBuf::from("/var"));

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn missing_file_is_empty() {
        let dir = temp_dir("missing");
        let bindings = super::load(&dir.join("bindings.toml")).unwrap();
        assert!(bindings.is_empty());
        assert_eq!(bindings.len(), 0);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn duplicate_channel_id_errors() {
        let dir = temp_dir("dup");
        let path = dir.join("bindings.toml");
        std::fs::write(
            &path,
            r#"
[[binding]]
channel_id = "1234567890123456789"
profile = "sen"
kind = "regular"
cwd = "/tmp"

[[binding]]
channel_id = "1234567890123456789"
profile = "dev"
kind = "regular"
cwd = "/var"
"#,
        )
        .unwrap();

        assert!(super::load(&path).is_err());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn unsupported_kind_errors() {
        let dir = temp_dir("kind");
        let path = dir.join("bindings.toml");
        std::fs::write(
            &path,
            r#"
[[binding]]
channel_id = "1234567890123456789"
profile = "sen"
kind = "worktree"
cwd = "/tmp"
"#,
        )
        .unwrap();

        assert!(super::load(&path).is_err());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn set_then_load_roundtrips() {
        let dir = temp_dir("set");
        let path = dir.join("bindings.toml");
        super::set(&path, "11111111111111111", "sen", &dir).unwrap();

        let bindings = super::load(&path).unwrap();
        let binding = bindings.get("11111111111111111").unwrap();
        assert_eq!(binding.profile, "sen");
        assert_eq!(binding.cwd, dir);

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn set_nonexistent_cwd_errors() {
        let dir = temp_dir("setbadcwd");
        let path = dir.join("bindings.toml");
        let missing = dir.join("does-not-exist");
        assert!(super::set(&path, "11111111111111111", "sen", &missing).is_err());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn set_invalid_channel_id_errors() {
        let dir = temp_dir("setbadid");
        let path = dir.join("bindings.toml");
        assert!(super::set(&path, "abc", "sen", &dir).is_err());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn unset_returns_true_then_false() {
        let dir = temp_dir("unset");
        let path = dir.join("bindings.toml");
        super::set(&path, "11111111111111111", "sen", &dir).unwrap();

        assert!(super::unset(&path, "11111111111111111").unwrap());
        assert!(!super::unset(&path, "11111111111111111").unwrap());

        std::fs::remove_dir_all(&dir).ok();
    }
}
