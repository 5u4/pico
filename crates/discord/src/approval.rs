use std::time::Duration;

use color_eyre::eyre::WrapErr;
use poise::serenity_prelude as serenity;
use sqlx::SqlitePool;
use tokio_util::sync::CancellationToken;

const APPROVE_ID: &str = "approval:approve";
const DENY_ID: &str = "approval:deny";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Outcome {
    Approved,
    Denied,
    Expired,
    Aborted,
    NoApprovers,
}

impl Outcome {
    pub fn approved(self) -> bool {
        matches!(self, Outcome::Approved)
    }
}

pub struct Subject<'a> {
    pub kind: &'a str,
    pub title: &'a str,
    pub detail: &'a str,
    pub channel: serenity::ChannelId,
    pub guild_id: Option<serenity::GuildId>,
    pub requested_by: Option<serenity::UserId>,
}

pub fn parse_approvers(ids: &[String]) -> Vec<serenity::UserId> {
    ids.iter()
        .filter_map(|id| match id.parse::<u64>() {
            Ok(n) => Some(serenity::UserId::new(n)),
            Err(e) => {
                tracing::warn!(%id, error = %format!("{e:#}"), "skipping unparseable approver id");
                None
            }
        })
        .collect()
}

pub async fn request(
    db: &SqlitePool,
    ctx: &serenity::Context,
    approvers: &[serenity::UserId],
    timeout: Duration,
    cancel: &CancellationToken,
    subject: Subject<'_>,
) -> color_eyre::Result<Outcome> {
    if approvers.is_empty() {
        tracing::warn!(
            kind = subject.kind,
            "approval requested but no approvers configured; failing closed"
        );
        return Ok(Outcome::NoApprovers);
    }

    let id = ulid::Ulid::new().to_string();
    insert_pending(db, &id, &subject, &now())
        .await
        .wrap_err("persisting pending approval")?;

    let msg = match subject.channel.send_message(ctx, prompt_message(&subject)).await {
        Ok(msg) => msg,
        Err(e) => {
            let _ = resolve(db, &id, "aborted", None, &now()).await;
            return Err(e).wrap_err("posting approval prompt");
        }
    };
    if let Err(e) = set_message_id(db, &id, &msg.id.get().to_string()).await {
        tracing::warn!(%id, error = %format!("{e:#}"), "recording approval message id failed");
    }

    let allowed = approvers.to_vec();
    let collector = serenity::ComponentInteractionCollector::new(ctx)
        .message_id(msg.id)
        .timeout(timeout)
        .filter(move |i| allowed.contains(&i.user.id));

    let picked = tokio::select! {
        () = cancel.cancelled() => return Ok(Outcome::Aborted),
        picked = collector.next() => picked,
    };

    match picked {
        Some(interaction) => {
            let approved = interaction.data.custom_id == APPROVE_ID;
            let who = interaction.user.id;
            let (status, outcome, line) = if approved {
                ("approved", Outcome::Approved, format!("✅ Approved by <@{}>", who.get()))
            } else {
                ("denied", Outcome::Denied, format!("🚫 Denied by <@{}>", who.get()))
            };
            ack_update(ctx, &interaction, &resolved_line(&subject, &line)).await;
            if let Err(e) = resolve(db, &id, status, Some(&who.get().to_string()), &now()).await {
                tracing::warn!(%id, error = %format!("{e:#}"), "persisting approval outcome failed");
            }
            Ok(outcome)
        }
        None => {
            finalize(
                ctx,
                subject.channel,
                msg.id,
                &resolved_line(&subject, "⌛ Expired — no decision in time"),
            )
            .await;
            if let Err(e) = resolve(db, &id, "expired", None, &now()).await {
                tracing::warn!(%id, error = %format!("{e:#}"), "persisting approval expiry failed");
            }
            Ok(Outcome::Expired)
        }
    }
}

pub(crate) async fn reconcile_pending_aborted(db: &SqlitePool) -> color_eyre::Result<u64> {
    let result = sqlx::query("UPDATE approvals SET status = 'aborted', resolved_at = ? WHERE status = 'pending'")
        .bind(now())
        .execute(db)
        .await
        .wrap_err("reconciling pending approvals")?;
    Ok(result.rows_affected())
}

fn now() -> String {
    serenity::Timestamp::now().to_string()
}

async fn insert_pending(db: &SqlitePool, id: &str, subject: &Subject<'_>, created_at: &str) -> color_eyre::Result<()> {
    sqlx::query(
        "INSERT INTO approvals (id, kind, title, detail, status, created_at, channel_id, guild_id, requested_by) \
         VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?)",
    )
    .bind(id)
    .bind(subject.kind)
    .bind(subject.title)
    .bind(subject.detail)
    .bind(created_at)
    .bind(subject.channel.get().to_string())
    .bind(subject.guild_id.map(|g| g.get().to_string()))
    .bind(subject.requested_by.map(|u| u.get().to_string()))
    .execute(db)
    .await
    .wrap_err("inserting approval row")?;
    Ok(())
}

async fn set_message_id(db: &SqlitePool, id: &str, message_id: &str) -> color_eyre::Result<()> {
    sqlx::query("UPDATE approvals SET message_id = ? WHERE id = ?")
        .bind(message_id)
        .bind(id)
        .execute(db)
        .await
        .wrap_err("recording approval message id")?;
    Ok(())
}

async fn resolve(
    db: &SqlitePool,
    id: &str,
    status: &str,
    resolver: Option<&str>,
    resolved_at: &str,
) -> color_eyre::Result<()> {
    sqlx::query("UPDATE approvals SET status = ?, resolver = ?, resolved_at = ? WHERE id = ?")
        .bind(status)
        .bind(resolver)
        .bind(resolved_at)
        .bind(id)
        .execute(db)
        .await
        .wrap_err("updating approval status")?;
    Ok(())
}

fn prompt_message(subject: &Subject<'_>) -> serenity::CreateMessage {
    serenity::CreateMessage::new()
        .content(prompt_content(subject))
        .components(vec![serenity::CreateActionRow::Buttons(vec![
            serenity::CreateButton::new(APPROVE_ID)
                .label("Approve")
                .style(serenity::ButtonStyle::Success),
            serenity::CreateButton::new(DENY_ID)
                .label("Deny")
                .style(serenity::ButtonStyle::Danger),
        ])])
}

fn prompt_content(subject: &Subject<'_>) -> String {
    let body = format!("🔐 **Approval required — {}**\n\n{}", subject.title, subject.detail);
    clamp(&body)
}

fn resolved_line(subject: &Subject<'_>, outcome: &str) -> String {
    let title = pico_core::render::defang_mentions(subject.title);
    pico_core::render::truncate(&format!("🔐 **{title}**\n{outcome}"), crate::consts::MSG_CONTENT_CAP)
}

fn clamp(text: &str) -> String {
    pico_core::render::truncate(&pico_core::render::defang_mentions(text), crate::consts::MSG_CONTENT_CAP)
}

async fn ack_update(ctx: &serenity::Context, interaction: &serenity::ComponentInteraction, content: &str) {
    let response = serenity::CreateInteractionResponse::UpdateMessage(
        serenity::CreateInteractionResponseMessage::new()
            .content(content.to_owned())
            .components(vec![]),
    );
    if let Err(e) = interaction.create_response(ctx, response).await {
        tracing::warn!(error = %format!("{e:#}"), "approval interaction update failed");
    }
}

async fn finalize(
    ctx: &serenity::Context,
    channel: serenity::ChannelId,
    message_id: serenity::MessageId,
    content: &str,
) {
    let edit = serenity::EditMessage::new()
        .content(content.to_owned())
        .components(vec![]);
    if let Err(e) = channel.edit_message(ctx, message_id, edit).await {
        tracing::warn!(error = %format!("{e:#}"), "approval prompt finalize failed");
    }
}

#[cfg(test)]
mod tests {
    use std::{
        path::PathBuf,
        sync::atomic::{AtomicU64, Ordering},
    };

    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        static SEQ: AtomicU64 = AtomicU64::new(0);
        let seq = SEQ.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("pico-approval-{tag}-{}-{seq}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    async fn test_pool(tag: &str) -> (SqlitePool, PathBuf) {
        let dir = temp_dir(tag);
        let pool = pico_core::db::open(&dir).await.unwrap();
        (pool, dir)
    }

    fn subject(channel: u64) -> Subject<'static> {
        Subject {
            kind: "test",
            title: "t",
            detail: "d",
            channel: serenity::ChannelId::new(channel),
            guild_id: None,
            requested_by: None,
        }
    }

    async fn status_of(db: &SqlitePool, id: &str) -> String {
        sqlx::query_scalar::<_, String>("SELECT status FROM approvals WHERE id = ?")
            .bind(id)
            .fetch_one(db)
            .await
            .unwrap()
    }

    #[tokio::test]
    async fn insert_pending_then_resolve_persists_outcome() {
        let (pool, dir) = test_pool("resolve").await;
        let mut subj = subject(1);
        subj.guild_id = Some(serenity::GuildId::new(99));
        insert_pending(&pool, "01AAA", &subj, "2026-01-01T00:00:00Z")
            .await
            .unwrap();
        resolve(&pool, "01AAA", "approved", Some("42"), "2026-01-01T00:01:00Z")
            .await
            .unwrap();

        let (status, resolver, guild): (String, Option<String>, Option<String>) =
            sqlx::query_as("SELECT status, resolver, guild_id FROM approvals WHERE id = ?")
                .bind("01AAA")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(status, "approved");
        assert_eq!(resolver.as_deref(), Some("42"));
        assert_eq!(guild.as_deref(), Some("99"));
        pool.close().await;
        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn reconcile_settles_only_pending_and_is_idempotent() {
        let (pool, dir) = test_pool("reconcile").await;
        insert_pending(&pool, "01A", &subject(1), "t").await.unwrap();
        insert_pending(&pool, "01B", &subject(2), "t").await.unwrap();
        resolve(&pool, "01B", "approved", Some("7"), "t").await.unwrap();
        insert_pending(&pool, "01C", &subject(3), "t").await.unwrap();

        assert_eq!(reconcile_pending_aborted(&pool).await.unwrap(), 2);
        assert_eq!(status_of(&pool, "01A").await, "aborted");
        assert_eq!(status_of(&pool, "01B").await, "approved", "a resolved row is left untouched");
        assert_eq!(status_of(&pool, "01C").await, "aborted");

        assert_eq!(reconcile_pending_aborted(&pool).await.unwrap(), 0);
        pool.close().await;
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn parse_approvers_maps_ids_and_drops_garbage() {
        let ids = vec!["123".to_owned(), "not-a-number".to_owned(), "456".to_owned()];
        let parsed = parse_approvers(&ids);
        assert_eq!(parsed, vec![serenity::UserId::new(123), serenity::UserId::new(456)]);
    }

    #[test]
    fn outcome_only_approved_proceeds() {
        assert!(Outcome::Approved.approved());
        for o in [
            Outcome::Denied,
            Outcome::Expired,
            Outcome::Aborted,
            Outcome::NoApprovers,
        ] {
            assert!(!o.approved());
        }
    }
}
