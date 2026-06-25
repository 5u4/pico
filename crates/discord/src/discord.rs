use std::{sync::Arc, time::Duration};

use color_eyre::eyre::{WrapErr, bail, eyre};
use pico_core::{
    bindings::{Binding, BindingKind},
    cancel::CancelRegistry,
    config::StreamingBehavior,
    mid_turn::MidTurnQueue,
    omp::{camofox::CamofoxDaemon, pool::OmpPool},
    surface::ConversationId,
};
use pico_shared::proto;
use poise::serenity_prelude as serenity;
use tokio_util::{sync::CancellationToken, task::TaskTracker};

use crate::config::GuildDefault;

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
                    Ok(root_config) => {
                        let sched_db = db.clone();
                        let sched_cancel = cancel.clone();
                        let cfg = root_config.schedule();
                        tracker.spawn(async move {
                            pico_core::schedule::run(&sched_db, host, cfg, sched_cancel).await;
                        });
                    }
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
    let schedules = match pico_core::schedule::list(&ctx.data().db, "discord", &guild_id.to_string()).await {
        Ok(schedules) => schedules,
        Err(e) => {
            ctx.say(format!("error reading schedules: {e}")).await?;
            return Ok(());
        }
    };
    if schedules.is_empty() {
        ctx.say("No schedules for this server.").await?;
        return Ok(());
    }
    let mut body = String::from("📅 Schedules\n");
    for s in &schedules {
        body.push_str(&format!(
            "• `{}` {} [{}] — {} — next {}\n",
            s.id,
            s.name,
            schedule_state_label(s.state),
            s.trigger.describe(),
            s.next_run_at.to_rfc3339()
        ));
    }
    let body = pico_core::render::truncate(&pico_core::render::defang_mentions(&body), MSG_CONTENT_CAP);
    ctx.say(body).await?;
    Ok(())
}

fn schedule_state_label(state: pico_core::schedule::State) -> &'static str {
    match state {
        pico_core::schedule::State::Active => "active",
        pico_core::schedule::State::Disabled => "disabled",
        pico_core::schedule::State::Triggered => "triggered",
    }
}

#[poise::command(slash_command, rename = "cancel")]
async fn cancel_turn(ctx: Context<'_>) -> Result<(), Error> {
    if ctx
        .data()
        .cancels
        .request(&ConversationId::new("discord", &ctx.channel_id().to_string()))
    {
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

const MSG_CONTENT_CAP: usize = 1900;
const REPLY_BUDGET: usize = 1800;

fn render_reply(text: &str, as_reply: bool, silent: bool) -> Vec<(String, pico_core::surface::PostOpts)> {
    use pico_core::surface::PostOpts;
    let listed = pico_core::render::tables_to_lists(text);
    let chunks = pico_core::render::split_to_budget(&pico_core::render::defang_mentions(&listed), REPLY_BUDGET);
    chunks
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
    let wrapped = pico_core::prompt::wrap_discord_message(ctx.author().id.get(), &display_name, &sent_at, text);

    let conv = ConversationId::new("discord", &ctx.channel_id().to_string());
    match ctx.data().mid_turn.deliver(&conv, &wrapped, Some(mode)) {
        Some(resolved) => {
            let (emoji, label) = busy_label(resolved);
            let echo = format!("{emoji} `{label}` · {display_name}: {text}");
            ctx.say(pico_core::render::truncate(
                &pico_core::render::defang_mentions(&echo),
                MSG_CONTENT_CAP,
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

#[poise::command(slash_command, rename = "dev-deploy")]
async fn dev_deploy(ctx: Context<'_>) -> Result<(), Error> {
    let thread_id = ctx.channel_id().to_string();
    let Some(marker) = pico_core::thread_marker::load(&ctx.data().db, "discord", &thread_id).await else {
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
    if let Err(e) = update_repo(&repo).await {
        ctx.say(format!("❌ update failed: {e:#}")).await?;
        return Ok(());
    }
    build_and_deploy(ctx, repo, "latest origin/main").await
}

async fn request_deploy(
    socket: &std::path::Path,
    path: std::path::PathBuf,
    report_to: Option<String>,
) -> color_eyre::Result<proto::Response> {
    let stream = tokio::time::timeout(Duration::from_secs(5), tokio::net::UnixStream::connect(socket))
        .await
        .map_err(|_| eyre!("connecting to supervisor timed out"))?
        .wrap_err("connect to supervisor socket")?;
    let (read_half, mut write_half) = stream.into_split();
    proto::write_frame(&mut write_half, &proto::Request::Deploy { path, report_to }).await?;
    let mut reader = tokio::io::BufReader::new(read_half);
    tokio::time::timeout(Duration::from_secs(180), proto::read_frame::<proto::Response, _>(&mut reader))
        .await
        .map_err(|_| eyre!("deploy did not complete within 180s"))?
        .wrap_err("read deploy response")?
        .ok_or_else(|| eyre!("supervisor closed the connection without replying"))
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
    let bin = match build_worker(&build_dir).await {
        Ok(bin) => bin,
        Err(e) => {
            ctx.channel_id()
                .say(ctx.serenity_context(), format!("❌ build failed: {e:#}"))
                .await?;
            return Ok(());
        }
    };
    match request_deploy(&socket, bin, Some(report_to)).await {
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

static DEPLOY_BUILD_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

const BUILD_TIMEOUT: Duration = Duration::from_secs(30 * 60);

async fn build_worker(build_dir: &std::path::Path) -> color_eyre::Result<std::path::PathBuf> {
    let target_dir = pico_shared::paths::pico_build_target_dir()?;
    let _build = DEPLOY_BUILD_LOCK.lock().await;
    let child = tokio::process::Command::new("cargo")
        .args(["build", "--release", "-p", "pico-worker", "--target-dir"])
        .arg(&target_dir)
        .current_dir(build_dir)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .wrap_err("spawn cargo build")?;
    let out = match tokio::time::timeout(BUILD_TIMEOUT, child.wait_with_output()).await {
        Ok(res) => res.wrap_err("wait for cargo build")?,
        Err(_) => bail!("cargo build timed out after {}s", BUILD_TIMEOUT.as_secs()),
    };
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        let tail: String = stderr
            .chars()
            .rev()
            .take(1500)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect();
        bail!("cargo build failed ({}):\n{tail}", out.status);
    }
    install_cli(build_dir, &target_dir).await;
    bun_install_host(build_dir).await;
    snapshot(&target_dir).await
}

async fn install_cli(build_dir: &std::path::Path, target_dir: &std::path::Path) {
    let root = match pico_shared::paths::local_install_root() {
        Ok(root) => root,
        Err(e) => {
            tracing::warn!(error = %format!("{e:#}"), "cannot resolve local install root; skipping pico CLI install");
            return;
        }
    };
    let child = tokio::process::Command::new("cargo")
        .args(["install", "--locked", "--path"])
        .arg(build_dir.join("crates").join("cli"))
        .arg("--root")
        .arg(&root)
        .arg("--target-dir")
        .arg(target_dir)
        .arg("--force")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true)
        .spawn();
    let child = match child {
        Ok(child) => child,
        Err(e) => {
            tracing::warn!(error = %e, "spawning `cargo install` for pico CLI failed; schedule extension may not find pico");
            return;
        }
    };
    match tokio::time::timeout(BUILD_TIMEOUT, child.wait_with_output()).await {
        Ok(Ok(out)) if out.status.success() => tracing::info!("pico CLI install ok"),
        Ok(Ok(out)) => {
            let stderr = String::from_utf8_lossy(&out.stderr);
            tracing::warn!(status = %out.status, %stderr, "pico CLI `cargo install` failed; schedule extension may not find pico");
        }
        Ok(Err(e)) => tracing::warn!(error = %e, "waiting on pico CLI `cargo install` failed"),
        Err(_) => tracing::warn!("pico CLI `cargo install` timed out"),
    }
}

async fn bun_install_host(build_dir: &std::path::Path) {
    let host_dir = build_dir.join("omp-host");
    let child = tokio::process::Command::new("bun")
        .arg("install")
        .current_dir(&host_dir)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true)
        .spawn();
    let child = match child {
        Ok(child) => child,
        Err(e) => {
            tracing::warn!(error = %e, dir = %host_dir.display(), "spawning `bun install` for omp-host failed; keeping existing node_modules");
            return;
        }
    };
    match tokio::time::timeout(BUILD_TIMEOUT, child.wait_with_output()).await {
        Ok(Ok(out)) if out.status.success() => tracing::info!("omp-host `bun install` ok"),
        Ok(Ok(out)) => {
            let stderr = String::from_utf8_lossy(&out.stderr);
            tracing::warn!(status = %out.status, %stderr, "omp-host `bun install` failed; keeping existing node_modules");
        }
        Ok(Err(e)) => {
            tracing::warn!(error = %e, "waiting on omp-host `bun install` failed; keeping existing node_modules")
        }
        Err(_) => tracing::warn!("omp-host `bun install` timed out; keeping existing node_modules"),
    }
}

async fn snapshot(target_dir: &std::path::Path) -> color_eyre::Result<std::path::PathBuf> {
    let staging = target_dir.with_file_name("pico-deploy-staging");
    prune_staging(&staging).await;
    let id = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)?
        .as_nanos();
    let dir = staging.join(id.to_string());
    tokio::fs::create_dir_all(&dir).await?;
    let dest = dir.join("pico-worker");
    tokio::fs::copy(target_dir.join("release").join("pico-worker"), &dest)
        .await
        .wrap_err("snapshot built worker")?;
    Ok(dest)
}

async fn prune_staging(staging: &std::path::Path) {
    let Ok(mut entries) = tokio::fs::read_dir(staging).await else {
        return;
    };
    let cutoff = std::time::SystemTime::now() - Duration::from_secs(3600);
    while let Ok(Some(entry)) = entries.next_entry().await {
        let stale = entry
            .metadata()
            .await
            .ok()
            .and_then(|m| m.modified().ok())
            .is_some_and(|m| m < cutoff);
        if stale {
            let _ = tokio::fs::remove_dir_all(entry.path()).await;
        }
    }
}

async fn update_repo(repo: &std::path::Path) -> color_eyre::Result<()> {
    if !repo.join(".git").exists() {
        bail!("{} is not a git checkout", repo.display());
    }
    pico_core::worktree::run_git(repo, ["fetch", "origin"], Duration::from_secs(120)).await?;
    pico_core::worktree::run_git(repo, ["reset", "--hard", "origin/main"], Duration::from_secs(30)).await?;
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
        "discord",
        &channel.to_string(),
        &profile,
        std::path::Path::new(&cwd),
    )
    .await
    {
        Ok(()) => {
            ctx.say(format!("bound <#{channel}> → profile `{profile}`, cwd `{cwd}`"))
                .await?;
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
    let base_path = pico_shared::paths::expand_home(&base_repo);
    if let Err(e) = pico_core::worktree::validate_base_repo(&base_path, &branch).await {
        ctx.say(format!("not a usable worktree base: {e}")).await?;
        return Ok(());
    }
    match pico_core::bindings::set_worktree(&data.db, "discord", &channel.to_string(), &profile, &base_path, &branch)
        .await
    {
        Ok(()) => {
            ctx.say(format!(
                "bound <#{channel}> → worktree profile `{profile}`, base `{base_repo}`, branch `{branch}`"
            ))
            .await?;
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
    match pico_core::bindings::unset(&data.db, "discord", &channel.to_string()).await {
        Ok(true) => {
            ctx.say(format!("unbound <#{channel}>")).await?;
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
    let reply = match pico_core::bindings::get(&data.db, "discord", &channel.to_string()).await {
        Ok(Some(b)) => match &b.kind {
            BindingKind::Regular { cwd } => {
                format!("<#{channel}> → profile `{}`, cwd `{}`", b.profile, cwd.display())
            }
            BindingKind::Worktree {
                base_repo,
                default_branch,
            } => format!(
                "<#{channel}> → worktree profile `{}`, base `{}`, branch `{}`",
                b.profile,
                base_repo.display(),
                default_branch
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

    let marker = match pico_core::thread_marker::load(&data.db, "discord", &thread_id).await {
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
    let worktree_path = marker.cwd.clone();

    let loss = match pico_core::worktree::close_would_lose(&base_repo, &worktree_path, &thread_id).await {
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

    if let Err(e) = pico_core::worktree::remove(&base_repo, &worktree_path, &thread_id).await {
        ctx.say(format!("❌ teardown failed: {e}")).await?;
        return Ok(());
    }

    let closed_at = serenity::Timestamp::now().to_string();
    if let Err(e) = pico_core::thread_marker::tombstone(&data.db, "discord", &thread_id, marker, closed_at).await {
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
            format!("✅ Worktree thread closed. Removed worktree and branch `pico/{thread_id}`. Conversation history preserved."),
        )
        .await;
    let _ = ctx.say("Closed.").await;
    if let Err(e) = channel
        .edit_thread(ctx.serenity_context(), serenity::EditThread::new().archived(true).locked(true))
        .await
    {
        tracing::warn!(%thread_id, error = %e, "archive+lock after close failed");
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
                tracing::warn!(error = %format!("{e:#}"), "message turn failed");
            }
        });
    }
    Ok(())
}

pub(crate) enum Route {
    Regular {
        profile: String,
        cwd: std::path::PathBuf,
    },
    Worktree {
        profile: String,
        base_repo: std::path::PathBuf,
        default_branch: String,
    },
}

pub(crate) fn resolve_route(guild_default: &GuildDefault, binding: Option<&Binding>) -> Route {
    match binding {
        Some(b) => match &b.kind {
            BindingKind::Regular { cwd } => Route::Regular {
                profile: b.profile.clone(),
                cwd: cwd.clone(),
            },
            BindingKind::Worktree {
                base_repo,
                default_branch,
            } => Route::Worktree {
                profile: b.profile.clone(),
                base_repo: base_repo.clone(),
                default_branch: default_branch.clone(),
            },
        },
        None => Route::Regular {
            profile: guild_default.profile.clone(),
            cwd: guild_default.cwd.clone(),
        },
    }
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
    if prompt.is_empty() {
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
    let wrapped = pico_core::prompt::wrap_discord_message(message.author.id.get(), &display_name, &sent_at, prompt);

    if in_thread
        && let Some(mode) = mid_turn.deliver(&ConversationId::new("discord", &channel.id.to_string()), &wrapped, None)
    {
        react_queued(&ctx, &message, mode).await;
        return Ok(());
    }

    let binding = pico_core::bindings::get(&db, "discord", &bound_channel.to_string()).await?;
    let route = resolve_route(guild_default, binding.as_ref());

    if !in_thread
        && let Route::Regular { cwd, .. } = &route
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

    let target = if in_thread {
        channel.id
    } else {
        match bound_channel
            .create_thread_from_message(&ctx, message.id, serenity::CreateThread::new(thread_name(prompt)))
            .await
        {
            Ok(thread) => thread.id,
            Err(e) if is_thread_already_created(&e) => serenity::ChannelId::new(message.id.get()),
            Err(e) => return Err(e).wrap_err("create thread from message"),
        }
    };
    let thread_id = target.to_string();

    let (profile, cwd, worktree_origin) = match pico_core::thread_marker::load(&db, "discord", &thread_id).await {
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
                if let Err(e) =
                    pico_core::worktree::ensure_at(&marker.cwd, &thread_id, &wt.base_repo, &wt.default_branch).await
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
                Route::Regular { profile, cwd } => {
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
                Route::Worktree {
                    profile,
                    base_repo,
                    default_branch,
                } => {
                    let worktrees_dir = root_config
                        .worktrees_dir()
                        .map(std::path::Path::to_path_buf)
                        .unwrap_or_else(|| pico_shared::paths::default_worktrees_dir(root.as_path()));
                    match pico_core::worktree::ensure(
                        &worktrees_dir,
                        &bound_channel.to_string(),
                        &thread_id,
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
                "discord",
                &thread_id,
                &pico_core::thread_marker::ThreadMarker {
                    profile: profile.clone(),
                    cwd: cwd.clone(),
                    worktree: worktree.clone(),
                    closed_at: None,
                },
            )
            .await;
            (profile, cwd, worktree)
        }
    };
    tracing::info!(%thread_id, %profile, in_thread, "driving omp turn");

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
            trigger: in_thread.then_some(message.id),
            author: message.author.id,
            guild_id,
            guild_name,
            bound_channel,
            channel_name,
            thread_label,
            render: discord_config.render(),
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
    pub(crate) trigger: Option<serenity::MessageId>,
    pub(crate) author: serenity::UserId,
    pub(crate) guild_id: serenity::GuildId,
    pub(crate) guild_name: Option<String>,
    pub(crate) bound_channel: serenity::ChannelId,
    pub(crate) channel_name: Option<String>,
    pub(crate) thread_label: String,
    pub(crate) render: crate::config::Render,
}

pub(crate) struct TurnSpawn {
    pub(crate) handle: Arc<pico_core::omp::pool::ThreadHandle>,
    pub(crate) title_seed: Option<String>,
    pub(crate) result: color_eyre::Result<pico_core::engine::TurnOutcome>,
}

fn latest_session_file(session_dir: &std::path::Path) -> Option<std::path::PathBuf> {
    let mut newest: Option<(std::time::SystemTime, std::path::PathBuf)> = None;
    for entry in std::fs::read_dir(session_dir).ok()?.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
            continue;
        }
        let Ok(modified) = entry.metadata().and_then(|m| m.modified()) else {
            continue;
        };
        let replace = match &newest {
            Some((latest, _)) => modified > *latest,
            None => true,
        };
        if replace {
            newest = Some((modified, path));
        }
    }
    newest.map(|(_, path)| path)
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
) -> color_eyre::Result<TurnSpawn> {
    let TurnInputs {
        thread_id,
        target,
        profile,
        cwd,
        worktree_origin,
        wrapped,
        trigger,
        author,
        guild_id,
        guild_name,
        bound_channel,
        channel_name,
        thread_label,
        render,
    } = inputs;

    let session_dir = pico_shared::paths::profile_session_dir(root, &profile, &thread_id);
    std::fs::create_dir_all(&session_dir).wrap_err_with(|| format!("create session dir {}", session_dir.display()))?;
    let identity = pico_shared::paths::profile_identity(root, &profile);
    let append_dest = session_dir.join("append.md");
    let context_block = pico_core::prompt::runtime_context_block(&pico_core::prompt::RuntimeContext {
        guild: (guild_id.get(), guild_name.as_deref()),
        channel: (bound_channel.get(), channel_name.as_deref()),
        thread: (target.get(), &thread_label),
        profile: &profile,
        cwd: &cwd,
        worktree: worktree_origin
            .as_ref()
            .map(|w| (w.base_repo.as_path(), w.default_branch.as_str())),
    });
    let append_prompt = match pico_core::prompt::assemble_append(
        &append_dest,
        identity.is_file().then_some(identity.as_path()),
        &context_block,
    ) {
        Ok(path) => Some(path),
        Err(e) => {
            tracing::warn!(error = %format!("{e:#}"), "assembling pico append prompt failed; spawning omp without it");
            None
        }
    };
    let profile_config = pico_core::config::load(&pico_shared::paths::profile_config(root, &profile))?;
    if profile_config.browser_enabled {
        camofox.ensure_started().await;
    }
    let continue_from_file = latest_session_file(&session_dir);
    let config = pico_core::omp::client::SessionConfig {
        model: profile_config.model,
        cwd,
        session_dir,
        continue_from_file,
        append_system_prompt: append_prompt,
        identity: pico_core::omp::client::SessionIdentity {
            platform: "discord".to_owned(),
            guild: guild_id.get().to_string(),
            channel: bound_channel.get().to_string(),
            thread: thread_id.clone(),
            user: author.get().to_string(),
        },
    };

    let handle = pool.get_or_spawn(&thread_id, &config).await?;
    let mut title_seed: Option<String> = None;
    let conversation = ConversationId::new("discord", &thread_id);
    let result = {
        let mut session = handle.lock().await;
        let surface = DiscordSurface {
            ctx: ctx.clone(),
            channel: target,
            trigger,
            author,
            pending: pending_answers.clone(),
            cancel: cancel.clone(),
        };
        let req = pico_core::engine::TurnRequest {
            conversation: &conversation,
            prompt: wrapped,
            surface_thinking: render.surface_thinking,
            mode: render.streaming_behavior,
            cancel,
        };
        let rt = pico_core::engine::TurnRuntime { mid_turn, cancels };
        pico_core::engine::drive_turn(&surface, &mut session, req, rt, &mut title_seed).await
    };
    Ok(TurnSpawn {
        handle,
        title_seed,
        result,
    })
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
        tracing::warn!(error = %e, "mid-turn ack reaction failed");
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
        pico_core::surface::SizeLimits {
            activity_line_cap: 20,
            activity_char_cap: 1800,
            activity_send_max: 1990,
        }
    }

    fn tool_activity_line(&self, call: &pico_core::omp::protocol::ToolCall) -> Option<String> {
        Some(crate::activity::tool_activity_line(&crate::activity::ToolCallStart::from(call)))
    }

    fn thinking_line(&self, content: &str) -> Option<String> {
        let line = crate::activity::thinking_line(content);
        (!line.is_empty()).then_some(line)
    }

    fn failure_line(&self, current: &str, error: Option<&str>) -> String {
        crate::activity::failure_line(current, error)
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
                tracing::warn!(error = %e, "surface post failed");
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
                tracing::warn!(error = %e, "surface edit failed");
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
        match super::resolve_route(&d, Some(&b)) {
            super::Route::Regular { profile, cwd } => {
                assert_eq!(profile, "sen");
                assert_eq!(cwd, PathBuf::from("/work"));
            }
            _ => panic!("expected regular route"),
        }
    }

    #[test]
    fn unbound_channel_uses_guild_default() {
        let d = guild_default("default", "/default");
        match super::resolve_route(&d, None) {
            super::Route::Regular { profile, cwd } => {
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
            },
        };
        match super::resolve_route(&d, Some(&b)) {
            super::Route::Worktree {
                profile,
                base_repo,
                default_branch,
            } => {
                assert_eq!(profile, "sen");
                assert_eq!(base_repo, PathBuf::from("/repo"));
                assert_eq!(default_branch, "trunk");
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
            assert!(chunk.chars().count() <= super::REPLY_BUDGET);
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
}
