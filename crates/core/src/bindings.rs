use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};

use color_eyre::eyre::WrapErr;
use serde::{Deserialize, Serialize};

pub struct Binding {
    pub channel_id: String,
    pub profile: String,
    pub kind: BindingKind,
}

pub enum BindingKind {
    Regular { cwd: PathBuf },
    Worktree { base_repo: PathBuf, default_branch: String },
}

pub const DEFAULT_BRANCH: &str = "origin/main";

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
    #[serde(deserialize_with = "de_snowflake")]
    channel_id: String,
    profile: String,
    kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    cwd: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    base_repo: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    default_branch: Option<String>,
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
        let binding = binding_from_raw(raw)?;
        if inner.contains_key(&binding.channel_id) {
            return Err(color_eyre::eyre::eyre!("duplicate binding for channel {}", binding.channel_id));
        }
        inner.insert(binding.channel_id.clone(), binding);
    }

    Ok(Bindings { inner })
}

fn binding_from_raw(raw: RawBinding) -> color_eyre::Result<Binding> {
    let RawBinding {
        channel_id,
        profile,
        kind,
        cwd,
        base_repo,
        default_branch,
    } = raw;
    validate_identity(&channel_id, &profile)?;
    let kind = match kind.as_str() {
        "regular" => {
            let cwd = cwd.ok_or_else(|| {
                color_eyre::eyre::eyre!("binding for channel {channel_id}: kind \"regular\" requires cwd")
            })?;
            let cwd = expand_home(&cwd);
            validate_existing_dir("cwd", &cwd)?;
            BindingKind::Regular { cwd }
        }
        "worktree" => {
            let base_repo = base_repo.ok_or_else(|| {
                color_eyre::eyre::eyre!("binding for channel {channel_id}: kind \"worktree\" requires base_repo")
            })?;
            let base_repo = expand_home(&base_repo);
            validate_existing_dir("base_repo", &base_repo)?;
            let default_branch = default_branch.unwrap_or_else(|| DEFAULT_BRANCH.to_owned());
            validate_branch(&default_branch)?;
            BindingKind::Worktree {
                base_repo,
                default_branch,
            }
        }
        other => {
            return Err(color_eyre::eyre::eyre!(
                "binding for channel {channel_id}: unsupported kind {other:?} (\"regular\" or \"worktree\")"
            ));
        }
    };
    Ok(Binding {
        channel_id,
        profile,
        kind,
    })
}

pub fn set(path: &Path, channel_id: &str, profile: &str, cwd: &Path) -> color_eyre::Result<()> {
    let cwd = match cwd.to_str() {
        Some(s) => expand_home(s),
        None => cwd.to_path_buf(),
    };
    validate_identity(channel_id, profile)?;
    validate_existing_dir("cwd", &cwd)?;

    upsert(
        path,
        RawBinding {
            channel_id: channel_id.to_string(),
            profile: profile.to_string(),
            kind: "regular".to_string(),
            cwd: Some(cwd.to_string_lossy().into_owned()),
            base_repo: None,
            default_branch: None,
        },
    )
}

pub fn set_worktree(
    path: &Path,
    channel_id: &str,
    profile: &str,
    base_repo: &Path,
    default_branch: &str,
) -> color_eyre::Result<()> {
    let base_repo = match base_repo.to_str() {
        Some(s) => expand_home(s),
        None => base_repo.to_path_buf(),
    };
    validate_identity(channel_id, profile)?;
    validate_existing_dir("base_repo", &base_repo)?;
    validate_branch(default_branch)?;

    upsert(
        path,
        RawBinding {
            channel_id: channel_id.to_string(),
            profile: profile.to_string(),
            kind: "worktree".to_string(),
            cwd: None,
            base_repo: Some(base_repo.to_string_lossy().into_owned()),
            default_branch: Some(default_branch.to_string()),
        },
    )
}

fn upsert(path: &Path, entry: RawBinding) -> color_eyre::Result<()> {
    let _guard = write_lock();
    let mut file = read_raw(path)?.unwrap_or(RawFile { binding: Vec::new() });
    match file.binding.iter_mut().find(|b| b.channel_id == entry.channel_id) {
        Some(existing) => *existing = entry,
        None => file.binding.push(entry),
    }
    write_atomic(path, &file)
}

pub fn unset(path: &Path, channel_id: &str) -> color_eyre::Result<bool> {
    let _guard = write_lock();
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

    static SEQ: AtomicU64 = AtomicU64::new(0);
    let seq = SEQ.fetch_add(1, Ordering::Relaxed);
    let mut tmp_name = std::ffi::OsString::from(".");
    tmp_name.push(
        path.file_name()
            .unwrap_or_else(|| std::ffi::OsStr::new("bindings.toml")),
    );
    tmp_name.push(format!(".tmp.{}.{}", std::process::id(), seq));
    let tmp = dir.join(tmp_name);

    std::fs::write(&tmp, text).wrap_err_with(|| format!("writing {}", tmp.display()))?;
    std::fs::rename(&tmp, path).wrap_err_with(|| format!("renaming {} -> {}", tmp.display(), path.display()))?;
    Ok(())
}

pub(crate) fn is_valid_snowflake(id: &str) -> bool {
    (17..=20).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_digit())
}

pub(crate) fn is_valid_profile(name: &str) -> bool {
    !name.is_empty()
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

pub(crate) fn is_valid_branch(branch: &str) -> bool {
    !branch.is_empty()
        && !branch.starts_with('-')
        && !branch.contains("..")
        && branch
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'/' | b'-'))
}

fn validate_branch(branch: &str) -> color_eyre::Result<()> {
    if !is_valid_branch(branch) {
        return Err(color_eyre::eyre::eyre!(
            "invalid branch {branch:?} (no leading '-', chars [A-Za-z0-9._/-], no \"..\")"
        ));
    }
    Ok(())
}

fn validate_identity(channel_id: &str, profile: &str) -> color_eyre::Result<()> {
    if !is_valid_snowflake(channel_id) {
        return Err(color_eyre::eyre::eyre!(
            "invalid channel id {channel_id:?} (must match ^[0-9]{{17,20}}$)"
        ));
    }
    if !is_valid_profile(profile) {
        return Err(color_eyre::eyre::eyre!(
            "invalid profile {profile:?} (must match ^[A-Za-z0-9_-]+$)"
        ));
    }
    Ok(())
}

fn validate_existing_dir(label: &str, path: &Path) -> color_eyre::Result<()> {
    if !path.is_absolute() {
        return Err(color_eyre::eyre::eyre!("{label} {} must be an absolute path", path.display()));
    }
    match std::fs::metadata(path) {
        Ok(meta) if meta.is_dir() => Ok(()),
        Ok(_) => Err(color_eyre::eyre::eyre!("{label} {} is not a directory", path.display())),
        Err(e) => Err(e).wrap_err_with(|| format!("{label} {} is not accessible", path.display())),
    }
}

fn write_lock() -> std::sync::MutexGuard<'static, ()> {
    static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

pub(crate) fn de_snowflake<'de, D>(de: D) -> Result<String, D::Error>
where
    D: serde::Deserializer<'de>,
{
    struct Snowflake;
    impl<'de> serde::de::Visitor<'de> for Snowflake {
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

pub(crate) fn expand_home(raw: &str) -> PathBuf {
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
        let b = bindings.get("9876543210987654321").unwrap();
        assert!(matches!(&b.kind, super::BindingKind::Regular { cwd } if cwd == &PathBuf::from("/var")));

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
    fn unknown_kind_errors() {
        let dir = temp_dir("kind");
        let path = dir.join("bindings.toml");
        std::fs::write(
            &path,
            "[[binding]]\nchannel_id = \"1234567890123456789\"\nprofile = \"sen\"\nkind = \"bogus\"\ncwd = \"/tmp\"\n",
        )
        .unwrap();
        assert!(super::load(&path).is_err());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn loads_worktree_binding() {
        let dir = temp_dir("wt");
        let repo = dir.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        let path = dir.join("bindings.toml");
        std::fs::write(
            &path,
            format!(
                "[[binding]]\nchannel_id = \"1234567890123456789\"\nprofile = \"sen\"\nkind = \"worktree\"\nbase_repo = {repo:?}\ndefault_branch = \"trunk\"\n"
            ),
        )
        .unwrap();
        let bindings = super::load(&path).unwrap();
        match &bindings.get("1234567890123456789").unwrap().kind {
            super::BindingKind::Worktree {
                base_repo,
                default_branch,
            } => {
                assert_eq!(base_repo, &repo);
                assert_eq!(default_branch, "trunk");
            }
            _ => panic!("expected worktree"),
        }
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn worktree_defaults_branch_to_origin_main() {
        let dir = temp_dir("wtdefault");
        let path = dir.join("bindings.toml");
        std::fs::write(
            &path,
            format!(
                "[[binding]]\nchannel_id = \"1234567890123456789\"\nprofile = \"sen\"\nkind = \"worktree\"\nbase_repo = {dir:?}\n"
            ),
        )
        .unwrap();
        let bindings = super::load(&path).unwrap();
        match &bindings.get("1234567890123456789").unwrap().kind {
            super::BindingKind::Worktree { default_branch, .. } => assert_eq!(default_branch, super::DEFAULT_BRANCH),
            _ => panic!("expected worktree"),
        }
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn worktree_requires_base_repo() {
        let dir = temp_dir("wtnorepo");
        let path = dir.join("bindings.toml");
        std::fs::write(
            &path,
            "[[binding]]\nchannel_id = \"1234567890123456789\"\nprofile = \"sen\"\nkind = \"worktree\"\n",
        )
        .unwrap();
        assert!(super::load(&path).is_err());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn set_worktree_roundtrips() {
        let dir = temp_dir("setwt");
        let path = dir.join("bindings.toml");
        super::set_worktree(&path, "11111111111111111", "sen", &dir, "main").unwrap();
        let bindings = super::load(&path).unwrap();
        match &bindings.get("11111111111111111").unwrap().kind {
            super::BindingKind::Worktree {
                base_repo,
                default_branch,
            } => {
                assert_eq!(base_repo, &dir);
                assert_eq!(default_branch, "main");
            }
            _ => panic!("expected worktree"),
        }
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn set_worktree_rejects_option_like_branch() {
        let dir = temp_dir("wtbadbranch");
        let path = dir.join("bindings.toml");
        for bad in ["--upload-pack=touch /tmp/x", "-", "--all", "a b", "x..y", ""] {
            assert!(
                super::set_worktree(&path, "11111111111111111", "sen", &dir, bad).is_err(),
                "branch {bad:?} should be rejected"
            );
        }
        super::set_worktree(&path, "11111111111111111", "sen", &dir, "release/1.x").unwrap();
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn load_rejects_option_like_default_branch() {
        let dir = temp_dir("wtbadload");
        let path = dir.join("bindings.toml");
        std::fs::write(
            &path,
            format!(
                "[[binding]]\nchannel_id = \"1234567890123456789\"\nprofile = \"sen\"\nkind = \"worktree\"\nbase_repo = {dir:?}\ndefault_branch = \"--upload-pack=x\"\n"
            ),
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
        assert!(matches!(&binding.kind, super::BindingKind::Regular { cwd } if cwd == &dir));

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

    #[test]
    fn channel_id_accepts_a_bare_integer() {
        let dir = temp_dir("intid");
        let path = dir.join("bindings.toml");
        std::fs::write(
            &path,
            "[[binding]]\nchannel_id = 1234567890123456789\nprofile = \"sen\"\nkind = \"regular\"\ncwd = \"/tmp\"\n",
        )
        .unwrap();
        let bindings = super::load(&path).unwrap();
        assert!(bindings.get("1234567890123456789").is_some());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn set_rejects_path_traversal_profile() {
        let dir = temp_dir("travset");
        let path = dir.join("bindings.toml");
        assert!(super::set(&path, "11111111111111111", "..", &dir).is_err());
        assert!(super::set(&path, "11111111111111111", "/etc", &dir).is_err());
        assert!(super::set(&path, "11111111111111111", "a/b", &dir).is_err());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn load_rejects_path_traversal_profile() {
        let dir = temp_dir("travload");
        let path = dir.join("bindings.toml");
        std::fs::write(
            &path,
            "[[binding]]\nchannel_id = \"1234567890123456789\"\nprofile = \"..\"\nkind = \"regular\"\ncwd = \"/tmp\"\n",
        )
        .unwrap();
        assert!(super::load(&path).is_err());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn load_rejects_invalid_channel_id() {
        let dir = temp_dir("badidload");
        let path = dir.join("bindings.toml");
        std::fs::write(
            &path,
            "[[binding]]\nchannel_id = \"abc\"\nprofile = \"sen\"\nkind = \"regular\"\ncwd = \"/tmp\"\n",
        )
        .unwrap();
        assert!(super::load(&path).is_err());
        std::fs::remove_dir_all(&dir).ok();
    }
}
