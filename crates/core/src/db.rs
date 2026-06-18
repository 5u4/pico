//! Per-worker SQLite store: one `<root>/pico.db` holds every subsystem's durable
//! state (approvals now; scheduling / conversation to come) as separate tables —
//! a single transactional persistence layer, not per-subsystem file juggling.
//! Opened once at startup with WAL + embedded migrations.

use std::{path::Path, time::Duration};

use color_eyre::eyre::WrapErr;
use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions, SqliteSynchronous};

/// Open (creating if absent) the worker's SQLite pool and apply embedded
/// migrations. WAL + a busy timeout let concurrent turns share the one file.
pub async fn open(root: &Path) -> color_eyre::Result<sqlx::SqlitePool> {
    let options = SqliteConnectOptions::new()
        .filename(pico_shared::paths::worker_db(root))
        .create_if_missing(true)
        .journal_mode(SqliteJournalMode::Wal)
        .synchronous(SqliteSynchronous::Normal)
        .busy_timeout(Duration::from_secs(5))
        .foreign_keys(true);
    let pool = SqlitePoolOptions::new()
        .max_connections(5)
        .connect_with(options)
        .await
        .wrap_err("opening worker sqlite pool")?;
    sqlx::migrate!()
        .run(&pool)
        .await
        .wrap_err("applying sqlite migrations")?;
    Ok(pool)
}

#[cfg(test)]
mod tests {
    use std::{
        path::PathBuf,
        sync::atomic::{AtomicU64, Ordering},
    };

    fn temp_dir(tag: &str) -> PathBuf {
        static SEQ: AtomicU64 = AtomicU64::new(0);
        let seq = SEQ.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("pico-db-{tag}-{}-{seq}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[tokio::test]
    async fn open_creates_and_migrates_schema() {
        let root = temp_dir("open");
        let pool = super::open(&root).await.unwrap();
        let count: i64 = sqlx::query_scalar("SELECT count(*) FROM approvals")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(count, 0);
        pool.close().await;
        std::fs::remove_dir_all(&root).ok();
    }

    #[tokio::test]
    async fn open_is_idempotent_across_restarts() {
        let root = temp_dir("reopen");
        super::open(&root).await.unwrap().close().await;
        let pool = super::open(&root).await.unwrap();
        let count: i64 = sqlx::query_scalar("SELECT count(*) FROM approvals")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(count, 0);
        pool.close().await;
        std::fs::remove_dir_all(&root).ok();
    }
}
