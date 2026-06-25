use std::{
    path::{Path, PathBuf},
    sync::Arc,
};

use color_eyre::eyre::{WrapErr, eyre};
use pico_core::{
    cancel::CancelRegistry,
    config::StreamingBehavior,
    mid_turn::MidTurnQueue,
    omp::{camofox::CamofoxDaemon, pool::OmpPool},
    schedule::{FireOutcome, Mode, Schedule, ScheduleHost},
    surface::ConversationId,
    thread_marker::{ThreadMarker, WorktreeOrigin},
};
use poise::serenity_prelude as serenity;
use tokio_util::sync::CancellationToken;

use crate::{
    config::Render,
    discord::{Route, TurnInputs, channel_display_name, drive_thread_turn, resolve_route},
};

const SCHEDULE_EXTENSION: &str = include_str!("schedule_extension.ts");

const UNKNOWN_CHANNEL: isize = 10003;

const MISSING_ACCESS: isize = 50001;

const MISSING_PERMISSIONS: isize = 50013;

const POST_CAP: usize = 1900;

pub(crate) fn schedule_extension_path(root: &Path) -> PathBuf {
    root.join("schedule").join("extension.ts")
}

pub(crate) fn write_schedule_extension(root: &Path) -> color_eyre::Result<PathBuf> {
    let path = schedule_extension_path(root);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).wrap_err_with(|| format!("create {}", parent.display()))?;
    }
    std::fs::write(&path, SCHEDULE_EXTENSION).wrap_err_with(|| format!("write {}", path.display()))?;
    Ok(path)
}

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

    async fn fire_continue(&self, sched: &Schedule, wrapped: &str) -> FireOutcome {
        let Some(origin) = parse_channel(&sched.origin) else {
            return FireOutcome::TargetGone;
        };
        let Some(marker) = pico_core::thread_marker::load(&self.db, "discord", &sched.origin)
            .await
            .filter(|m| m.closed_at.is_none())
        else {
            return FireOutcome::TargetGone;
        };

        let conversation = ConversationId::new("discord", &sched.origin);
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
            && let Err(e) =
                pico_core::worktree::ensure_at(&marker.cwd, &sched.origin, &wt.base_repo, &wt.default_branch).await
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
            trigger: None,
            author: parse_user(&sched.created_by).unwrap_or_else(|| serenity::UserId::new(1)),
            guild_id,
            guild_name: guild_id.name(&self.ctx.cache),
            bound_channel,
            channel_name,
            thread_label,
            render: self.render(),
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
        let binding = match pico_core::bindings::get(&self.db, "discord", &sched.target).await {
            Ok(binding) => binding,
            Err(e) => {
                tracing::warn!(error = %format!("{e:#}"), schedule_id = %sched.id, "resolving fresh target binding failed");
                return FireOutcome::Transient;
            }
        };
        let route = resolve_route(guild_default, binding.as_ref());

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
            } => {
                let worktrees_dir = self.worktrees_dir();
                match pico_core::worktree::ensure(
                    &worktrees_dir,
                    &sched.target,
                    &thread_id,
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
            "discord",
            &thread_id,
            &ThreadMarker {
                profile: profile.clone(),
                cwd: cwd.clone(),
                worktree: worktree_origin.clone(),
                closed_at: None,
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
            trigger: None,
            author: parse_user(&sched.created_by).unwrap_or_else(|| serenity::UserId::new(1)),
            guild_id,
            guild_name: guild_id.name(&self.ctx.cache),
            bound_channel: target_channel,
            channel_name: channel_display_name(&self.ctx, guild_id, target_channel),
            thread_label: fresh_thread_label(&sched.name),
            render: config.render(),
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
                Ok(pico_core::engine::TurnOutcome::Dead) => self.pool.forget(&thread_id),
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
            Mode::Continue => Ok(pico_core::thread_marker::load(&self.db, "discord", &sched.origin)
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
                let binding = pico_core::bindings::get(&self.db, "discord", &sched.target).await?;
                let cwd = match resolve_route(guild_default, binding.as_ref()) {
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
        let body = pico_core::render::truncate(&pico_core::render::defang_mentions(text), POST_CAP);
        match sched.mode {
            Mode::Continue => {
                let Some(origin) = parse_channel(&sched.origin) else {
                    return FireOutcome::TargetGone;
                };
                match origin.say(&self.ctx, body).await {
                    Ok(_) => FireOutcome::Delivered,
                    Err(e) if is_permanent_target_error(&e) => FireOutcome::TargetGone,
                    Err(e) => {
                        tracing::warn!(error = %format!("{e:#}"), schedule_id = %sched.id, "scheduled raw post failed");
                        FireOutcome::Transient
                    }
                }
            }
            Mode::Fresh => {
                let Some(target_channel) = parse_channel(&sched.target) else {
                    return FireOutcome::TargetGone;
                };
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
                match thread.id.say(&self.ctx, body).await {
                    Ok(_) => FireOutcome::Delivered,
                    Err(e) if is_permanent_target_error(&e) => FireOutcome::TargetGone,
                    Err(e) => {
                        tracing::warn!(error = %format!("{e:#}"), schedule_id = %sched.id, "scheduled raw post failed");
                        FireOutcome::Transient
                    }
                }
            }
        }
    }

    async fn notify_home(&self, sched: &Schedule, text: &str) {
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
        let jump = format!("https://discord.com/channels/{}/{}", sched.scope, sched.origin);
        let notice = format!("📅 {} (id {})\n{}\nthread: {}", sched.name, sched.id, text, jump);
        let body = pico_core::render::truncate(&pico_core::render::defang_mentions(&notice), POST_CAP);
        if let Err(e) = channel.say(&self.ctx, body).await {
            tracing::warn!(error = %format!("{e:#}"), schedule_id = %sched.id, "posting scheduled home notice failed");
        }
    }
}

fn default_render() -> Render {
    Render {
        surface_thinking: false,
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
