use color_eyre::eyre::WrapErr;
use sqlx::SqlitePool;

#[derive(Debug, Clone)]
pub struct Channel {
    pub channel_id: String,
    pub label: String,
    pub created_at: i64,
}

pub async fn ensure(db: &SqlitePool, platform: &str, channel_id: &str, label: &str, created_at: i64) {
    if let Err(e) = insert(db, platform, channel_id, label, created_at, false).await {
        tracing::warn!(%channel_id, error = %format!("{e:#}"), "ensuring channel failed");
    }
}

pub async fn create(
    db: &SqlitePool,
    platform: &str,
    channel_id: &str,
    label: &str,
    created_at: i64,
) -> color_eyre::Result<()> {
    insert(db, platform, channel_id, label, created_at, true).await
}

async fn insert(
    db: &SqlitePool,
    platform: &str,
    channel_id: &str,
    label: &str,
    created_at: i64,
    replace_label: bool,
) -> color_eyre::Result<()> {
    let sql = if replace_label {
        "INSERT INTO channels (platform, channel_id, label, created_at) VALUES (?, ?, ?, ?) \
         ON CONFLICT(platform, channel_id) DO UPDATE SET label = excluded.label"
    } else {
        "INSERT INTO channels (platform, channel_id, label, created_at) VALUES (?, ?, ?, ?) \
         ON CONFLICT(platform, channel_id) DO NOTHING"
    };
    sqlx::query(sql)
        .bind(platform)
        .bind(channel_id)
        .bind(label)
        .bind(created_at)
        .execute(db)
        .await
        .wrap_err("writing channel")?;
    Ok(())
}

pub async fn list(db: &SqlitePool, platform: &str) -> Vec<Channel> {
    match list_rows(db, platform).await {
        Ok(rows) => rows,
        Err(e) => {
            tracing::warn!(error = %format!("{e:#}"), "listing channels failed");
            Vec::new()
        }
    }
}

pub async fn exists(db: &SqlitePool, platform: &str, channel_id: &str) -> bool {
    let found = sqlx::query_scalar::<_, i64>("SELECT 1 FROM channels WHERE platform = ? AND channel_id = ? LIMIT 1")
        .bind(platform)
        .bind(channel_id)
        .fetch_optional(db)
        .await;
    match found {
        Ok(row) => row.is_some(),
        Err(e) => {
            tracing::warn!(%channel_id, error = %format!("{e:#}"), "checking channel existence failed");
            false
        }
    }
}

async fn list_rows(db: &SqlitePool, platform: &str) -> color_eyre::Result<Vec<Channel>> {
    let rows = sqlx::query_as::<_, (String, String, i64)>(
        "SELECT channel_id, label, created_at FROM channels WHERE platform = ? ORDER BY created_at ASC",
    )
    .bind(platform)
    .fetch_all(db)
    .await
    .wrap_err("listing channels")?;
    Ok(rows
        .into_iter()
        .map(|(channel_id, label, created_at)| Channel {
            channel_id,
            label,
            created_at,
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn pool() -> SqlitePool {
        let pool = SqlitePool::connect("sqlite::memory:").await.unwrap();
        sqlx::query(
            "CREATE TABLE channels (platform TEXT NOT NULL, channel_id TEXT NOT NULL, \
             label TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (platform, channel_id))",
        )
        .execute(&pool)
        .await
        .unwrap();
        pool
    }

    #[tokio::test]
    async fn create_then_list_returns_channel() {
        let db = pool().await;
        create(&db, "web", "c1", "work", 10).await.unwrap();
        let list = list(&db, "web").await;
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].channel_id, "c1");
        assert_eq!(list[0].label, "work");
    }

    #[tokio::test]
    async fn exists_reflects_presence() {
        let db = pool().await;
        assert!(!exists(&db, "web", "c1").await);
        create(&db, "web", "c1", "work", 10).await.unwrap();
        assert!(exists(&db, "web", "c1").await);
        assert!(!exists(&db, "discord", "c1").await);
    }

    #[tokio::test]
    async fn ensure_is_idempotent_and_keeps_label() {
        let db = pool().await;
        ensure(&db, "web", "c1", "first", 10).await;
        ensure(&db, "web", "c1", "second", 20).await;
        let list = list(&db, "web").await;
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].label, "first");
        assert_eq!(list[0].created_at, 10);
    }

    #[tokio::test]
    async fn create_replaces_label_on_conflict() {
        let db = pool().await;
        ensure(&db, "web", "c1", "first", 10).await;
        create(&db, "web", "c1", "renamed", 20).await.unwrap();
        let list = list(&db, "web").await;
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].label, "renamed");
        assert_eq!(list[0].created_at, 10);
    }

    #[tokio::test]
    async fn list_orders_by_created_at() {
        let db = pool().await;
        create(&db, "web", "b", "b", 30).await.unwrap();
        create(&db, "web", "a", "a", 10).await.unwrap();
        create(&db, "web", "c", "c", 20).await.unwrap();
        let list = list(&db, "web").await;
        let ids: Vec<_> = list.iter().map(|c| c.channel_id.as_str()).collect();
        assert_eq!(ids, ["a", "c", "b"]);
    }

    #[tokio::test]
    async fn list_scoped_by_platform() {
        let db = pool().await;
        create(&db, "web", "c1", "w", 10).await.unwrap();
        create(&db, "discord", "c2", "d", 10).await.unwrap();
        assert_eq!(list(&db, "web").await.len(), 1);
        assert_eq!(list(&db, "discord").await.len(), 1);
    }
}
