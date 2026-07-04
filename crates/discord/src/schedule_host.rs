use std::{
    path::{Path, PathBuf},
    sync::Arc,
};

use color_eyre::eyre::eyre;
use pico_core::{
    bindings::{Route, resolve_route},
    cancel::CancelRegistry,
    config::{Render, StreamingBehavior},
    mid_turn::MidTurnQueue,
    omp::{camofox::CamofoxDaemon, pool::OmpPool},
    schedule::{DisableReason, FireOutcome, HomeNotice, Mode, Schedule, ScheduleHost},
    surface::ConversationId,
    thread_marker::{ThreadMarker, WorktreeOrigin},
};
use poise::serenity_prelude as serenity;
use tokio_util::sync::CancellationToken;

use crate::discord::{TurnInputs, channel_display_name, drive_thread_turn};

const UNKNOWN_CHANNEL: isize = 10003;

const MISSING_ACCESS: isize = 50001;

const MISSING_PERMISSIONS: isize = 50013;

pub(crate) struct DiscordScheduleHost {
    pub(crate) ctx: serenity::Context,
    pub(crate) db: sqlx::SqlitePool,
    pub(crate) pool: Arc<OmpPool>,
    pub(crate) camofox: Arc<CamofoxDaemon>,
    pub(crate) mid_turn: MidTurnQueue,
    pub(crate) cancels: CancelRegistry,
    pub(crate) pending_answers: crate::ui::PendingAnswers,
    pub(crate) root: Arc<PathBuf>,
    pub(crate) cancel: CancellationToken,
}

impl DiscordScheduleHost {
    fn load_config(&self) -> Option<crate::config::DiscordConfig> {
        match crate::config::load(&pico_shared::paths::discord_config(&self.root)) {
            Ok(config) => Some(config),
            Err(e) => {
                tracing::warn!(error = %format!("{e:#}"), "loading discord config for schedule failed");
                None
            }
        }
    }

    fn render(&self) -> Render {
        self.load_config().map(|c| c.render()).unwrap_or_else(default_render)
    }

    fn timezone(&self) -> chrono_tz::Tz {
        match pico_core::config::load_root(&pico_shared::paths::worker_config(&self.root)) {
            Ok(root_config) => root_config.timezone(),
            Err(e) => {
                tracing::warn!(error = %format!("{e:#}"), "loading worker config for schedule timezone failed");
                chrono_tz::UTC
            }
        }
    }

    fn worktrees_dir(&self) -> PathBuf {
        match pico_core::config::load_root(&pico_shared::paths::worker_config(&self.root)) {
            Ok(root_config) => root_config
                .worktrees_dir()
                .map(Path::to_path_buf)
                .unwrap_or_else(|| pico_shared::paths::default_worktrees_dir(&self.root)),
            Err(_) => pico_shared::paths::default_worktrees_dir(&self.root),
        }
    }

    async fn create_thread(
        &self,
        channel: serenity::ChannelId,
        name: &str,
    ) -> Result<serenity::GuildChannel, serenity::Error> {
        channel
            .create_thread(
                &self.ctx,
                serenity::CreateThread::new(fresh_thread_label(name)).kind(serenity::ChannelType::PublicThread),
            )
            .await
            .inspect_err(|e| {
                tracing::warn!(error = %format!("{e:#}"), %channel, "creating scheduled thread failed");
            })
    }

    async fn send_chunks(&self, channel: serenity::ChannelId, sched: &Schedule, chunks: Vec<String>) -> FireOutcome {
        for chunk in chunks {
            match channel.say(&self.ctx, chunk).await {
                Ok(_) => {}
                Err(e) if is_permanent_target_error(&e) => return FireOutcome::TargetGone,
                Err(e) => {
                    tracing::warn!(error = %format!("{e:#}"), schedule_id = %sched.id, "scheduled raw post failed");
                    return FireOutcome::Transient;
                }
            }
        }
        FireOutcome::Delivered
    }

    async fn fire_continue(&self, sched: &Schedule, wrapped: &str) -> FireOutcome {
        let Some(origin) = parse_channel(&sched.origin) else {
            return FireOutcome::TargetGone;
        };
        let Some(marker) = pico_core::thread_marker::load(&self.db, crate::consts::PLATFORM, &sched.origin)
            .await
            .filter(|m| m.closed_at.is_none())
        else {
            return FireOutcome::TargetGone;
        };

        let conversation = ConversationId::new(crate::consts::PLATFORM, &sched.origin);
        if self
            .mid_turn
            .deliver(&conversation, wrapped, Some(StreamingBehavior::Queue))
            .is_some()
        {
            return FireOutcome::Delivered;
        }

        let channel = match origin.to_channel(&self.ctx).await {
            Ok(serenity::Channel::Guild(channel)) => Some(channel),
            Ok(_) => return FireOutcome::TargetGone,
            Err(e) if is_unknown_channel(&e) => return FireOutcome::TargetGone,
            Err(e) => {
                tracing::warn!(error = %format!("{e:#}"), schedule_id = %sched.id, "resolving origin thread failed");
                None
            }
        };

        if let Some(wt) = &marker.worktree
            && let Err(e) = pico_core::worktree::ensure_at(
                &marker.cwd,
                &sched.origin,
                &wt.branch_prefix,
                &wt.base_repo,
                &wt.default_branch,
            )
            .await
        {
            tracing::warn!(error = %format!("{e:#}"), schedule_id = %sched.id, "scheduled worktree setup failed");
            return FireOutcome::Transient;
        }

        let guild_id = parse_guild(&sched.scope)
            .or_else(|| channel.as_ref().map(|c| c.guild_id))
            .unwrap_or_else(|| serenity::GuildId::new(1));
        let bound_channel = channel.as_ref().and_then(|c| c.parent_id).unwrap_or(origin);
        let channel_name = channel
            .as_ref()
            .and_then(|c| c.parent_id)
            .and_then(|parent| channel_display_name(&self.ctx, guild_id, parent));
        let thread_label = channel
            .as_ref()
            .map(|c| c.name.clone())
            .unwrap_or_else(|| sched.name.clone());

        let inputs = TurnInputs {
            thread_id: sched.origin.clone(),
            target: origin,
            profile: marker.profile.clone(),
            cwd: marker.cwd.clone(),
            worktree_origin: marker.worktree.clone(),
            wrapped,
            images: &[],
            trigger: None,
            author: parse_user(&sched.created_by).unwrap_or_else(|| serenity::UserId::new(1)),
            guild_id,
            guild_name: guild_id.name(&self.ctx.cache),
            bound_channel,
            channel_name,
            thread_label,
            render: self.render(),
            timezone: self.timezone(),
        };
        self.drive(inputs).await;
        FireOutcome::Delivered
    }

    async fn fire_fresh(&self, sched: &Schedule, wrapped: &str) -> FireOutcome {
        let Some(target_channel) = parse_channel(&sched.target) else {
            return FireOutcome::TargetGone;
        };
        let Some(config) = self.load_config() else {
            return FireOutcome::Transient;
        };
        let Some(guild_default) = config.guild(&sched.scope) else {
            return FireOutcome::Transient;
        };
        let binding = match pico_core::bindings::get(&self.db, crate::consts::PLATFORM, &sched.target).await {
            Ok(binding) => binding,
            Err(e) => {
                tracing::warn!(error = %format!("{e:#}"), schedule_id = %sched.id, "resolving fresh target binding failed");
                return FireOutcome::Transient;
            }
        };
        let route = resolve_route(binding.as_ref(), &guild_default.profile, &guild_default.cwd);

        let thread = match self.create_thread(target_channel, &sched.name).await {
            Ok(thread) => thread,
            Err(e) => {
                return if is_permanent_target_error(&e) {
                    FireOutcome::TargetGone
                } else {
                    FireOutcome::Transient
                };
            }
        };
        let thread_id = thread.id.to_string();

        let (profile, cwd, worktree_origin) = match route {
            Route::Regular { profile, cwd } => (profile, cwd, None),
            Route::Worktree {
                profile,
                base_repo,
                default_branch,
                branch_prefix,
            } => {
                let worktrees_dir = self.worktrees_dir();
                match pico_core::worktree::ensure(
                    &worktrees_dir,
                    crate::consts::PLATFORM,
                    &sched.target,
                    &thread_id,
                    &branch_prefix,
                    &base_repo,
                    &default_branch,
                )
                .await
                {
                    Ok(path) => (
                        profile,
                        path,
                        Some(WorktreeOrigin {
                            base_repo,
                            default_branch,
                            branch_prefix,
                        }),
                    ),
                    Err(e) => {
                        tracing::warn!(error = %format!("{e:#}"), schedule_id = %sched.id, "scheduled worktree setup failed");
                        return FireOutcome::Transient;
                    }
                }
            }
        };

        pico_core::thread_marker::save(
            &self.db,
            crate::consts::PLATFORM,
            &thread_id,
            &ThreadMarker {
                profile: profile.clone(),
                cwd: cwd.clone(),
                worktree: worktree_origin.clone(),
                closed_at: None,
                channel_id: Some(sched.target.clone()),
            },
        )
        .await;

        let guild_id = parse_guild(&sched.scope).unwrap_or(thread.guild_id);
        let inputs = TurnInputs {
            thread_id,
            target: thread.id,
            profile,
            cwd,
            worktree_origin,
            wrapped,
            images: &[],
            trigger: None,
            author: parse_user(&sched.created_by).unwrap_or_else(|| serenity::UserId::new(1)),
            guild_id,
            guild_name: guild_id.name(&self.ctx.cache),
            bound_channel: target_channel,
            channel_name: channel_display_name(&self.ctx, guild_id, target_channel),
            thread_label: fresh_thread_label(&sched.name),
            render: config.render(),
            timezone: self.timezone(),
        };
        self.drive(inputs).await;
        FireOutcome::Delivered
    }

    async fn drive(&self, inputs: TurnInputs<'_>) {
        let thread_id = inputs.thread_id.clone();
        match drive_thread_turn(
            &self.ctx,
            &self.root,
            &self.pool,
            &self.camofox,
            &self.cancel,
            &self.pending_answers,
            &self.mid_turn,
            &self.cancels,
            inputs,
        )
        .await
        {
            Ok(spawn) => match spawn.result {
                Ok(pico_core::engine::TurnOutcome::Dead) => self.pool.forget(&thread_id).await,
                Ok(pico_core::engine::TurnOutcome::Live) => {}
                Err(e) => tracing::warn!(error = %format!("{e:#}"), %thread_id, "scheduled turn failed"),
            },
            Err(e) => tracing::warn!(error = %format!("{e:#}"), %thread_id, "spawning scheduled turn failed"),
        }
    }
}

impl ScheduleHost for DiscordScheduleHost {
    async fn resolve_cwd(&self, sched: &Schedule) -> color_eyre::Result<Option<PathBuf>> {
        match sched.mode {
            Mode::Continue => Ok(pico_core::thread_marker::load(&self.db, crate::consts::PLATFORM, &sched.origin)
                .await
                .filter(|m| m.closed_at.is_none())
                .map(|m| m.cwd)),
            Mode::Fresh => {
                let Some(config) = self.load_config() else {
                    return Err(eyre!("discord config unavailable while resolving scheduled target"));
                };
                let Some(guild_default) = config.guild(&sched.scope) else {
                    return Ok(None);
                };
                let binding = pico_core::bindings::get(&self.db, crate::consts::PLATFORM, &sched.target).await?;
                let cwd = match resolve_route(binding.as_ref(), &guild_default.profile, &guild_default.cwd) {
                    Route::Regular { cwd, .. } => cwd,
                    Route::Worktree { base_repo, .. } => base_repo,
                };
                Ok(Some(cwd))
            }
        }
    }

    async fn fire(&self, sched: &Schedule, wrapped_prompt: &str) -> FireOutcome {
        match sched.mode {
            Mode::Continue => self.fire_continue(sched, wrapped_prompt).await,
            Mode::Fresh => self.fire_fresh(sched, wrapped_prompt).await,
        }
    }

    async fn post_raw(&self, sched: &Schedule, text: &str) -> FireOutcome {
        let chunks = crate::discord::render_chunks(text, crate::consts::DISCORD_LIMITS.message_cap);
        if chunks.is_empty() {
            return FireOutcome::Delivered;
        }
        let channel = match sched.mode {
            Mode::Continue => match parse_channel(&sched.origin) {
                Some(origin) => origin,
                None => return FireOutcome::TargetGone,
            },
            Mode::Fresh => {
                let Some(target_channel) = parse_channel(&sched.target) else {
                    return FireOutcome::TargetGone;
                };
                match self.create_thread(target_channel, &sched.name).await {
                    Ok(thread) => thread.id,
                    Err(e) => {
                        return if is_permanent_target_error(&e) {
                            FireOutcome::TargetGone
                        } else {
                            FireOutcome::Transient
                        };
                    }
                }
            }
        };
        self.send_chunks(channel, sched, chunks).await
    }

    async fn notify_home(&self, sched: &Schedule, notice: &HomeNotice) {
        let Some(config) = self.load_config() else {
            return;
        };
        let Some(guild) = config.guild(&sched.scope) else {
            tracing::warn!(scope = %sched.scope, schedule_id = %sched.id, "no guild config for scheduled notice");
            return;
        };
        let Some(home) = guild.home_channel.as_deref() else {
            tracing::warn!(schedule_id = %sched.id, "no home_channel configured; dropping scheduled notice");
            return;
        };
        let Some(channel) = parse_channel(home) else {
            tracing::warn!(home = %home, schedule_id = %sched.id, "invalid home_channel id");
            return;
        };
        let embed = build_notice_embed(sched, notice);
        let msg = serenity::CreateMessage::new().embed(embed);
        if let Err(e) = channel.send_message(&self.ctx, msg).await {
            tracing::warn!(error = %format!("{e:#}"), schedule_id = %sched.id, "posting scheduled home notice failed");
        }
    }
}

fn default_render() -> Render {
    Render {
        streaming_behavior: StreamingBehavior::default(),
    }
}

fn fresh_thread_label(name: &str) -> String {
    let label: String = name.lines().next().unwrap_or("").trim().chars().take(90).collect();
    if label.is_empty() {
        "scheduled".to_owned()
    } else {
        label
    }
}

fn build_notice_embed(sched: &Schedule, notice: &HomeNotice) -> serenity::CreateEmbed {
    let (title, colour) = match notice {
        HomeNotice::ScriptFailed { .. } => ("⚠️ Scheduled job failed", serenity::Colour::new(0xE67E22)),
        HomeNotice::Missed { .. } => ("🕐 Scheduled job missed", serenity::Colour::new(0x95A5A6)),
        HomeNotice::Disabled(_) => ("🛑 Schedule disabled", serenity::Colour::new(0xE74C3C)),
    };
    let description = format!("[open thread](https://discord.com/channels/{}/{})", sched.scope, sched.origin);
    let job = pico_core::render::truncate(&pico_core::platform_render::defang_mentions(&sched.name), 200);
    let mode = match sched.mode {
        Mode::Continue => "continue",
        Mode::Fresh => "fresh",
    };
    let mut embed = serenity::CreateEmbed::new()
        .title(title)
        .colour(colour)
        .timestamp(serenity::Timestamp::now())
        .description(description)
        .field("Job", job, true)
        .field("ID", &sched.id, true)
        .field("Trigger", sched.trigger.describe(), true)
        .field("Mode", mode, true);
    match notice {
        HomeNotice::ScriptFailed { reason, stderr_tail } => {
            let reason = pico_core::render::truncate(&pico_core::platform_render::defang_mentions(reason), 1000);
            embed = embed.field("Reason", reason, false);
            let stderr = stderr_tail.trim();
            if !stderr.is_empty() {
                let stderr = pico_core::platform_render::defang_mentions(stderr).replace("```", "`\u{200b}`\u{200b}`");
                let stderr = pico_core::render::truncate(&stderr, 1000);
                embed = embed.field("stderr", format!("```\n{stderr}\n```"), false);
            }
        }
        HomeNotice::Missed { due } => {
            embed = embed.field("Due", due.to_rfc3339_opts(chrono::SecondsFormat::Secs, true), true);
        }
        HomeNotice::Disabled(reason) => {
            let cause = match reason {
                DisableReason::TargetUnresolvable => "target can no longer be resolved".to_owned(),
                DisableReason::OriginUnreachable => "could not reach the origin thread".to_owned(),
                DisableReason::TargetUnreachable => "could not reach the target channel".to_owned(),
                DisableReason::ConsecutiveFailures(n) => format!("auto-disabled after {n} consecutive failures"),
                DisableReason::MissingDefinition => "its definition files are missing".to_owned(),
            };
            embed = embed.field("Reason", cause, false);
        }
    }
    embed
}

fn parse_channel(value: &str) -> Option<serenity::ChannelId> {
    value
        .parse::<u64>()
        .ok()
        .filter(|n| *n != 0)
        .map(serenity::ChannelId::new)
}

fn parse_guild(value: &str) -> Option<serenity::GuildId> {
    value
        .parse::<u64>()
        .ok()
        .filter(|n| *n != 0)
        .map(serenity::GuildId::new)
}

fn parse_user(value: &str) -> Option<serenity::UserId> {
    value.parse::<u64>().ok().filter(|n| *n != 0).map(serenity::UserId::new)
}

fn is_unknown_channel(e: &serenity::Error) -> bool {
    matches!(
        e,
        serenity::Error::Http(serenity::HttpError::UnsuccessfulRequest(resp)) if resp.error.code == UNKNOWN_CHANNEL
    )
}

fn is_permanent_target_error(e: &serenity::Error) -> bool {
    if is_unknown_channel(e) {
        return true;
    }
    let serenity::Error::Http(serenity::HttpError::UnsuccessfulRequest(resp)) = e else {
        return false;
    };
    resp.status_code.as_u16() == 403 || resp.error.code == MISSING_ACCESS || resp.error.code == MISSING_PERMISSIONS
}

#[cfg(test)]
mod tests {
    use pico_core::schedule::{DisableReason, HomeNotice, Mode, Schedule, State, Trigger};

    use super::build_notice_embed;

    fn sample_schedule() -> Schedule {
        let ts = chrono::DateTime::from_timestamp(1_700_000_000, 0).unwrap();
        Schedule {
            id: "sched_abc".to_owned(),
            platform: "discord".to_owned(),
            scope: "111".to_owned(),
            name: "nightly report".to_owned(),
            created_by: "222".to_owned(),
            created_at: ts,
            mode: Mode::Continue,
            origin: "333".to_owned(),
            target: "444".to_owned(),
            trigger: Trigger::Cron {
                expr: "0 * * * *".to_owned(),
                tz: chrono_tz::UTC,
            },
            next_run_at: ts,
            last_run_at: None,
            consecutive_failures: 0,
            max_runs: None,
            run_count: 0,
            script_timeout: None,
            state: State::Active,
        }
    }

    fn has_field(v: &serde_json::Value, name: &str) -> bool {
        v["fields"]
            .as_array()
            .is_some_and(|fields| fields.iter().any(|f| f["name"] == name))
    }

    #[test]
    fn script_failed_with_stderr_renders_stderr_field() {
        let notice = HomeNotice::ScriptFailed {
            reason: "exit code 1".to_owned(),
            stderr_tail: "boom\npanic".to_owned(),
        };
        let v = serde_json::to_value(build_notice_embed(&sample_schedule(), &notice)).unwrap();
        assert_eq!(v["title"], "⚠️ Scheduled job failed");
        assert_eq!(v["color"].as_u64(), Some(0xE67E22));
        assert!(has_field(&v, "Job"));
        assert!(has_field(&v, "ID"));
        assert!(has_field(&v, "Reason"));
        assert!(has_field(&v, "stderr"));
    }

    #[test]
    fn script_failed_empty_stderr_omits_field() {
        let notice = HomeNotice::ScriptFailed {
            reason: "nonzero".to_owned(),
            stderr_tail: "   \n  ".to_owned(),
        };
        let v = serde_json::to_value(build_notice_embed(&sample_schedule(), &notice)).unwrap();
        assert!(has_field(&v, "Reason"));
        assert!(!has_field(&v, "stderr"));
    }

    #[test]
    fn missed_renders_due_field() {
        let due = chrono::DateTime::from_timestamp(1_700_000_500, 0).unwrap();
        let v = serde_json::to_value(build_notice_embed(&sample_schedule(), &HomeNotice::Missed { due })).unwrap();
        assert_eq!(v["title"], "🕐 Scheduled job missed");
        assert_eq!(v["color"].as_u64(), Some(0x95A5A6));
        assert!(has_field(&v, "Due"));
    }

    #[test]
    fn disabled_consecutive_failures_reason_text() {
        let notice = HomeNotice::Disabled(DisableReason::ConsecutiveFailures(3));
        let v = serde_json::to_value(build_notice_embed(&sample_schedule(), &notice)).unwrap();
        assert_eq!(v["title"], "🛑 Schedule disabled");
        assert_eq!(v["color"].as_u64(), Some(0xE74C3C));
        let fields = v["fields"].as_array().unwrap();
        let reason = fields.iter().find(|f| f["name"] == "Reason").unwrap();
        assert!(
            reason["value"]
                .as_str()
                .unwrap()
                .contains("auto-disabled after 3 consecutive failures")
        );
    }

    #[test]
    fn disabled_missing_definition_reason_text() {
        let notice = HomeNotice::Disabled(DisableReason::MissingDefinition);
        let v = serde_json::to_value(build_notice_embed(&sample_schedule(), &notice)).unwrap();
        assert_eq!(v["title"], "🛑 Schedule disabled");
        assert_eq!(v["color"].as_u64(), Some(0xE74C3C));
        let fields = v["fields"].as_array().unwrap();
        let reason = fields.iter().find(|f| f["name"] == "Reason").unwrap();
        assert!(
            reason["value"]
                .as_str()
                .unwrap()
                .contains("definition files are missing")
        );
    }

    #[test]
    fn script_failed_stderr_escapes_code_fence() {
        let notice = HomeNotice::ScriptFailed {
            reason: "boom".to_owned(),
            stderr_tail: "before ``` after".to_owned(),
        };
        let v = serde_json::to_value(build_notice_embed(&sample_schedule(), &notice)).unwrap();
        let fields = v["fields"].as_array().unwrap();
        let stderr = fields.iter().find(|f| f["name"] == "stderr").unwrap();
        let value = stderr["value"].as_str().unwrap();
        let inner = value.trim_start_matches("```\n").trim_end_matches("\n```");
        assert!(!inner.contains("```"));
    }

    #[test]
    fn script_failed_fence_heavy_stderr_stays_within_field_limit() {
        let notice = HomeNotice::ScriptFailed {
            reason: "boom".to_owned(),
            stderr_tail: "```".repeat(800),
        };
        let v = serde_json::to_value(build_notice_embed(&sample_schedule(), &notice)).unwrap();
        let fields = v["fields"].as_array().unwrap();
        let stderr = fields.iter().find(|f| f["name"] == "stderr").unwrap();
        let value = stderr["value"].as_str().unwrap();
        assert!(value.chars().count() <= 1024);
        let inner = value.trim_start_matches("```\n").trim_end_matches("\n```");
        assert!(!inner.contains("```"));
    }
}
