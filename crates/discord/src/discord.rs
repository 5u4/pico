use std::{sync::Arc, time::Duration};

use color_eyre::eyre::WrapErr;
use pico_core::{
    bindings::BindingKind,
    cancel::CancelRegistry,
    config::StreamingBehavior,
    mid_turn::MidTurnQueue,
    omp::{camofox::CamofoxDaemon, pool::OmpPool},
    surface::ConversationId,
};
use pico_shared::proto;
use poise::serenity_prelude as serenity;
use tokio_util::{sync::CancellationToken, task::TaskTracker};

pub(crate) struct Data {
    root: Arc<std::path::PathBuf>,
    db: sqlx::SqlitePool,
    pool: Arc<OmpPool>,
    camofox: Arc<CamofoxDaemon>,
    cancel: CancellationToken,
    tracker: TaskTracker,
    supervisor_socket: Option<std::path::PathBuf>,
    pending_answers: crate::ui::PendingAnswers,
    mid_turn: MidTurnQueue,
    cancels: CancelRegistry,
}

pub(crate) type Error = Box<dyn std::error::Error + Send + Sync>;
type Context<'a> = poise::Context<'a, Data, Error>;

#[allow(clippy::too_many_arguments)]
pub(crate) fn framework(
    root: std::path::PathBuf,
    db: sqlx::SqlitePool,
    pool: Arc<OmpPool>,
    camofox: Arc<CamofoxDaemon>,
    ready_tx: tokio::sync::oneshot::Sender<()>,
    supervisor_socket: Option<std::path::PathBuf>,
    cancel: CancellationToken,
    tracker: TaskTracker,
) -> poise::Framework<Data, Error> {
    poise::Framework::builder()
        .options(poise::FrameworkOptions {
            commands: vec![
                ping(),
                bind(),
                dev_deploy(),
                update(),
                worktree(),
                cancel_turn(),
                busy(),
                schedule_command(),
                context(),
                compact(),
                shake(),
            ],
            event_handler: |ctx, event, framework, data| Box::pin(on_event(ctx, event, framework.bot_id, data)),
            command_check: Some(|ctx| Box::pin(command_in_registered_guild(ctx))),
            ..Default::default()
        })
        .setup(move |ctx, _ready, framework| {
            Box::pin(async move {
                poise::builtins::register_globally(ctx, &framework.options().commands).await?;
                let _ = ready_tx.send(());
                if pico_core::config::any_browser_enabled(&root) {
                    tracker.spawn(pico_core::omp::camofox::ensure_engine(cancel.clone()));
                }
                let root = Arc::new(root);
                let pending_answers = crate::ui::PendingAnswers::default();
                let mid_turn = MidTurnQueue::default();
                let cancels = CancelRegistry::default();
                let host = crate::schedule_host::DiscordScheduleHost {
                    ctx: ctx.clone(),
                    db: db.clone(),
                    pool: Arc::clone(&pool),
                    camofox: Arc::clone(&camofox),
                    mid_turn: mid_turn.clone(),
                    cancels: cancels.clone(),
                    pending_answers: pending_answers.clone(),
                    root: Arc::clone(&root),
                    cancel: cancel.clone(),
                };
                match pico_core::config::load_root(&pico_shared::paths::worker_config(&root)) {
                    Ok(root_config) => match pico_shared::paths::worker_root() {
                        Ok(sched_root) => {
                            let sched_cancel = cancel.clone();
                            let cfg = root_config.schedule();
                            tracker.spawn(async move {
                                pico_core::schedule::run(host, cfg, sched_root, sched_cancel).await;
                            });
                        }
                        Err(e) => {
                            tracing::warn!(error = %format!("{e:#}"), "resolving worker root for scheduler failed; scheduler not started");
                        }
                    },
                    Err(e) => {
                        tracing::warn!(error = %format!("{e:#}"), "loading worker config for scheduler failed; scheduler not started");
                    }
                }
                Ok(Data {
                    root,
                    db,
                    pool,
                    camofox,
                    supervisor_socket,
                    cancel,
                    tracker,
                    pending_answers,
                    mid_turn,
                    cancels,
                })
            })
        })
        .build()
}

async fn command_in_registered_guild(ctx: Context<'_>) -> Result<bool, Error> {
    let Some(guild_id) = ctx.guild_id() else {
        ctx.say("Commands only work inside a configured server.").await?;
        return Ok(false);
    };
    let discord_config = match crate::config::load(&pico_shared::paths::discord_config(&ctx.data().root)) {
        Ok(config) => config,
        Err(e) => {
            ctx.say(format!("config error: {e}")).await?;
            return Ok(false);
        }
    };
    if discord_config.guild(&guild_id.to_string()).is_some() {
        Ok(true)
    } else {
        ctx.say("This server isn't configured, so I can't run commands here.")
            .await?;
        Ok(false)
    }
}

#[poise::command(slash_command)]
async fn ping(ctx: Context<'_>) -> Result<(), Error> {
    ctx.say("Pong!").await?;
    Ok(())
}

#[poise::command(slash_command, rename = "schedule")]
async fn schedule_command(ctx: Context<'_>) -> Result<(), Error> {
    let Some(guild_id) = ctx.guild_id() else {
        ctx.say("Schedules only exist inside a configured server.").await?;
        return Ok(());
    };
    let schedules =
        match pico_core::schedule::list(&ctx.data().root, crate::consts::PLATFORM, &guild_id.to_string()).await {
            Ok(schedules) => schedules,
            Err(e) => {
                ctx.say(format!("error reading schedules: {e}")).await?;
                return Ok(());
            }
        };
    let schedules: Vec<_> = schedules
        .into_iter()
        .filter(|s| s.state == pico_core::schedule::State::Active)
        .collect();
    if schedules.is_empty() {
        ctx.say("No active schedules for this server.").await?;
        return Ok(());
    }
    let cap = pico_core::config::load_root(&pico_shared::paths::worker_config(&ctx.data().root))
        .map(|c| c.schedule().cap)
        .unwrap_or(std::time::Duration::from_secs(60));
    let health = pico_core::schedule::scheduler_health(&ctx.data().root, cap);
    let mut body = format!("📅 Schedules\n{}\n", schedule_health_line(&health));
    for s in &schedules {
        let runs = match s.max_runs {
            Some(max) => format!(" — runs {}/{}", s.run_count, max),
            None => String::new(),
        };
        body.push_str(&format!(
            "• `{}` {} — {} — next {}{}\n",
            s.id,
            s.name,
            s.trigger.describe(),
            s.next_run_at.to_rfc3339(),
            runs
        ));
    }
    let body = pico_core::render::truncate(
        &pico_core::platform_render::defang_mentions(&body),
        crate::consts::DISCORD_LIMITS.message_cap,
    );
    ctx.say(body).await?;
    Ok(())
}

fn schedule_health_line(health: &pico_core::schedule::SchedulerHealth) -> String {
    match health.heartbeat_at {
        None => "scheduler: no heartbeat yet".to_owned(),
        Some(beat) => {
            let age = (chrono::Utc::now() - beat).num_seconds().max(0);
            if health.stalled {
                format!("scheduler: ⚠️ stalled (last tick {age}s ago)")
            } else {
                format!("scheduler: ✓ healthy (last tick {age}s ago)")
            }
        }
    }
}

#[poise::command(slash_command, rename = "cancel")]
async fn cancel_turn(ctx: Context<'_>) -> Result<(), Error> {
    let thread_id = ctx.channel_id().to_string();
    let accepted = ctx
        .data()
        .cancels
        .request(&ConversationId::new(crate::consts::PLATFORM, &thread_id));
    tracing::debug!(%thread_id, accepted, "cancel requested");
    if accepted {
        ctx.say("🛑 Turn cancelled.").await?;
    } else {
        ctx.say("Nothing to cancel.").await?;
    }
    Ok(())
}

#[poise::command(
    slash_command,
    subcommands("busy_steer", "busy_follow_up", "busy_queue"),
    subcommand_required
)]
async fn busy(_ctx: Context<'_>) -> Result<(), Error> {
    Ok(())
}

#[poise::command(slash_command, rename = "steer")]
async fn busy_steer(
    ctx: Context<'_>,
    #[description = "Message to inject into the currently-running turn"] message: String,
) -> Result<(), Error> {
    deliver_busy(ctx, StreamingBehavior::Steer, message).await
}

#[poise::command(slash_command, rename = "follow_up")]
async fn busy_follow_up(
    ctx: Context<'_>,
    #[description = "Message to run as a follow-up after the current turn"] message: String,
) -> Result<(), Error> {
    deliver_busy(ctx, StreamingBehavior::FollowUp, message).await
}

#[poise::command(slash_command, rename = "queue")]
async fn busy_queue(
    ctx: Context<'_>,
    #[description = "Message to run as a fresh prompt after the current turn ends"] message: String,
) -> Result<(), Error> {
    deliver_busy(ctx, StreamingBehavior::Queue, message).await
}

pub(crate) fn render_chunks(text: &str, budget: usize) -> Vec<String> {
    let listed = pico_core::platform_render::tables_to_lists(text);
    let defanged = pico_core::platform_render::defang_mentions(&listed);
    pico_core::render::split_to_budget(&defanged, budget)
}

fn render_reply(text: &str, as_reply: bool, silent: bool) -> Vec<(String, pico_core::surface::PostOpts)> {
    use pico_core::surface::PostOpts;
    render_chunks(text, crate::consts::DISCORD_LIMITS.message_cap)
        .into_iter()
        .enumerate()
        .map(|(i, chunk)| {
            let opts = if i == 0 {
                PostOpts { as_reply, silent }
            } else {
                PostOpts::SILENT
            };
            (chunk, opts)
        })
        .collect()
}

async fn deliver_busy(ctx: Context<'_>, mode: StreamingBehavior, message: String) -> Result<(), Error> {
    let text = message.trim();
    if text.is_empty() {
        ctx.send(
            poise::CreateReply::default()
                .content("message can't be empty")
                .ephemeral(true),
        )
        .await?;
        return Ok(());
    }

    let in_thread = match ctx.channel_id().to_channel(ctx.serenity_context()).await? {
        serenity::Channel::Guild(ch) => is_thread(ch.kind),
        _ => false,
    };
    if !in_thread {
        ctx.send(
            poise::CreateReply::default()
                .content("Use /busy inside a thread where pico is working.")
                .ephemeral(true),
        )
        .await?;
        return Ok(());
    }

    let root = &ctx.data().root;
    let root_config = match pico_core::config::load_root(&pico_shared::paths::worker_config(root)) {
        Ok(config) => config,
        Err(e) => {
            ctx.send(
                poise::CreateReply::default()
                    .content(format!("❌ worker config error: {e}"))
                    .ephemeral(true),
            )
            .await?;
            return Ok(());
        }
    };

    let sent_at =
        pico_core::prompt::format_sent_at(serenity::Timestamp::now().unix_timestamp(), root_config.timezone());
    let display_name = ctx
        .author_member()
        .await
        .and_then(|member| member.nick.clone())
        .or_else(|| ctx.author().global_name.clone())
        .unwrap_or_else(|| ctx.author().name.clone());
    let wrapped = pico_core::prompt::wrap_discord_message(ctx.author().id.get(), &display_name, &sent_at, text, &[]);

    let conv = ConversationId::new(crate::consts::PLATFORM, &ctx.channel_id().to_string());
    let delivered = ctx.data().mid_turn.deliver(&conv, &wrapped, Some(mode));
    tracing::debug!(channel_id = %ctx.channel_id(), user_id = %ctx.author().id, mode = ?mode, accepted = delivered.is_some(), "busy deliver");
    match delivered {
        Some(resolved) => {
            let (emoji, label) = busy_label(resolved);
            let echo = format!("{emoji} `{label}` · {display_name}: {text}");
            ctx.say(pico_core::render::truncate(
                &pico_core::platform_render::defang_mentions(&echo),
                crate::consts::DISCORD_LIMITS.message_cap,
            ))
            .await?;
        }
        None => {
            ctx.send(
                poise::CreateReply::default()
                    .content("pico isn't busy here — just send your message normally.")
                    .ephemeral(true),
            )
            .await?;
        }
    }
    Ok(())
}

fn busy_label(mode: StreamingBehavior) -> (&'static str, &'static str) {
    match mode {
        StreamingBehavior::Steer => (REACT_STEER, "steer"),
        StreamingBehavior::FollowUp => (REACT_FOLLOW_UP, "follow_up"),
        StreamingBehavior::Queue => (REACT_QUEUE, "queue"),
    }
}

#[derive(poise::ChoiceParameter)]
enum ShakeMode {
    Elide,
    Images,
}

#[poise::command(slash_command)]
async fn context(ctx: Context<'_>) -> Result<(), Error> {
    let thread_id = ctx.channel_id().to_string();
    let Some(handle) = ctx.data().pool.get_existing(&thread_id) else {
        ctx.say("No active session in this thread yet — send a message first.")
            .await?;
        return Ok(());
    };
    ctx.defer().await?;
    match handle.client().context().await {
        Ok(Some(text)) => {
            let inner = pico_core::render::truncate(
                &pico_core::platform_render::defang_mentions(&text),
                crate::consts::DISCORD_LIMITS.message_cap - 8,
            );
            ctx.say(format!("```\n{inner}\n```")).await?;
        }
        Ok(None) => {
            ctx.say("Session returned no context info.").await?;
        }
        Err(e) => {
            ctx.say(pico_core::render::truncate(
                &pico_core::platform_render::defang_mentions(&format!("❌ {e}")),
                crate::consts::DISCORD_LIMITS.message_cap,
            ))
            .await?;
        }
    }
    Ok(())
}

#[poise::command(slash_command)]
async fn shake(
    ctx: Context<'_>,
    #[description = "What to drop: elide (tool results + large blocks) or images"] mode: Option<ShakeMode>,
) -> Result<(), Error> {
    let thread_id = ctx.channel_id().to_string();
    let Some(handle) = ctx.data().pool.get_existing(&thread_id) else {
        ctx.say("No active session in this thread yet — send a message first.")
            .await?;
        return Ok(());
    };
    if ctx
        .data()
        .cancels
        .is_active(&ConversationId::new(crate::consts::PLATFORM, &thread_id))
    {
        ctx.say("A turn is running in this thread — /cancel it first.").await?;
        return Ok(());
    }
    let mode_str = match mode.unwrap_or(ShakeMode::Elide) {
        ShakeMode::Elide => "elide",
        ShakeMode::Images => "images",
    };
    ctx.defer().await?;
    let outcome = {
        let mut session = handle.lock().await;
        let result = session.client.shake(mode_str).await;
        while session.events.try_recv().is_ok() {}
        result
    };
    match outcome {
        Ok(Some(text)) => {
            ctx.say(pico_core::render::truncate(
                &pico_core::platform_render::defang_mentions(&text),
                crate::consts::DISCORD_LIMITS.message_cap,
            ))
            .await?;
        }
        Ok(None) => {
            ctx.say("✅ Context shaken.").await?;
        }
        Err(e) => {
            ctx.say(pico_core::render::truncate(
                &pico_core::platform_render::defang_mentions(&format!("❌ {e}")),
                crate::consts::DISCORD_LIMITS.message_cap,
            ))
            .await?;
        }
    }
    Ok(())
}

#[poise::command(slash_command)]
async fn compact(
    ctx: Context<'_>,
    #[description = "Optional focus to preserve while compacting"] focus: Option<String>,
) -> Result<(), Error> {
    let thread_id = ctx.channel_id().to_string();
    let Some(handle) = ctx.data().pool.get_existing(&thread_id) else {
        ctx.say("No active session in this thread yet — send a message first.")
            .await?;
        return Ok(());
    };
    if ctx
        .data()
        .cancels
        .is_active(&ConversationId::new(crate::consts::PLATFORM, &thread_id))
    {
        ctx.say("A turn is running in this thread — /cancel it first.").await?;
        return Ok(());
    }
    ctx.defer().await?;
    let outcome = {
        let mut session = handle.lock().await;
        let result = session.client.compact(focus.as_deref()).await;
        while session.events.try_recv().is_ok() {}
        result
    };
    match outcome {
        Ok(Some(text)) => {
            ctx.say(pico_core::render::truncate(
                &pico_core::platform_render::defang_mentions(&text),
                crate::consts::DISCORD_LIMITS.message_cap,
            ))
            .await?;
        }
        Ok(None) => {
            ctx.say("✅ Context compacted.").await?;
        }
        Err(e) => {
            ctx.say(pico_core::render::truncate(
                &pico_core::platform_render::defang_mentions(&format!("❌ {e}")),
                crate::consts::DISCORD_LIMITS.message_cap,
            ))
            .await?;
        }
    }
    Ok(())
}

#[poise::command(slash_command, rename = "dev-deploy")]
async fn dev_deploy(ctx: Context<'_>) -> Result<(), Error> {
    let thread_id = ctx.channel_id().to_string();
    let Some(marker) = pico_core::thread_marker::load(&ctx.data().db, crate::consts::PLATFORM, &thread_id).await else {
        ctx.say("❌ this thread has no working dir yet — send it a message first, then retry.")
            .await?;
        return Ok(());
    };
    if let Some(closed_at) = &marker.closed_at {
        ctx.say(format!("❌ this worktree thread was closed at {closed_at}; open a new thread."))
            .await?;
        return Ok(());
    }
    build_and_deploy(ctx, marker.cwd, "this thread's working dir").await
}

#[poise::command(slash_command)]
async fn update(ctx: Context<'_>) -> Result<(), Error> {
    if ctx.data().supervisor_socket.is_none() {
        ctx.say("not running under a supervisor (standalone) — deploy is unavailable")
            .await?;
        return Ok(());
    }
    let repo = match pico_shared::paths::agent_repo() {
        Ok(repo) => repo,
        Err(e) => {
            ctx.say(format!("❌ can't locate the deployment checkout: {e:#}"))
                .await?;
            return Ok(());
        }
    };
    ctx.say(format!("⬇️ updating `{}` to origin/main…", repo.display()))
        .await?;
    if let Err(e) = pico_core::deploy::update_repo(&repo).await {
        ctx.say(format!("❌ update failed: {e:#}")).await?;
        return Ok(());
    }
    build_and_deploy(ctx, repo, "latest origin/main").await
}

pub(crate) async fn post_deploy_report(http: &Arc<serenity::Http>, report: proto::DeployReport) {
    let id: u64 = match report.report_to.parse() {
        Ok(id) if id != 0 => id,
        _ => {
            tracing::warn!(report_to = %report.report_to, "deploy report has an invalid channel id; dropping");
            return;
        }
    };
    if let Err(e) = serenity::ChannelId::new(id).say(http, &report.text).await {
        tracing::warn!(error = %format!("{e:#}"), channel = id, "failed to post deploy report to Discord");
    }
}

async fn build_and_deploy(ctx: Context<'_>, build_dir: std::path::PathBuf, what: &str) -> Result<(), Error> {
    let Some(socket) = ctx.data().supervisor_socket.clone() else {
        ctx.say("not running under a supervisor (standalone) — deploy is unavailable")
            .await?;
        return Ok(());
    };
    ctx.say(format!(
        "🔨 building pico-worker + pico-cli from {what} — I'll post the result here when it lands."
    ))
    .await?;
    let report_to = ctx.channel_id().get().to_string();
    let bin = match pico_core::deploy::build_worker(&build_dir).await {
        Ok(bin) => bin,
        Err(e) => {
            ctx.channel_id()
                .say(ctx.serenity_context(), format!("❌ build failed: {e:#}"))
                .await?;
            return Ok(());
        }
    };
    match pico_core::deploy::request_deploy(&socket, bin, Some(report_to)).await {
        Ok(proto::Response::Ok { detail }) => {
            tracing::info!(%detail, "deploy ok; outcome relayed to channel");
        }
        Ok(proto::Response::Error { message }) => {
            ctx.channel_id()
                .say(ctx.serenity_context(), format!("deploy failed: {message}"))
                .await?;
        }
        Ok(proto::Response::Status(_)) => {
            ctx.channel_id()
                .say(ctx.serenity_context(), "deploy returned an unexpected status reply")
                .await?;
        }
        Err(e) => {
            ctx.channel_id()
                .say(ctx.serenity_context(), format!("deploy outcome unknown: {e}"))
                .await?;
        }
    }
    Ok(())
}

#[poise::command(
    slash_command,
    subcommands("bind_set", "bind_worktree", "bind_unset", "bind_show"),
    subcommand_required
)]
async fn bind(_ctx: Context<'_>) -> Result<(), Error> {
    Ok(())
}

#[poise::command(slash_command, rename = "set")]
async fn bind_set(
    ctx: Context<'_>,
    #[description = "Absolute working directory for this channel's turns"] cwd: String,
    #[description = "Profile name (default: \"default\")"] profile: Option<String>,
) -> Result<(), Error> {
    let data = ctx.data();
    let channel = bindable_channel(ctx).await?;
    let profile = profile.unwrap_or_else(|| pico_shared::paths::DEFAULT_PROFILE.to_owned());
    if !pico_shared::paths::profile_dir(&data.root, &profile).is_dir() {
        ctx.say(format!("profile `{profile}` does not exist under this root"))
            .await?;
        return Ok(());
    }
    match pico_core::bindings::set_regular(
        &data.db,
        crate::consts::PLATFORM,
        &channel.to_string(),
        &profile,
        std::path::Path::new(&cwd),
    )
    .await
    {
        Ok(()) => {
            ctx.say(format!("bound <#{channel}> → profile `{profile}`, cwd `{cwd}`"))
                .await?;
            tracing::info!(channel_id = %channel, user_id = %ctx.author().id, %cwd, %profile, "binding set");
        }
        Err(e) => {
            ctx.say(format!("bind failed: {e}")).await?;
        }
    }
    Ok(())
}

#[poise::command(slash_command, rename = "worktree")]
async fn bind_worktree(
    ctx: Context<'_>,
    #[description = "Absolute path to a git repo to fork worktrees from"] base_repo: String,
    #[description = "Ref to fork from (default: \"origin/main\"); a local branch like \"main\" forks offline"]
    branch: Option<String>,
    #[description = "Profile name (default: \"default\")"] profile: Option<String>,
    #[description = "Branch prefix for forked branches (default: \"pico\")"] branch_prefix: Option<String>,
) -> Result<(), Error> {
    let data = ctx.data();
    let channel = bindable_channel(ctx).await?;
    let profile = profile.unwrap_or_else(|| pico_shared::paths::DEFAULT_PROFILE.to_owned());
    if !pico_shared::paths::profile_dir(&data.root, &profile).is_dir() {
        ctx.say(format!("profile `{profile}` does not exist under this root"))
            .await?;
        return Ok(());
    }
    let branch = branch.unwrap_or_else(|| pico_core::bindings::DEFAULT_BRANCH.to_owned());
    let branch_prefix = branch_prefix.unwrap_or_else(|| pico_core::bindings::DEFAULT_BRANCH_PREFIX.to_owned());
    let base_path = pico_shared::paths::expand_home(&base_repo);
    if let Err(e) = pico_core::worktree::validate_base_repo(&base_path, &branch).await {
        ctx.say(format!("not a usable worktree base: {e}")).await?;
        return Ok(());
    }
    match pico_core::bindings::set_worktree(
        &data.db,
        crate::consts::PLATFORM,
        &channel.to_string(),
        &profile,
        &base_path,
        &branch,
        &branch_prefix,
    )
    .await
    {
        Ok(()) => {
            ctx.say(format!(
                "bound <#{channel}> → worktree profile `{profile}`, base `{base_repo}`, branch `{branch}`, prefix `{branch_prefix}`"
            ))
            .await?;
            tracing::info!(channel_id = %channel, user_id = %ctx.author().id, %base_repo, %branch, %branch_prefix, %profile, "binding worktree set");
        }
        Err(e) => {
            ctx.say(format!("bind failed: {e}")).await?;
        }
    }
    Ok(())
}

#[poise::command(slash_command, rename = "unset")]
async fn bind_unset(ctx: Context<'_>) -> Result<(), Error> {
    let data = ctx.data();
    let channel = bindable_channel(ctx).await?;
    match pico_core::bindings::unset(&data.db, crate::consts::PLATFORM, &channel.to_string()).await {
        Ok(true) => {
            ctx.say(format!("unbound <#{channel}>")).await?;
            tracing::info!(channel_id = %channel, user_id = %ctx.author().id, "binding cleared");
        }
        Ok(false) => {
            ctx.say("this channel was not bound").await?;
        }
        Err(e) => {
            ctx.say(format!("unbind failed: {e}")).await?;
        }
    }
    Ok(())
}

#[poise::command(slash_command, rename = "show")]
async fn bind_show(ctx: Context<'_>) -> Result<(), Error> {
    let data = ctx.data();
    let channel = bindable_channel(ctx).await?;
    let reply = match pico_core::bindings::get(&data.db, crate::consts::PLATFORM, &channel.to_string()).await {
        Ok(Some(b)) => match &b.kind {
            BindingKind::Regular { cwd } => {
                format!("<#{channel}> → profile `{}`, cwd `{}`", b.profile, cwd.display())
            }
            BindingKind::Worktree {
                base_repo,
                default_branch,
                branch_prefix,
            } => format!(
                "<#{channel}> → worktree profile `{}`, base `{}`, branch `{}`, prefix `{}`",
                b.profile,
                base_repo.display(),
                default_branch,
                branch_prefix
            ),
        },
        Ok(None) => "this channel is not bound".to_owned(),
        Err(e) => format!("error reading binding: {e}"),
    };
    ctx.say(reply).await?;
    Ok(())
}

async fn bindable_channel(ctx: Context<'_>) -> Result<serenity::ChannelId, Error> {
    let id = ctx.channel_id();
    if let serenity::Channel::Guild(gc) = id.to_channel(ctx.serenity_context()).await?
        && is_thread(gc.kind)
        && let Some(parent) = gc.parent_id
    {
        return Ok(parent);
    }
    Ok(id)
}

const CLOSE_YES: &str = "worktree_close:yes";
const CLOSE_NO: &str = "worktree_close:no";
const CLOSE_CONFIRM_TIMEOUT: Duration = Duration::from_secs(60);

#[poise::command(slash_command, subcommands("worktree_close"), subcommand_required)]
async fn worktree(_ctx: Context<'_>) -> Result<(), Error> {
    Ok(())
}

#[poise::command(slash_command, rename = "close", ephemeral)]
async fn worktree_close(ctx: Context<'_>) -> Result<(), Error> {
    let data = ctx.data();
    let thread_id = ctx.channel_id().to_string();
    ctx.defer_ephemeral().await?;

    let marker = match pico_core::thread_marker::load(&data.db, crate::consts::PLATFORM, &thread_id).await {
        Some(marker) if marker.worktree.is_some() => marker,
        _ => {
            ctx.say("❌ not a worktree thread; nothing to close.").await?;
            return Ok(());
        }
    };
    if let Some(closed_at) = &marker.closed_at {
        ctx.say(format!("this worktree thread was already closed at {closed_at}."))
            .await?;
        return Ok(());
    }
    let origin = marker.worktree.as_ref().expect("worktree origin checked above");
    let base_repo = origin.base_repo.clone();
    let branch_prefix = origin.branch_prefix.clone();
    let worktree_path = marker.cwd.clone();

    let loss = match pico_core::worktree::close_would_lose(&base_repo, &worktree_path, &thread_id, &branch_prefix).await
    {
        Ok(loss) => loss,
        Err(e) => {
            ctx.say(format!("❌ worktree inspection failed: {e}")).await?;
            return Ok(());
        }
    };
    if loss.needs_confirmation() && !confirm_close(ctx, &loss).await? {
        return Ok(());
    }

    if data.pool.close(&thread_id).await == pico_core::omp::pool::CloseOutcome::Busy {
        ctx.say("⏳ a turn is running on this thread; wait for it to finish and retry.")
            .await?;
        return Ok(());
    }

    if let Err(e) = pico_core::worktree::remove(&base_repo, &worktree_path, &thread_id, &branch_prefix).await {
        ctx.say(format!("❌ teardown failed: {e}")).await?;
        return Ok(());
    }

    let closed_at = serenity::Timestamp::now().to_string();
    if let Err(e) =
        pico_core::thread_marker::tombstone(&data.db, crate::consts::PLATFORM, &thread_id, marker, closed_at).await
    {
        ctx.say(format!(
            "❌ worktree removed, but writing the closed marker failed: {e} — retry to finish."
        ))
        .await?;
        return Ok(());
    }

    let channel = ctx.channel_id();
    let _ = channel
        .say(
            ctx.serenity_context(),
            format!("✅ Worktree thread closed. Removed worktree and branch `{branch_prefix}/{thread_id}`. Conversation history preserved."),
        )
        .await;
    let _ = ctx.say("Closed.").await;
    if let Err(e) = channel
        .edit_thread(ctx.serenity_context(), serenity::EditThread::new().archived(true).locked(true))
        .await
    {
        tracing::warn!(%thread_id, error = %format!("{e:#}"), "archive+lock after close failed");
    }
    Ok(())
}

async fn confirm_close(ctx: Context<'_>, loss: &pico_core::worktree::LossSummary) -> Result<bool, Error> {
    let handle = ctx
        .send(
            poise::CreateReply::default()
                .ephemeral(true)
                .content(format!(
                    "⚠️ This worktree has {} that will be permanently deleted. Close anyway?",
                    loss.describe()
                ))
                .components(vec![serenity::CreateActionRow::Buttons(vec![
                    serenity::CreateButton::new(CLOSE_YES)
                        .label("Delete & close")
                        .style(serenity::ButtonStyle::Danger),
                    serenity::CreateButton::new(CLOSE_NO)
                        .label("Cancel")
                        .style(serenity::ButtonStyle::Secondary),
                ])]),
        )
        .await?;
    let message = handle.message().await?;
    let interaction = serenity::ComponentInteractionCollector::new(ctx.serenity_context())
        .message_id(message.id)
        .author_id(ctx.author().id)
        .timeout(CLOSE_CONFIRM_TIMEOUT)
        .next()
        .await;
    let Some(interaction) = interaction else {
        handle
            .edit(
                ctx,
                poise::CreateReply::default()
                    .content("Cancelled — confirmation timed out, nothing deleted.")
                    .components(vec![]),
            )
            .await?;
        return Ok(false);
    };
    let yes = interaction.data.custom_id == CLOSE_YES;
    let line = if yes {
        "⚠️ Confirmed — closing…"
    } else {
        "Cancelled — nothing deleted."
    };
    interaction
        .create_response(
            ctx.serenity_context(),
            serenity::CreateInteractionResponse::UpdateMessage(
                serenity::CreateInteractionResponseMessage::new()
                    .content(line)
                    .components(vec![]),
            ),
        )
        .await?;
    Ok(yes)
}

async fn on_event(
    ctx: &serenity::Context,
    event: &serenity::FullEvent,
    bot_id: serenity::UserId,
    data: &Data,
) -> Result<(), Error> {
    if let serenity::FullEvent::Message { new_message } = event {
        if new_message.author.id == bot_id {
            return Ok(());
        }
        let ctx = ctx.clone();
        let root = Arc::clone(&data.root);
        let db = data.db.clone();
        let pool = Arc::clone(&data.pool);
        let camofox = Arc::clone(&data.camofox);
        let cancel = data.cancel.clone();
        let message = new_message.clone();
        let channel_id = new_message.channel_id;
        let user_id = new_message.author.id;
        let tracker = data.tracker.clone();
        let pending_answers = data.pending_answers.clone();
        let mid_turn = data.mid_turn.clone();
        let cancels = data.cancels.clone();
        data.tracker.spawn(async move {
            if let Err(e) = route_message(
                ctx,
                root,
                db,
                pool,
                camofox,
                cancel,
                tracker,
                pending_answers,
                mid_turn,
                cancels,
                message,
            )
            .await
            {
                tracing::warn!(%channel_id, %user_id, error = %format!("{e:#}"), "message turn failed");
            }
        });
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
async fn route_message(
    ctx: serenity::Context,
    root: Arc<std::path::PathBuf>,
    db: sqlx::SqlitePool,
    pool: Arc<OmpPool>,
    camofox: Arc<CamofoxDaemon>,
    cancel: CancellationToken,
    tracker: TaskTracker,
    pending_answers: crate::ui::PendingAnswers,
    mid_turn: MidTurnQueue,
    cancels: CancelRegistry,
    message: serenity::Message,
) -> color_eyre::Result<()> {
    let prompt = message.content.trim();
    if prompt.is_empty()
        && message.referenced_message.is_none()
        && message.message_snapshots.is_empty()
        && !message.attachments.iter().any(is_image_attachment)
    {
        return Ok(());
    }

    let Some(guild_id) = message.guild_id else {
        return Ok(());
    };
    let root_config = match pico_core::config::load_root(&pico_shared::paths::worker_config(&root)) {
        Ok(config) => config,
        Err(e) => {
            message.reply(&ctx, format!("❌ worker config error: {e}")).await?;
            return Ok(());
        }
    };
    let discord_config = match crate::config::load(&pico_shared::paths::discord_config(&root)) {
        Ok(config) => config,
        Err(e) => {
            message.reply(&ctx, format!("❌ discord config error: {e}")).await?;
            return Ok(());
        }
    };

    let Some(guild_default) = discord_config.guild(&guild_id.to_string()) else {
        tracing::debug!(%guild_id, "guild not configured; ignoring message");
        return Ok(());
    };

    let serenity::Channel::Guild(channel) = message.channel_id.to_channel(&ctx).await? else {
        return Ok(());
    };
    let in_thread = is_thread(channel.kind);
    let bound_channel = if in_thread {
        match channel.parent_id {
            Some(parent) => parent,
            None => return Ok(()),
        }
    } else {
        channel.id
    };

    if in_thread && crate::ui::deliver_pending_answer(&pending_answers, channel.id, message.author.id, &message.content)
    {
        return Ok(());
    }
    let sent_at = pico_core::prompt::format_sent_at(message.timestamp.unix_timestamp(), root_config.timezone());
    let display_name = sender_display_name(&message);
    const QUOTE_CONTENT_CAP: usize = 500;
    let mut quotes: Vec<pico_core::prompt::Quote> = Vec::new();
    if let Some(ref_msg) = &message.referenced_message {
        let mut body = pico_core::render::truncate(&ref_msg.content, QUOTE_CONTENT_CAP);
        if !ref_msg.attachments.is_empty() {
            if !body.is_empty() {
                body.push('\n');
            }
            body.push_str(&format!("[{} attachment(s)]", ref_msg.attachments.len()));
        }
        quotes.push(pico_core::prompt::Quote {
            kind: pico_core::prompt::QuoteKind::Reply,
            user_id: Some(ref_msg.author.id.get()),
            name: Some(sender_display_name(ref_msg)),
            sent_at: pico_core::prompt::format_sent_at(ref_msg.timestamp.unix_timestamp(), root_config.timezone()),
            content: body,
        });
    }
    for snap in &message.message_snapshots {
        let mut body = pico_core::render::truncate(&snap.content, QUOTE_CONTENT_CAP);
        if !snap.attachments.is_empty() {
            if !body.is_empty() {
                body.push('\n');
            }
            body.push_str(&format!("[{} attachment(s)]", snap.attachments.len()));
        }
        quotes.push(pico_core::prompt::Quote {
            kind: pico_core::prompt::QuoteKind::Forward,
            user_id: None,
            name: None,
            sent_at: pico_core::prompt::format_sent_at(snap.timestamp.unix_timestamp(), root_config.timezone()),
            content: body,
        });
    }
    let wrapped =
        pico_core::prompt::wrap_discord_message(message.author.id.get(), &display_name, &sent_at, prompt, &quotes);

    if in_thread {
        let conversation = ConversationId::new(crate::consts::PLATFORM, &channel.id.to_string());
        if !prompt.is_empty() || !quotes.is_empty() {
            if let Some(mode) = mid_turn.deliver(&conversation, &wrapped, None) {
                react_queued(&ctx, &message, mode).await;
                return Ok(());
            }
        } else if mid_turn.is_active(&conversation) {
            react_unsupported(&ctx, &message).await;
            return Ok(());
        }
    }

    const MAX_IMAGES: usize = 8;
    const MAX_IMAGE_BYTES: u32 = 25 * 1024 * 1024;
    let mut images: Vec<pico_core::omp::protocol::ImageAttachment> = Vec::new();
    let mut file_refs = String::new();
    for att in &message.attachments {
        if images.len() >= MAX_IMAGES {
            break;
        }
        if !is_image_attachment(att) || att.size > MAX_IMAGE_BYTES {
            continue;
        }
        match att.download().await {
            Ok(bytes) => {
                use base64::Engine as _;
                let data = base64::engine::general_purpose::STANDARD.encode(&bytes);
                let mime_type = att.content_type.clone().unwrap_or_else(|| "image/png".to_owned());
                images.push(pico_core::omp::protocol::ImageAttachment { mime_type, data });
                file_refs.push_str(&image_ref(images.len(), att.width, att.height));
            }
            Err(e) => {
                tracing::warn!(error = %e, filename = %att.filename, "failed to download image attachment");
            }
        }
    }
    if images.is_empty() && prompt.is_empty() && quotes.is_empty() {
        return Ok(());
    }
    let wrapped = if file_refs.is_empty() {
        wrapped
    } else {
        let body = compose_message_body(prompt, &file_refs);
        pico_core::prompt::wrap_discord_message(message.author.id.get(), &display_name, &sent_at, &body, &quotes)
    };

    let binding = pico_core::bindings::get(&db, crate::consts::PLATFORM, &bound_channel.to_string()).await?;
    let route = pico_core::bindings::resolve_route(binding.as_ref(), &guild_default.profile, &guild_default.cwd);

    if !in_thread
        && let pico_core::bindings::Route::Regular { cwd, .. } = &route
        && !cwd.is_dir()
    {
        message
            .reply(
                &ctx,
                format!(
                    "❌ working directory `{}` is missing or not a directory — fix it on the host and resend.",
                    cwd.display()
                ),
            )
            .await?;
        return Ok(());
    }

    let title_seed = if prompt.is_empty() {
        quotes.first().map(|q| q.content.as_str()).unwrap_or(prompt)
    } else {
        prompt
    };
    let target = if in_thread {
        channel.id
    } else {
        match bound_channel
            .create_thread_from_message(&ctx, message.id, serenity::CreateThread::new(thread_name(title_seed)))
            .await
        {
            Ok(thread) => thread.id,
            Err(e) if is_thread_already_created(&e) => serenity::ChannelId::new(message.id.get()),
            Err(e) => return Err(e).wrap_err("create thread from message"),
        }
    };
    let thread_id = target.to_string();

    let (profile, cwd, worktree_origin) = match pico_core::thread_marker::load(&db, crate::consts::PLATFORM, &thread_id)
        .await
    {
        Some(marker) => {
            if let Some(closed_at) = &marker.closed_at {
                target
                    .say(
                        &ctx,
                        format!("❌ this worktree thread was closed at {closed_at}; open a new thread."),
                    )
                    .await?;
                return Ok(());
            }
            if let Some(wt) = &marker.worktree {
                if let Err(e) = pico_core::worktree::ensure_at(
                    &marker.cwd,
                    &thread_id,
                    &wt.branch_prefix,
                    &wt.base_repo,
                    &wt.default_branch,
                )
                .await
                {
                    target.say(&ctx, format!("❌ worktree setup failed: {e}")).await?;
                    return Ok(());
                }
            } else if !marker.cwd.is_dir() {
                target
                    .say(
                        &ctx,
                        format!(
                            "❌ working directory `{}` is missing or not a directory — fix it on the host and resend.",
                            marker.cwd.display()
                        ),
                    )
                    .await?;
                return Ok(());
            }
            (marker.profile, marker.cwd, marker.worktree)
        }
        None => {
            let (profile, cwd, worktree) = match route {
                pico_core::bindings::Route::Regular { profile, cwd } => {
                    if !cwd.is_dir() {
                        target
                            .say(
                                &ctx,
                                format!(
                                    "❌ working directory `{}` is missing or not a directory — fix it on the host and resend.",
                                    cwd.display()
                                ),
                            )
                            .await?;
                        return Ok(());
                    }
                    (profile, cwd, None)
                }
                pico_core::bindings::Route::Worktree {
                    profile,
                    base_repo,
                    default_branch,
                    branch_prefix,
                } => {
                    let worktrees_dir = root_config
                        .worktrees_dir()
                        .map(std::path::Path::to_path_buf)
                        .unwrap_or_else(|| pico_shared::paths::default_worktrees_dir(root.as_path()));
                    match pico_core::worktree::ensure(
                        &worktrees_dir,
                        crate::consts::PLATFORM,
                        &bound_channel.to_string(),
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
                            Some(pico_core::thread_marker::WorktreeOrigin {
                                base_repo,
                                default_branch,
                                branch_prefix,
                            }),
                        ),
                        Err(e) => {
                            target.say(&ctx, format!("❌ worktree setup failed: {e}")).await?;
                            return Ok(());
                        }
                    }
                }
            };
            pico_core::thread_marker::save(
                &db,
                crate::consts::PLATFORM,
                &thread_id,
                &pico_core::thread_marker::ThreadMarker {
                    profile: profile.clone(),
                    cwd: cwd.clone(),
                    worktree: worktree.clone(),
                    closed_at: None,
                    channel_id: Some(bound_channel.to_string()),
                },
            )
            .await;
            (profile, cwd, worktree)
        }
    };
    tracing::info!(%thread_id, %profile, user_id = %message.author.id, message_id = %message.id, guild_id = %guild_id, in_thread, "driving omp turn");

    let guild_name = guild_id.name(&ctx.cache);
    let (channel_name, thread_label) = if in_thread {
        (channel_display_name(&ctx, guild_id, bound_channel), channel.name.clone())
    } else {
        (Some(channel.name.clone()), thread_name(prompt))
    };
    let spawn = drive_thread_turn(
        &ctx,
        &root,
        &pool,
        &camofox,
        &cancel,
        &pending_answers,
        &mid_turn,
        &cancels,
        TurnInputs {
            thread_id: thread_id.clone(),
            target,
            profile,
            cwd,
            worktree_origin,
            wrapped: &wrapped,
            images: &images,
            trigger: in_thread.then_some(message.id),
            author: message.author.id,
            guild_id,
            guild_name,
            bound_channel,
            channel_name,
            thread_label,
            render: discord_config.render(),
            timezone: root_config.timezone(),
        },
    )
    .await?;
    if !in_thread {
        let title_surface = DiscordSurface {
            ctx: ctx.clone(),
            channel: target,
            trigger: None,
            author: message.author.id,
            pending: pending_answers.clone(),
            cancel: cancel.clone(),
        };
        tracker.spawn(pico_core::title::generate_and_apply(
            title_surface,
            Arc::clone(&spawn.handle),
            Arc::clone(&pool),
            prompt.to_owned(),
            spawn.title_seed,
            cancel.clone(),
        ));
    }
    if spawn.result? == pico_core::engine::TurnOutcome::Dead {
        pool.forget(&thread_id).await;
    }
    Ok(())
}

pub(crate) struct TurnInputs<'a> {
    pub(crate) thread_id: String,
    pub(crate) target: serenity::ChannelId,
    pub(crate) profile: String,
    pub(crate) cwd: std::path::PathBuf,
    pub(crate) worktree_origin: Option<pico_core::thread_marker::WorktreeOrigin>,
    pub(crate) wrapped: &'a str,
    pub(crate) images: &'a [pico_core::omp::protocol::ImageAttachment],
    pub(crate) trigger: Option<serenity::MessageId>,
    pub(crate) author: serenity::UserId,
    pub(crate) guild_id: serenity::GuildId,
    pub(crate) guild_name: Option<String>,
    pub(crate) bound_channel: serenity::ChannelId,
    pub(crate) channel_name: Option<String>,
    pub(crate) thread_label: String,
    pub(crate) render: pico_core::config::Render,
    pub(crate) timezone: chrono_tz::Tz,
}

#[allow(clippy::too_many_arguments)]
pub(crate) async fn drive_thread_turn(
    ctx: &serenity::Context,
    root: &std::path::Path,
    pool: &OmpPool,
    camofox: &CamofoxDaemon,
    cancel: &CancellationToken,
    pending_answers: &crate::ui::PendingAnswers,
    mid_turn: &MidTurnQueue,
    cancels: &CancelRegistry,
    inputs: TurnInputs<'_>,
) -> color_eyre::Result<pico_core::session::TurnSpawn> {
    let TurnInputs {
        thread_id,
        target,
        profile,
        cwd,
        worktree_origin,
        wrapped,
        images,
        trigger,
        author,
        guild_id,
        guild_name,
        bound_channel,
        channel_name,
        thread_label,
        render,
        timezone,
    } = inputs;

    let guild_line = pico_core::prompt::id_value(guild_id.get(), guild_name.as_deref());
    let channel_line = pico_core::prompt::id_value(bound_channel.get(), channel_name.as_deref());
    let thread_line = pico_core::prompt::id_value(target.get(), Some(&thread_label));
    let context_block = pico_core::prompt::runtime_context_block(&pico_core::prompt::RuntimeContext {
        platform: crate::consts::PLATFORM,
        extra: &[("guild", guild_line)],
        channel: &channel_line,
        thread: &thread_line,
        profile: &profile,
        cwd: &cwd,
        worktree: worktree_origin
            .as_ref()
            .map(|w| (w.base_repo.as_path(), w.default_branch.as_str())),
        timezone,
    });
    let identity = pico_core::omp::client::SessionIdentity {
        platform: crate::consts::PLATFORM.to_owned(),
        guild: guild_id.get().to_string(),
        channel: bound_channel.get().to_string(),
        thread: thread_id.clone(),
        user: author.get().to_string(),
    };
    let conversation = ConversationId::new(crate::consts::PLATFORM, &thread_id);
    let surface = DiscordSurface {
        ctx: ctx.clone(),
        channel: target,
        trigger,
        author,
        pending: pending_answers.clone(),
        cancel: cancel.clone(),
    };
    pico_core::session::run_turn(pico_core::session::RunTurn {
        surface: &surface,
        pool,
        root,
        profile: &profile,
        cwd,
        identity,
        context_block: &context_block,
        surface_rules: include_str!("discord_surface.md"),
        wrapped,
        images,
        mode: render.streaming_behavior,
        camofox,
        mid_turn,
        cancels,
        cancel,
        conversation: &conversation,
        thread_id: &thread_id,
    })
    .await
}

fn is_image_attachment(att: &serenity::Attachment) -> bool {
    is_image_content_type(att.content_type.as_deref())
}

fn is_image_content_type(content_type: Option<&str>) -> bool {
    content_type.is_some_and(|c| c.starts_with("image/"))
}

fn image_ref(index: usize, width: Option<u32>, height: Option<u32>) -> String {
    match (width, height) {
        (Some(w), Some(h)) => format!("[Image #{index}, {w}x{h}]\n"),
        _ => format!("[Image #{index}]\n"),
    }
}

fn compose_message_body(prompt: &str, file_refs: &str) -> String {
    let refs = file_refs.trim_end();
    if refs.is_empty() {
        return prompt.to_owned();
    }
    if prompt.is_empty() {
        return refs.to_owned();
    }
    format!("{prompt}\n{refs}")
}

fn sender_display_name(message: &serenity::Message) -> String {
    message
        .member
        .as_ref()
        .and_then(|m| m.nick.clone())
        .or_else(|| message.author.global_name.clone())
        .unwrap_or_else(|| message.author.name.clone())
}

pub(crate) fn channel_display_name(
    ctx: &serenity::Context,
    guild_id: serenity::GuildId,
    id: serenity::ChannelId,
) -> Option<String> {
    let guild = ctx.cache.guild(guild_id)?;
    guild.channels.get(&id).map(|channel| channel.name.clone())
}

const REACT_FOLLOW_UP: &str = "📥";
const REACT_STEER: &str = "↪️";
const REACT_QUEUE: &str = "⏳";
const REACT_UNSUPPORTED: &str = "🚫";

async fn react_queued(ctx: &serenity::Context, message: &serenity::Message, mode: StreamingBehavior) {
    let emoji = match mode {
        StreamingBehavior::FollowUp => REACT_FOLLOW_UP,
        StreamingBehavior::Steer => REACT_STEER,
        StreamingBehavior::Queue => REACT_QUEUE,
    };
    if let Err(e) = message
        .react(ctx, serenity::ReactionType::Unicode(emoji.to_owned()))
        .await
    {
        tracing::warn!(error = %format!("{e:#}"), "mid-turn ack reaction failed");
    }
}

async fn react_unsupported(ctx: &serenity::Context, message: &serenity::Message) {
    if let Err(e) = message
        .react(ctx, serenity::ReactionType::Unicode(REACT_UNSUPPORTED.to_owned()))
        .await
    {
        tracing::warn!(error = %format!("{e:#}"), "unsupported mid-turn image reaction failed");
    }
}

struct DiscordSurface {
    ctx: serenity::Context,
    channel: serenity::ChannelId,
    trigger: Option<serenity::MessageId>,
    author: serenity::UserId,
    pending: crate::ui::PendingAnswers,
    cancel: CancellationToken,
}

impl pico_core::surface::Surface for DiscordSurface {
    type Msg = serenity::MessageId;
    type Typing = serenity::Typing;

    fn typing(&self) -> serenity::Typing {
        self.channel.start_typing(&self.ctx.http)
    }

    fn limits(&self) -> pico_core::surface::SizeLimits {
        crate::consts::DISCORD_LIMITS
    }

    async fn post(&self, text: &str, opts: pico_core::surface::PostOpts) -> Option<serenity::MessageId> {
        let mut message = serenity::CreateMessage::new().content(text.to_owned());
        if opts.as_reply
            && let Some(msg_id) = self.trigger
        {
            let reference = serenity::MessageReference::from((self.channel, msg_id)).fail_if_not_exists(false);
            message = message.reference_message(reference);
        }
        if opts.silent {
            message = message.flags(serenity::MessageFlags::SUPPRESS_NOTIFICATIONS);
        }
        match self.channel.send_message(&self.ctx, message).await {
            Ok(msg) => Some(msg.id),
            Err(e) => {
                tracing::warn!(error = %format!("{e:#}"), "surface post failed");
                None
            }
        }
    }

    async fn post_reply(&self, text: &str, as_reply: bool, silent: bool) {
        for (chunk, opts) in render_reply(text, as_reply, silent) {
            self.post(&chunk, opts).await;
        }
    }

    async fn edit(&self, msg: &serenity::MessageId, text: &str) -> bool {
        match self
            .channel
            .edit_message(&self.ctx, *msg, serenity::EditMessage::new().content(text.to_owned()))
            .await
        {
            Ok(_) => true,
            Err(e) => {
                tracing::warn!(error = %format!("{e:#}"), "surface edit failed");
                false
            }
        }
    }

    async fn ui(&self, req: &pico_core::omp::protocol::UiRequest) -> pico_core::surface::UiOutcome {
        crate::ui::run(&self.ctx, self.channel, self.author, &self.pending, &self.cancel, req).await
    }

    async fn set_title(&self, title: &str) -> bool {
        match self
            .channel
            .edit_thread(&self.ctx.http, serenity::EditThread::new().name(title))
            .await
        {
            Ok(_) => true,
            Err(e) => {
                tracing::warn!(error = %format!("{e:#}"), %title, "surface set_title failed");
                false
            }
        }
    }
}

fn is_thread(kind: serenity::ChannelType) -> bool {
    matches!(
        kind,
        serenity::ChannelType::PublicThread | serenity::ChannelType::PrivateThread | serenity::ChannelType::NewsThread
    )
}

const THREAD_ALREADY_CREATED: isize = 160004;

fn is_thread_already_created(e: &serenity::Error) -> bool {
    matches!(
        e,
        serenity::Error::Http(serenity::HttpError::UnsuccessfulRequest(resp)) if resp.error.code == THREAD_ALREADY_CREATED
    )
}

fn thread_name(prompt: &str) -> String {
    let line = prompt.lines().next().unwrap_or("").trim();
    let name: String = line.chars().take(90).collect();
    if name.is_empty() { "chat".to_owned() } else { name }
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use pico_core::bindings::{Binding, BindingKind};

    use crate::config::GuildDefault;

    fn guild_default(profile: &str, cwd: &str) -> GuildDefault {
        GuildDefault {
            profile: profile.to_owned(),
            cwd: PathBuf::from(cwd),
            home_channel: None,
        }
    }

    fn binding(profile: &str, cwd: &str) -> Binding {
        Binding {
            profile: profile.to_owned(),
            kind: BindingKind::Regular {
                cwd: PathBuf::from(cwd),
            },
        }
    }

    #[test]
    fn binding_wins_over_guild_default() {
        let d = guild_default("default", "/default");
        let b = binding("sen", "/work");
        match pico_core::bindings::resolve_route(Some(&b), &d.profile, &d.cwd) {
            pico_core::bindings::Route::Regular { profile, cwd } => {
                assert_eq!(profile, "sen");
                assert_eq!(cwd, PathBuf::from("/work"));
            }
            _ => panic!("expected regular route"),
        }
    }

    #[test]
    fn unbound_channel_uses_guild_default() {
        let d = guild_default("default", "/default");
        match pico_core::bindings::resolve_route(None, &d.profile, &d.cwd) {
            pico_core::bindings::Route::Regular { profile, cwd } => {
                assert_eq!(profile, "default");
                assert_eq!(cwd, PathBuf::from("/default"));
            }
            _ => panic!("expected regular route"),
        }
    }

    #[test]
    fn worktree_binding_routes_to_worktree() {
        let d = guild_default("default", "/default");
        let b = Binding {
            profile: "sen".to_owned(),
            kind: BindingKind::Worktree {
                base_repo: PathBuf::from("/repo"),
                default_branch: "trunk".to_owned(),
                branch_prefix: "pico".to_owned(),
            },
        };
        match pico_core::bindings::resolve_route(Some(&b), &d.profile, &d.cwd) {
            pico_core::bindings::Route::Worktree {
                profile,
                base_repo,
                default_branch,
                branch_prefix,
            } => {
                assert_eq!(profile, "sen");
                assert_eq!(base_repo, PathBuf::from("/repo"));
                assert_eq!(default_branch, "trunk");
                assert_eq!(branch_prefix, "pico");
            }
            _ => panic!("expected worktree route"),
        }
    }

    #[test]
    fn short_reply_is_one_chunk_with_given_opts() {
        use pico_core::surface::PostOpts;
        let out = super::render_reply("hello", true, false);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].0, "hello");
        assert_eq!(
            out[0].1,
            PostOpts {
                as_reply: true,
                silent: false
            }
        );
    }

    #[test]
    fn long_reply_splits_first_pings_rest_silent() {
        use pico_core::surface::PostOpts;
        let out = super::render_reply(&"x".repeat(4000), true, false);
        assert!(out.len() >= 2);
        assert_eq!(
            out[0].1,
            PostOpts {
                as_reply: true,
                silent: false
            }
        );
        for (_, opts) in &out[1..] {
            assert_eq!(*opts, PostOpts::SILENT);
        }
        for (chunk, _) in &out {
            assert!(chunk.chars().count() <= crate::consts::DISCORD_LIMITS.message_cap);
        }
    }

    #[test]
    fn render_reply_defangs_mentions() {
        let out = super::render_reply("ping <@1> and @everyone now", true, false);
        assert_eq!(out.len(), 1);
        assert!(!out[0].0.contains("@everyone"));
        assert!(!out[0].0.contains("<@1>"));
        assert!(out[0].0.contains('\u{200b}'));
    }

    #[test]
    fn render_reply_flattens_tables() {
        let table = "| Name | Age |\n| --- | --- |\n| Alice | 30 |";
        let out = super::render_reply(table, true, false);
        assert_eq!(out.len(), 1);
        assert!(out[0].0.contains("**Alice**"));
        assert!(!out[0].0.contains("---"));
    }

    #[test]
    fn is_image_content_type_detects_image_prefix() {
        assert!(super::is_image_content_type(Some("image/png")));
        assert!(super::is_image_content_type(Some("image/")));
        assert!(!super::is_image_content_type(Some("text/plain")));
        assert!(!super::is_image_content_type(Some("IMAGE/PNG")));
        assert!(!super::is_image_content_type(None));
    }

    #[test]
    fn image_ref_formats_positional_placeholder() {
        assert_eq!(super::image_ref(1, Some(800), Some(600)), "[Image #1, 800x600]\n");
        assert_eq!(super::image_ref(2, None, None), "[Image #2]\n");
        assert_eq!(super::image_ref(3, Some(800), None), "[Image #3]\n");
        assert_eq!(super::image_ref(4, None, Some(600)), "[Image #4]\n");
        assert!(super::image_ref(1, None, None).ends_with('\n'));
    }

    #[test]
    fn compose_message_body_joins_and_trims() {
        assert_eq!(super::compose_message_body("hi", "[Image #1]\n"), "hi\n[Image #1]");
        assert_eq!(super::compose_message_body("", "[Image #1]\n"), "[Image #1]");
        assert_eq!(super::compose_message_body("hi", ""), "hi");
        assert_eq!(super::compose_message_body("hi", "   "), "hi");
    }
}
