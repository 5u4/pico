use std::path::PathBuf;

use color_eyre::eyre::WrapErr;
use sqlx::SqlitePool;

pub struct ThreadMarker {
    pub profile: String,
    pub cwd: PathBuf,
    pub worktree: Option<WorktreeOrigin>,
    pub closed_at: Option<String>,
}

#[derive(Clone)]
pub struct WorktreeOrigin {
    pub base_repo: PathBuf,
    pub default_branch: String,
}

type Columns = (String, String, Option<String>, Option<String>, Option<String>);

pub async fn load(db: &SqlitePool, platform: &str, thread_id: &str) -> Option<ThreadMarker> {
    let row = match fetch(db, platform, thread_id).await {
        Ok(row) => row?,
        Err(e) => {
            tracing::warn!(%thread_id, error = %format!("{e:#}"), "thread marker unreadable; re-resolving from binding");
            return None;
        }
    };
    match parse(row) {
        Some(marker) => Some(marker),
        None => {
            tracing::warn!(%thread_id, "thread marker invalid; re-resolving from binding");
            None
        }
    }
}

async fn fetch(db: &SqlitePool, platform: &str, thread_id: &str) -> color_eyre::Result<Option<Columns>> {
    sqlx::query_as::<_, Columns>(
        "SELECT profile, cwd, base_repo, default_branch, closed_at FROM threads WHERE platform = ? AND thread_id = ?",
    )
    .bind(platform)
    .bind(thread_id)
    .fetch_optional(db)
    .await
    .wrap_err("loading thread marker")
}

fn parse((profile, cwd, base_repo, default_branch, closed_at): Columns) -> Option<ThreadMarker> {
    if !pico_shared::validate::is_valid_profile(&profile) {
        return None;
    }
    let base = pico_shared::paths::pico_home().ok()?;
    let cwd = pico_shared::paths::from_portable(&cwd, &base)?;
    let worktree = match (base_repo, default_branch) {
        (Some(base_repo), Some(default_branch)) => {
            if !pico_shared::validate::is_valid_branch(&default_branch) {
                return None;
            }
            let base_repo = pico_shared::paths::from_portable(&base_repo, &base)?;
            Some(WorktreeOrigin {
                base_repo,
                default_branch,
            })
        }
        (None, None) => None,
        _ => return None,
    };
    Some(ThreadMarker {
        profile,
        cwd,
        worktree,
        closed_at,
    })
}

pub async fn save(db: &SqlitePool, platform: &str, thread_id: &str, marker: &ThreadMarker) {
    if let Err(e) = write(db, platform, thread_id, marker).await {
        tracing::warn!(%thread_id, error = %format!("{e:#}"), "persisting thread marker failed");
    }
}

async fn write(db: &SqlitePool, platform: &str, thread_id: &str, marker: &ThreadMarker) -> color_eyre::Result<()> {
    let base = pico_shared::paths::pico_home()?;
    let cwd = pico_shared::paths::to_portable(&marker.cwd, &base);
    let base_repo = marker
        .worktree
        .as_ref()
        .map(|w| pico_shared::paths::to_portable(&w.base_repo, &base));
    let default_branch = marker.worktree.as_ref().map(|w| w.default_branch.clone());
    sqlx::query(
        "INSERT INTO threads (platform, thread_id, profile, cwd, base_repo, default_branch, closed_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?) \
         ON CONFLICT(platform, thread_id) DO UPDATE SET \
             profile = excluded.profile, \
             cwd = excluded.cwd, \
             base_repo = excluded.base_repo, \
             default_branch = excluded.default_branch, \
             closed_at = excluded.closed_at",
    )
    .bind(platform)
    .bind(thread_id)
    .bind(&marker.profile)
    .bind(cwd)
    .bind(base_repo)
    .bind(default_branch)
    .bind(marker.closed_at.clone())
    .execute(db)
    .await
    .wrap_err("writing thread marker")?;
    Ok(())
}

pub async fn tombstone(
    db: &SqlitePool,
    platform: &str,
    thread_id: &str,
    marker: ThreadMarker,
    closed_at: String,
) -> color_eyre::Result<()> {
    let marker = ThreadMarker {
        closed_at: Some(closed_at),
        ..marker
    };
    write(db, platform, thread_id, &marker).await
}

#[cfg(test)]
mod tests {
    use std::{
        path::PathBuf,
        sync::atomic::{AtomicU64, Ordering},
    };

    use sqlx::SqlitePool;

    fn temp_root(tag: &str) -> PathBuf {
        static N: AtomicU64 = AtomicU64::new(0);
        let n = N.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("pico-marker-{}-{}-{}", tag, std::process::id(), n));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    async fn test_pool(tag: &str) -> (SqlitePool, PathBuf) {
        let dir = temp_root(tag);
        let pool = crate::db::open(&dir).await.unwrap();
        (pool, dir)
    }

    async fn insert_raw(
        db: &SqlitePool,
        thread_id: &str,
        profile: &str,
        cwd: &str,
        base_repo: Option<&str>,
        default_branch: Option<&str>,
    ) {
        sqlx::query(
            "INSERT INTO threads (platform, thread_id, profile, cwd, base_repo, default_branch) VALUES (?, ?, ?, ?, ?, ?)",
        )
            .bind("discord")
            .bind(thread_id)
            .bind(profile)
            .bind(cwd)
            .bind(base_repo)
            .bind(default_branch)
            .execute(db)
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn regular_marker_roundtrips() {
        let (db, dir) = test_pool("reg").await;
        super::save(
            &db,
            "discord",
            "222222222222222222",
            &super::ThreadMarker {
                profile: "sen".into(),
                cwd: PathBuf::from("/work"),
                worktree: None,
                closed_at: None,
            },
        )
        .await;
        let m = super::load(&db, "discord", "222222222222222222").await.unwrap();
        assert_eq!(m.profile, "sen");
        assert_eq!(m.cwd, PathBuf::from("/work"));
        assert!(m.worktree.is_none());
        db.close().await;
        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn save_overwrites_existing_marker() {
        let (db, dir) = test_pool("overwrite").await;
        let save = |profile: &'static str, cwd: &'static str| {
            let db = db.clone();
            async move {
                super::save(
                    &db,
                    "discord",
                    "222222222222222222",
                    &super::ThreadMarker {
                        profile: profile.into(),
                        cwd: PathBuf::from(cwd),
                        worktree: None,
                        closed_at: None,
                    },
                )
                .await;
            }
        };
        save("sen", "/work").await;
        save("dev", "/elsewhere").await;
        let m = super::load(&db, "discord", "222222222222222222").await.unwrap();
        assert_eq!(m.profile, "dev");
        assert_eq!(m.cwd, PathBuf::from("/elsewhere"));
        db.close().await;
        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn save_clears_origin_on_worktree_to_regular() {
        let (db, dir) = test_pool("wt2reg").await;
        super::save(
            &db,
            "discord",
            "222222222222222222",
            &super::ThreadMarker {
                profile: "sen".into(),
                cwd: PathBuf::from("/wt/c/t"),
                worktree: Some(super::WorktreeOrigin {
                    base_repo: PathBuf::from("/repo"),
                    default_branch: "origin/main".into(),
                }),
                closed_at: Some("2026-06-17T00:00:00Z".into()),
            },
        )
        .await;
        super::save(
            &db,
            "discord",
            "222222222222222222",
            &super::ThreadMarker {
                profile: "dev".into(),
                cwd: PathBuf::from("/work"),
                worktree: None,
                closed_at: None,
            },
        )
        .await;
        let m = super::load(&db, "discord", "222222222222222222").await.unwrap();
        assert_eq!(m.profile, "dev");
        assert_eq!(m.cwd, PathBuf::from("/work"));
        assert!(m.worktree.is_none());
        assert!(m.closed_at.is_none());
        db.close().await;
        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn worktree_marker_roundtrips() {
        let (db, dir) = test_pool("wt").await;
        super::save(
            &db,
            "discord",
            "222222222222222222",
            &super::ThreadMarker {
                profile: "sen".into(),
                cwd: PathBuf::from("/wt/c/t"),
                worktree: Some(super::WorktreeOrigin {
                    base_repo: PathBuf::from("/repo"),
                    default_branch: "origin/main".into(),
                }),
                closed_at: None,
            },
        )
        .await;
        let wt = super::load(&db, "discord", "222222222222222222")
            .await
            .unwrap()
            .worktree
            .unwrap();
        assert_eq!(wt.base_repo, PathBuf::from("/repo"));
        assert_eq!(wt.default_branch, "origin/main");
        db.close().await;
        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn absent_marker_is_none() {
        let (db, dir) = test_pool("absent").await;
        assert!(super::load(&db, "discord", "222222222222222222").await.is_none());
        db.close().await;
        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn invalid_profile_is_rejected() {
        let (db, dir) = test_pool("badprofile").await;
        insert_raw(&db, "222222222222222222", "../escape", "/work", None, None).await;
        assert!(super::load(&db, "discord", "222222222222222222").await.is_none());
        db.close().await;
        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn relative_cwd_resolves_against_root() {
        let (db, dir) = test_pool("relcwd").await;
        insert_raw(&db, "222222222222222222", "sen", "worker/x", None, None).await;
        let base = pico_shared::paths::pico_home().unwrap();
        let m = super::load(&db, "discord", "222222222222222222").await.unwrap();
        assert_eq!(m.cwd, base.join("worker/x"));
        db.close().await;
        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn half_worktree_origin_is_rejected() {
        let (db, dir) = test_pool("halfwt").await;
        insert_raw(&db, "222222222222222222", "sen", "/wt/c/t", Some("/repo"), None).await;
        assert!(super::load(&db, "discord", "222222222222222222").await.is_none());
        db.close().await;
        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn tampered_worktree_branch_is_rejected() {
        let (db, dir) = test_pool("tampwt").await;
        insert_raw(
            &db,
            "222222222222222222",
            "sen",
            "/wt/c/t",
            Some("/repo"),
            Some("--upload-pack=x"),
        )
        .await;
        assert!(super::load(&db, "discord", "222222222222222222").await.is_none());
        db.close().await;
        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn tombstone_sets_closed_at_and_keeps_origin() {
        let (db, dir) = test_pool("tomb").await;
        super::save(
            &db,
            "discord",
            "222222222222222222",
            &super::ThreadMarker {
                profile: "sen".into(),
                cwd: PathBuf::from("/wt/c/t"),
                worktree: Some(super::WorktreeOrigin {
                    base_repo: PathBuf::from("/repo"),
                    default_branch: "origin/main".into(),
                }),
                closed_at: None,
            },
        )
        .await;
        let marker = super::load(&db, "discord", "222222222222222222").await.unwrap();
        assert!(marker.closed_at.is_none());
        super::tombstone(&db, "discord", "222222222222222222", marker, "2026-06-17T00:00:00Z".into())
            .await
            .unwrap();
        let reloaded = super::load(&db, "discord", "222222222222222222").await.unwrap();
        assert_eq!(reloaded.closed_at.as_deref(), Some("2026-06-17T00:00:00Z"));
        let wt = reloaded.worktree.unwrap();
        assert_eq!(wt.base_repo, PathBuf::from("/repo"));
        assert_eq!(wt.default_branch, "origin/main");
        db.close().await;
        std::fs::remove_dir_all(&dir).ok();
    }
}
