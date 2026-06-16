//! Per-thread frozen route. A thread's profile + cwd (and, for a worktree, its
//! base repo + start ref) are recorded on its first turn under
//! `<root>/threads/<thread_id>.toml`, so a later channel rebind never migrates an
//! existing thread to a new cwd/worktree. Keyed by thread id, independent of
//! profile.

use std::{
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};

use color_eyre::eyre::WrapErr;
use serde::{Deserialize, Serialize};

pub struct ThreadMarker {
    pub profile: String,
    pub cwd: PathBuf,
    /// Present iff the thread is a worktree thread — lets `cwd` be recreated if
    /// the worktree was torn down out from under the worker.
    pub worktree: Option<WorktreeOrigin>,
}

pub struct WorktreeOrigin {
    pub base_repo: PathBuf,
    pub default_branch: String,
}

#[derive(Deserialize, Serialize)]
struct RawMarker {
    profile: String,
    cwd: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    base_repo: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    default_branch: Option<String>,
}

/// Read a thread's marker. `None` means "resolve from the channel binding": the
/// marker is absent (first turn) or present-but-unreadable/invalid (self-heal —
/// the caller re-resolves and overwrites). The profile is re-validated because it
/// becomes a path component under `<root>/profiles/`, so a tampered marker can't
/// escape.
pub fn load(root: &Path, thread_id: &str) -> Option<ThreadMarker> {
    let path = pico_shared::paths::thread_marker(root, thread_id);
    let text = match std::fs::read_to_string(&path) {
        Ok(text) => text,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return None,
        Err(e) => {
            tracing::warn!(%thread_id, error = %e, "thread marker unreadable; re-resolving from binding");
            return None;
        }
    };
    match parse(&text) {
        Some(marker) => Some(marker),
        None => {
            tracing::warn!(%thread_id, "thread marker invalid; re-resolving from binding");
            None
        }
    }
}

fn parse(text: &str) -> Option<ThreadMarker> {
    let raw: RawMarker = toml::from_str(text).ok()?;
    if !crate::bindings::is_valid_profile(&raw.profile) {
        return None;
    }
    let cwd = crate::bindings::expand_home(&raw.cwd);
    if !cwd.is_absolute() {
        return None;
    }
    let worktree = match (raw.base_repo, raw.default_branch) {
        (Some(base_repo), Some(default_branch)) => Some(WorktreeOrigin {
            base_repo: crate::bindings::expand_home(&base_repo),
            default_branch,
        }),
        (None, None) => None,
        // A half-written worktree origin can't recreate the cwd: self-heal.
        _ => return None,
    };
    Some(ThreadMarker {
        profile: raw.profile,
        cwd,
        worktree,
    })
}

/// Persist a thread's marker. Best-effort: a write failure logs and is retried on
/// the next turn rather than blocking it.
pub fn save(root: &Path, thread_id: &str, marker: &ThreadMarker) {
    if let Err(e) = write(root, thread_id, marker) {
        tracing::warn!(%thread_id, error = %format!("{e:#}"), "persisting thread marker failed");
    }
}

fn write(root: &Path, thread_id: &str, marker: &ThreadMarker) -> color_eyre::Result<()> {
    let raw = RawMarker {
        profile: marker.profile.clone(),
        cwd: marker.cwd.to_string_lossy().into_owned(),
        base_repo: marker
            .worktree
            .as_ref()
            .map(|w| w.base_repo.to_string_lossy().into_owned()),
        default_branch: marker.worktree.as_ref().map(|w| w.default_branch.clone()),
    };
    let text = toml::to_string(&raw).wrap_err("serializing thread marker")?;
    let path = pico_shared::paths::thread_marker(root, thread_id);
    let dir = path.parent().unwrap_or_else(|| Path::new("."));
    std::fs::create_dir_all(dir).wrap_err_with(|| format!("creating {}", dir.display()))?;

    // Atomic temp+rename so a concurrent reader never sees a torn file; the
    // per-write sequence keeps tmp names unique within the process.
    static SEQ: AtomicU64 = AtomicU64::new(0);
    let seq = SEQ.fetch_add(1, Ordering::Relaxed);
    let tmp = dir.join(format!(".{thread_id}.tmp.{}.{}", std::process::id(), seq));
    std::fs::write(&tmp, text).wrap_err_with(|| format!("writing {}", tmp.display()))?;
    std::fs::rename(&tmp, &path).wrap_err_with(|| format!("renaming {} -> {}", tmp.display(), path.display()))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::{
        path::{Path, PathBuf},
        sync::atomic::{AtomicU64, Ordering},
    };

    fn temp_root(tag: &str) -> PathBuf {
        static N: AtomicU64 = AtomicU64::new(0);
        let n = N.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("pico-marker-{}-{}-{}", tag, std::process::id(), n));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write_raw(root: &Path, thread_id: &str, body: &str) {
        let path = pico_shared::paths::thread_marker(root, thread_id);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, body).unwrap();
    }

    #[test]
    fn regular_marker_roundtrips() {
        let root = temp_root("reg");
        super::save(
            &root,
            "222222222222222222",
            &super::ThreadMarker {
                profile: "sen".into(),
                cwd: PathBuf::from("/work"),
                worktree: None,
            },
        );
        let m = super::load(&root, "222222222222222222").unwrap();
        assert_eq!(m.profile, "sen");
        assert_eq!(m.cwd, PathBuf::from("/work"));
        assert!(m.worktree.is_none());
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn worktree_marker_roundtrips() {
        let root = temp_root("wt");
        super::save(
            &root,
            "222222222222222222",
            &super::ThreadMarker {
                profile: "sen".into(),
                cwd: PathBuf::from("/wt/c/t"),
                worktree: Some(super::WorktreeOrigin {
                    base_repo: PathBuf::from("/repo"),
                    default_branch: "origin/main".into(),
                }),
            },
        );
        let wt = super::load(&root, "222222222222222222").unwrap().worktree.unwrap();
        assert_eq!(wt.base_repo, PathBuf::from("/repo"));
        assert_eq!(wt.default_branch, "origin/main");
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn absent_marker_is_none() {
        let root = temp_root("absent");
        assert!(super::load(&root, "222222222222222222").is_none());
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn corrupt_marker_self_heals_to_none() {
        let root = temp_root("corrupt");
        write_raw(&root, "222222222222222222", "this is not = valid toml [[[");
        assert!(super::load(&root, "222222222222222222").is_none());
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn invalid_profile_is_rejected() {
        let root = temp_root("badprofile");
        write_raw(&root, "222222222222222222", "profile = \"../escape\"\ncwd = \"/work\"\n");
        assert!(super::load(&root, "222222222222222222").is_none());
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn relative_cwd_is_rejected() {
        let root = temp_root("relcwd");
        write_raw(&root, "222222222222222222", "profile = \"sen\"\ncwd = \"relative/dir\"\n");
        assert!(super::load(&root, "222222222222222222").is_none());
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn half_worktree_origin_is_rejected() {
        let root = temp_root("halfwt");
        write_raw(
            &root,
            "222222222222222222",
            "profile = \"sen\"\ncwd = \"/wt/c/t\"\nbase_repo = \"/repo\"\n",
        );
        assert!(super::load(&root, "222222222222222222").is_none());
        std::fs::remove_dir_all(&root).ok();
    }
}
