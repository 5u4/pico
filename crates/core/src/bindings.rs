use std::path::{Path, PathBuf};

use color_eyre::eyre::WrapErr;
use sqlx::SqlitePool;

pub struct Binding {
    pub profile: String,
    pub kind: BindingKind,
}

pub enum BindingKind {
    Regular { cwd: PathBuf },
    Worktree { base_repo: PathBuf, default_branch: String },
}

pub const DEFAULT_BRANCH: &str = "origin/main";

type Row = (String, String, Option<String>, Option<String>, Option<String>);

pub async fn get(db: &SqlitePool, platform: &str, channel_id: &str) -> color_eyre::Result<Option<Binding>> {
    let row: Option<Row> = sqlx::query_as(
        "SELECT profile, kind, cwd, base_repo, default_branch FROM bindings WHERE platform = ? AND channel_id = ?",
    )
    .bind(platform)
    .bind(channel_id)
    .fetch_optional(db)
    .await
    .wrap_err("loading binding")?;
    let Some(row) = row else {
        return Ok(None);
    };
    let base = pico_shared::paths::pico_home()?;
    Ok(parse(row, &base))
}

fn parse((profile, kind, cwd, base_repo, default_branch): Row, base: &std::path::Path) -> Option<Binding> {
    if !pico_shared::validate::is_valid_profile(&profile) {
        return None;
    }
    let kind = match kind.as_str() {
        "regular" => BindingKind::Regular {
            cwd: pico_shared::paths::from_portable(&cwd?, base)?,
        },
        "worktree" => {
            let default_branch = default_branch.unwrap_or_else(|| DEFAULT_BRANCH.to_owned());
            if !pico_shared::validate::is_valid_branch(&default_branch) {
                return None;
            }
            BindingKind::Worktree {
                base_repo: pico_shared::paths::from_portable(&base_repo?, base)?,
                default_branch,
            }
        }
        _ => return None,
    };
    Some(Binding { profile, kind })
}

pub async fn set_regular(
    db: &SqlitePool,
    platform: &str,
    channel_id: &str,
    profile: &str,
    cwd: &Path,
) -> color_eyre::Result<()> {
    validate_profile(profile)?;
    let cwd = expand(cwd);
    validate_existing_dir("cwd", &cwd)?;
    let stored = pico_shared::paths::to_portable(&cwd, &pico_shared::paths::pico_home()?);
    upsert(db, platform, channel_id, profile, "regular", Some(stored), None, None).await
}

pub async fn set_worktree(
    db: &SqlitePool,
    platform: &str,
    channel_id: &str,
    profile: &str,
    base_repo: &Path,
    default_branch: &str,
) -> color_eyre::Result<()> {
    validate_profile(profile)?;
    let base_repo = expand(base_repo);
    validate_existing_dir("base_repo", &base_repo)?;
    validate_branch(default_branch)?;
    let stored = pico_shared::paths::to_portable(&base_repo, &pico_shared::paths::pico_home()?);
    upsert(
        db,
        platform,
        channel_id,
        profile,
        "worktree",
        None,
        Some(stored),
        Some(default_branch.to_owned()),
    )
    .await
}

pub async fn unset(db: &SqlitePool, platform: &str, channel_id: &str) -> color_eyre::Result<bool> {
    let result = sqlx::query("DELETE FROM bindings WHERE platform = ? AND channel_id = ?")
        .bind(platform)
        .bind(channel_id)
        .execute(db)
        .await
        .wrap_err("deleting binding")?;
    Ok(result.rows_affected() > 0)
}

#[allow(clippy::too_many_arguments)]
async fn upsert(
    db: &SqlitePool,
    platform: &str,
    channel_id: &str,
    profile: &str,
    kind: &str,
    cwd: Option<String>,
    base_repo: Option<String>,
    default_branch: Option<String>,
) -> color_eyre::Result<()> {
    sqlx::query(
        "INSERT INTO bindings (platform, channel_id, profile, kind, cwd, base_repo, default_branch) \
         VALUES (?, ?, ?, ?, ?, ?, ?) \
         ON CONFLICT(platform, channel_id) DO UPDATE SET \
         profile = excluded.profile, kind = excluded.kind, cwd = excluded.cwd, \
         base_repo = excluded.base_repo, default_branch = excluded.default_branch",
    )
    .bind(platform)
    .bind(channel_id)
    .bind(profile)
    .bind(kind)
    .bind(cwd)
    .bind(base_repo)
    .bind(default_branch)
    .execute(db)
    .await
    .wrap_err("upserting binding")?;
    Ok(())
}

fn expand(path: &Path) -> PathBuf {
    match path.to_str() {
        Some(s) => pico_shared::paths::expand_home(s),
        None => path.to_path_buf(),
    }
}

fn validate_profile(profile: &str) -> color_eyre::Result<()> {
    if !pico_shared::validate::is_valid_profile(profile) {
        return Err(color_eyre::eyre::eyre!(
            "invalid profile {profile:?} (must match ^[A-Za-z0-9_-]+$)"
        ));
    }
    Ok(())
}

fn validate_branch(branch: &str) -> color_eyre::Result<()> {
    if !pico_shared::validate::is_valid_branch(branch) {
        return Err(color_eyre::eyre::eyre!(
            "invalid branch {branch:?} (no leading '-', chars [A-Za-z0-9._/-], no \"..\")"
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

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicU64, Ordering};

    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        static SEQ: AtomicU64 = AtomicU64::new(0);
        let seq = SEQ.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("pico-bindings-{tag}-{}-{seq}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    async fn db(root: &Path) -> SqlitePool {
        crate::db::open(root).await.unwrap()
    }

    #[tokio::test]
    async fn regular_binding_roundtrips() {
        let root = temp_dir("regular");
        let pool = db(&root).await;
        let cwd = root.join("work");
        std::fs::create_dir_all(&cwd).unwrap();
        set_regular(&pool, "discord", "111", "default", &cwd).await.unwrap();
        let b = get(&pool, "discord", "111").await.unwrap().unwrap();
        assert_eq!(b.profile, "default");
        assert!(matches!(b.kind, BindingKind::Regular { cwd: c } if c == cwd));
        pool.close().await;
        std::fs::remove_dir_all(&root).ok();
    }

    #[tokio::test]
    async fn worktree_binding_roundtrips_and_defaults_branch() {
        let root = temp_dir("worktree");
        let pool = db(&root).await;
        let repo = root.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        set_worktree(&pool, "discord", "222", "dev", &repo, DEFAULT_BRANCH)
            .await
            .unwrap();
        let b = get(&pool, "discord", "222").await.unwrap().unwrap();
        assert_eq!(b.profile, "dev");
        assert!(
            matches!(b.kind, BindingKind::Worktree { base_repo, default_branch } if base_repo == repo && default_branch == DEFAULT_BRANCH)
        );
        pool.close().await;
        std::fs::remove_dir_all(&root).ok();
    }

    #[tokio::test]
    async fn unset_returns_true_then_false() {
        let root = temp_dir("unset");
        let pool = db(&root).await;
        let cwd = root.join("work");
        std::fs::create_dir_all(&cwd).unwrap();
        set_regular(&pool, "discord", "333", "default", &cwd).await.unwrap();
        assert!(unset(&pool, "discord", "333").await.unwrap());
        assert!(!unset(&pool, "discord", "333").await.unwrap());
        assert!(get(&pool, "discord", "333").await.unwrap().is_none());
        pool.close().await;
        std::fs::remove_dir_all(&root).ok();
    }

    #[tokio::test]
    async fn binding_is_isolated_per_platform() {
        let root = temp_dir("platform");
        let pool = db(&root).await;
        let cwd = root.join("work");
        std::fs::create_dir_all(&cwd).unwrap();
        set_regular(&pool, "discord", "444", "default", &cwd).await.unwrap();
        assert!(get(&pool, "slack", "444").await.unwrap().is_none());
        assert!(get(&pool, "discord", "444").await.unwrap().is_some());
        pool.close().await;
        std::fs::remove_dir_all(&root).ok();
    }

    #[tokio::test]
    async fn set_rejects_nonexistent_cwd_and_bad_profile() {
        let root = temp_dir("reject");
        let pool = db(&root).await;
        let missing = root.join("nope");
        assert!(set_regular(&pool, "discord", "555", "default", &missing).await.is_err());
        let cwd = root.join("work");
        std::fs::create_dir_all(&cwd).unwrap();
        assert!(set_regular(&pool, "discord", "555", "../evil", &cwd).await.is_err());
        pool.close().await;
        std::fs::remove_dir_all(&root).ok();
    }

    #[tokio::test]
    async fn tampered_parent_escape_cwd_is_rejected() {
        let root = temp_dir("escape");
        let pool = db(&root).await;
        sqlx::query("INSERT INTO bindings (platform, channel_id, profile, kind, cwd) VALUES ('discord', '999', 'default', 'regular', '../escape')")
            .execute(&pool)
            .await
            .unwrap();
        assert!(get(&pool, "discord", "999").await.unwrap().is_none());
        pool.close().await;
        std::fs::remove_dir_all(&root).ok();
    }
}
