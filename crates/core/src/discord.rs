use std::{
    sync::Arc,
    time::{Duration, Instant},
};

use color_eyre::eyre::{WrapErr, eyre};
use pico_shared::proto;
use poise::serenity_prelude as serenity;
use tokio_util::{sync::CancellationToken, task::TaskTracker};

use crate::{
    bindings::Bindings,
    omp::{
        pool::{OmpPool, ThreadSession},
        protocol::{AssistantMessageEvent, OmpEvent, ToolCall, ToolCallEnd, ToolCallStart, ToolCallUpdate},
    },
};

pub(crate) struct Data {
    root: Arc<std::path::PathBuf>,
    bindings: Arc<parking_lot::Mutex<Bindings>>,
    pool: Arc<OmpPool>,
    cancel: CancellationToken,
    tracker: TaskTracker,
    supervisor_socket: Option<std::path::PathBuf>,
}

pub(crate) type Error = Box<dyn std::error::Error + Send + Sync>;
type Context<'a> = poise::Context<'a, Data, Error>;

/// Build the poise framework. The setup closure runs once on the gateway's
/// first `Ready`, so firing `ready_tx` there is the authoritative "connected"
/// signal the worker waits on before reporting ready to the supervisor.
pub(crate) fn framework(
    root: std::path::PathBuf,
    bindings: Bindings,
    pool: Arc<OmpPool>,
    ready_tx: tokio::sync::oneshot::Sender<()>,
    supervisor_socket: Option<std::path::PathBuf>,
    cancel: CancellationToken,
    tracker: TaskTracker,
) -> poise::Framework<Data, Error> {
    poise::Framework::builder()
        .options(poise::FrameworkOptions {
            commands: vec![ping(), bind(), deploy()],
            event_handler: |ctx, event, framework, data| Box::pin(on_event(ctx, event, framework.bot_id, data)),
            command_check: Some(|ctx| Box::pin(command_in_registered_guild(ctx))),
            ..Default::default()
        })
        .setup(move |ctx, _ready, framework| {
            Box::pin(async move {
                poise::builtins::register_globally(ctx, &framework.options().commands).await?;
                let _ = ready_tx.send(());
                Ok(Data {
                    root: Arc::new(root),
                    bindings: Arc::new(parking_lot::Mutex::new(bindings)),
                    pool,
                    supervisor_socket,
                    cancel,
                    tracker,
                })
            })
        })
        .build()
}

/// Global command gate: slash commands run only inside a configured guild (no
/// per-user ACL yet). A DM or unregistered guild gets a one-line refusal and the
/// command is skipped.
async fn command_in_registered_guild(ctx: Context<'_>) -> Result<bool, Error> {
    let Some(guild_id) = ctx.guild_id() else {
        ctx.say("Commands only work inside a configured server.").await?;
        return Ok(false);
    };
    let root_config = match crate::config::load_root(&pico_shared::paths::worker_config(&ctx.data().root)) {
        Ok(config) => config,
        Err(e) => {
            ctx.say(format!("config error: {e}")).await?;
            return Ok(false);
        }
    };
    if root_config.guild(&guild_id.to_string()).is_some() {
        Ok(true)
    } else {
        ctx.say("This server isn't configured, so I can't run commands here.")
            .await?;
        Ok(false)
    }
}

/// Liveness check — replies "Pong!".
#[poise::command(slash_command)]
async fn ping(ctx: Context<'_>) -> Result<(), Error> {
    ctx.say("Pong!").await?;
    Ok(())
}

#[poise::command(slash_command)]
async fn deploy(
    ctx: Context<'_>,
    #[description = "path to a prebuilt worker binary on the host"] path: String,
) -> Result<(), Error> {
    let Some(socket) = ctx.data().supervisor_socket.clone() else {
        ctx.say("not running under a supervisor (standalone) — `/deploy` is unavailable")
            .await?;
        return Ok(());
    };
    ctx.say(format!("deploying `{path}` — I'll post the result here when it lands."))
        .await?;
    let report_to = ctx.channel_id().get().to_string();
    match request_deploy(&socket, std::path::PathBuf::from(&path), Some(report_to)).await {
        Ok(proto::Response::Ok { detail }) => {
            // Unreachable on a self-deploy (it kills me first); if it lands, the
            // new worker's relay already posted the outcome — don't double-post.
            tracing::info!(%detail, "deploy ok; outcome relayed to channel");
        }
        Ok(proto::Response::Error { message }) => {
            // Pre-kill failure (bad path / staging): no relay, so report it myself.
            ctx.say(format!("deploy failed: {message}")).await?;
        }
        Ok(proto::Response::Status(_)) => {
            ctx.say("deploy returned an unexpected status reply").await?;
        }
        Err(e) => {
            ctx.say(format!("deploy outcome unknown: {e}")).await?;
        }
    }
    Ok(())
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
    // Fixed: the worker can't see the supervisor's health_timeout to derive one.
    tokio::time::timeout(Duration::from_secs(180), proto::read_frame::<proto::Response, _>(&mut reader))
        .await
        .map_err(|_| eyre!("deploy did not complete within 180s"))?
        .wrap_err("read deploy response")?
        .ok_or_else(|| eyre!("supervisor closed the connection without replying"))
}

/// Post a relayed deploy outcome to the channel it was initiated from.
/// Best-effort: a bad id or a failed send is logged, not propagated.
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

#[poise::command(
    slash_command,
    subcommands("bind_set", "bind_unset", "bind_show"),
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
    let profile = profile.unwrap_or_else(|| pico_shared::paths::DEFAULT_WORKER.to_owned());
    if !pico_shared::paths::profile_dir(&data.root, &profile).is_dir() {
        ctx.say(format!("profile `{profile}` does not exist under this root"))
            .await?;
        return Ok(());
    }
    let path = pico_shared::paths::worker_bindings(&data.root);
    match crate::bindings::set(&path, &channel.to_string(), &profile, std::path::Path::new(&cwd)) {
        Ok(()) => match crate::bindings::load(&path) {
            Ok(reloaded) => {
                *data.bindings.lock() = reloaded;
                ctx.say(format!("bound <#{channel}> → profile `{profile}`, cwd `{cwd}`"))
                    .await?;
            }
            Err(e) => {
                ctx.say(format!("written to disk, but reload failed: {e}")).await?;
            }
        },
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
    let path = pico_shared::paths::worker_bindings(&data.root);
    match crate::bindings::unset(&path, &channel.to_string()) {
        Ok(true) => match crate::bindings::load(&path) {
            Ok(reloaded) => {
                *data.bindings.lock() = reloaded;
                ctx.say(format!("unbound <#{channel}>")).await?;
            }
            Err(e) => {
                ctx.say(format!("removed from disk, but reload failed: {e}")).await?;
            }
        },
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
    let reply = {
        let bindings = data.bindings.lock();
        match bindings.get(&channel.to_string()) {
            Some(b) => format!("<#{channel}> → profile `{}`, cwd `{}`", b.profile, b.cwd.display()),
            None => "this channel is not bound".to_owned(),
        }
    };
    ctx.say(reply).await?;
    Ok(())
}

/// The channel a `/bind` invocation targets: a thread binds its parent channel
/// (per the routing invariant that only parent channels carry bindings), every
/// other channel binds itself.
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
        // Drive the (potentially long) turn off the gateway task so it never
        // stalls event dispatch; per-thread serialisation lives in the pool.
        let ctx = ctx.clone();
        let root = Arc::clone(&data.root);
        let bindings = Arc::clone(&data.bindings);
        let pool = Arc::clone(&data.pool);
        let cancel = data.cancel.clone();
        let message = new_message.clone();
        data.tracker.spawn(async move {
            if let Err(e) = route_message(ctx, root, bindings, pool, cancel, message).await {
                tracing::warn!(error = %format!("{e:#}"), "message turn failed");
            }
        });
    }
    Ok(())
}

/// Pick the `(profile, cwd)` for a message in a served guild: a binding wins;
/// otherwise the guild's default serves the unbound channel. Guild registration
/// is gated earlier in `route_message`, before any channel fetch.
fn resolve_route(
    guild_default: &crate::config::GuildDefault,
    binding: Option<&crate::bindings::Binding>,
) -> (String, std::path::PathBuf) {
    match binding {
        Some(b) => (b.profile.clone(), b.cwd.clone()),
        None => (guild_default.profile.clone(), guild_default.cwd.clone()),
    }
}

async fn route_message(
    ctx: serenity::Context,
    root: Arc<std::path::PathBuf>,
    bindings: Arc<parking_lot::Mutex<Bindings>>,
    pool: Arc<OmpPool>,
    cancel: CancellationToken,
    message: serenity::Message,
) -> color_eyre::Result<()> {
    let prompt = message.content.trim();
    if prompt.is_empty() {
        return Ok(());
    }

    // DMs carry no `guild_id` and are never served.
    let Some(guild_id) = message.guild_id else {
        return Ok(());
    };
    // A broken config can't tell us whether this guild is served, so surface it
    // in-channel rather than dropping every message into the logs.
    let root_config = match crate::config::load_root(&pico_shared::paths::worker_config(&root)) {
        Ok(config) => config,
        Err(e) => {
            message.reply(&ctx, format!("❌ worker config error: {e}")).await?;
            return Ok(());
        }
    };

    // Registration gates everything (a binding in an unregistered guild is not
    // served), checked before the channel fetch so an unserved guild costs nothing.
    let Some(guild_default) = root_config.guild(&guild_id.to_string()) else {
        tracing::debug!(%guild_id, "guild not configured; ignoring message");
        return Ok(());
    };

    let serenity::Channel::Guild(channel) = message.channel_id.to_channel(&ctx).await? else {
        return Ok(());
    };
    // A thread routes via its parent channel's binding; the thread itself is the
    // session. A top-level message opens a fresh thread.
    let in_thread = is_thread(channel.kind);
    let bound_channel = if in_thread {
        match channel.parent_id {
            Some(parent) => parent,
            None => return Ok(()),
        }
    } else {
        channel.id
    };

    let (profile, cwd) = {
        let table = bindings.lock();
        resolve_route(guild_default, table.get(&bound_channel.to_string()))
    };

    // cwd was valid when configured/bound but may have been torn down since (host
    // rebuild); tell the user in-channel instead of failing the omp spawn to logs.
    if !cwd.is_dir() {
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
        bound_channel
            .create_thread_from_message(&ctx, message.id, serenity::CreateThread::new(thread_name(prompt)))
            .await?
            .id
    };
    let thread_id = target.to_string();
    tracing::info!(%thread_id, %profile, in_thread, "driving omp turn");

    let session_dir = pico_shared::paths::profile_session_dir(&root, &profile, &thread_id);
    std::fs::create_dir_all(&session_dir).wrap_err_with(|| format!("create session dir {}", session_dir.display()))?;
    let identity = pico_shared::paths::profile_identity(&root, &profile);
    let profile_config = crate::config::load(&pico_shared::paths::profile_config(&root, &profile))?;
    let config = crate::omp::client::SpawnConfig {
        model: profile_config.model,
        cwd: Some(cwd),
        session_dir: Some(session_dir),
        continue_session: true,
        append_system_prompt: identity.is_file().then_some(identity),
    };

    let handle = pool.get_or_spawn(&thread_id, &config).await?;
    let outcome = {
        let mut session = handle.lock().await;
        drive_turn(
            &ctx,
            target,
            &mut session,
            prompt,
            &cancel,
            profile_config.surface_thinking,
            in_thread.then_some(message.id),
            message.author.id,
        )
        .await?
    };
    if outcome == TurnOutcome::Dead {
        pool.forget(&thread_id);
    }
    Ok(())
}

/// Whether the `omp` child survived the turn; `Dead` (event stream closed) tells the caller to drop it from the pool.
#[derive(PartialEq, Eq)]
enum TurnOutcome {
    Live,
    Dead,
}

/// Longest an OMP turn may legitimately stay silent: above the 3600s cap OMP
/// enforces on its slowest tools (bash/eval/ssh), so a silent max-timeout command
/// never trips it, yet a turn wedged on an interaction this build can't answer
/// can't hang the thread forever.
const STALL_TIMEOUT: Duration = Duration::from_secs(3900);

/// Drive one OMP turn: render tool-call/reasoning activity as silent messages,
/// then post the buffered answer — only text not followed by a tool survives.
#[allow(clippy::too_many_arguments)]
async fn drive_turn(
    ctx: &serenity::Context,
    target: serenity::ChannelId,
    session: &mut ThreadSession,
    prompt: &str,
    cancel: &CancellationToken,
    surface_thinking: bool,
    reply_to: Option<serenity::MessageId>,
    author: serenity::UserId,
) -> color_eyre::Result<TurnOutcome> {
    let _typing = target.start_typing(&ctx.http);
    session.client.prompt(prompt).await?;

    let mut reply = String::new();
    let mut activity = Activity::new(ctx, target);
    let mut subagents = SubagentFeed::new(ctx, target);

    loop {
        let event = tokio::select! {
            () = cancel.cancelled() => {
                activity.flush().await;
                subagents.flush_all(false).await;
                commit_reply(ctx, target, &reply, reply_to).await;
                let _ = target
                    .say(ctx, "worker is restarting; resend your message to continue")
                    .await;
                return Ok(TurnOutcome::Live);
            }
            recv = tokio::time::timeout(STALL_TIMEOUT, session.events.recv()) => match recv {
                Ok(event) => event,
                // Wedged past any legitimate silent gap: drop the child so the pool
                // respawns a fresh one instead of holding the thread until a deploy.
                Err(_) => {
                    tracing::warn!(timeout = ?STALL_TIMEOUT, "turn made no progress; resetting wedged OMP session");
                    activity.flush().await;
                    subagents.flush_all(true).await;
                    commit_reply(ctx, target, &reply, reply_to).await;
                    let _ = target
                        .say(ctx, "the turn stalled with no progress and was reset; resend your message to continue")
                        .await;
                    return Ok(TurnOutcome::Dead);
                }
            },
        };
        match event {
            Some(OmpEvent::Message(AssistantMessageEvent::TextDelta { delta })) => {
                reply.push_str(&delta);
            }
            Some(OmpEvent::Message(AssistantMessageEvent::ThinkingEnd { content })) => {
                if surface_thinking {
                    activity.thinking(&content).await;
                }
            }
            // A tool call means the text so far was preamble, not the answer.
            Some(OmpEvent::ToolStart(tool)) => {
                reply.clear();
                match &tool {
                    ToolCallStart::Task(call) => subagents.start(call).await,
                    // `ask` renders via its UI request below, not the activity feed.
                    ToolCallStart::Ask(_) => {}
                    _ => activity.start(&tool).await,
                }
            }
            Some(OmpEvent::ToolUpdate(tool)) => {
                if tool.tool_name == "task" {
                    subagents.update(&tool).await;
                }
            }
            Some(OmpEvent::ToolEnd(tool)) => match tool.tool_name.as_str() {
                "task" => subagents.end(&tool).await,
                "ask" => {}
                _ => activity.end(&tool).await,
            },
            Some(OmpEvent::UiRequest(req)) => {
                // Block the turn on the answer (the agent is paused awaiting it);
                // `handle_request` races `cancel`, so a restart never strands the turn.
                activity.flush().await;
                if let crate::ui::Handled::Cancelled =
                    crate::ui::handle_request(ctx, target, &session.client, author, &req, cancel).await
                {
                    subagents.flush_all(false).await;
                    commit_reply(ctx, target, &reply, reply_to).await;
                    let _ = target
                        .say(ctx, "worker is restarting; resend your message to continue")
                        .await;
                    return Ok(TurnOutcome::Live);
                }
            }
            Some(OmpEvent::AgentEnd) => break,
            Some(OmpEvent::Error(e)) => {
                activity.flush().await;
                subagents.flush_all(true).await;
                let _ = target.say(ctx, format!("OMP error: {e}")).await;
                return Ok(TurnOutcome::Live);
            }
            // No `_`: listing the inert variants keeps the match exhaustive, so
            // a new `OmpEvent` is a compile error here, not a silent drop.
            Some(OmpEvent::AgentStart | OmpEvent::Message(AssistantMessageEvent::Other)) => {}
            // Stream closed: the child died mid-turn — flush, notify, and report it dead so the pool respawns it.
            None => {
                activity.flush().await;
                subagents.flush_all(true).await;
                commit_reply(ctx, target, &reply, reply_to).await;
                let _ = target
                    .say(ctx, "the OMP session ended unexpectedly; send another message to restart it")
                    .await;
                return Ok(TurnOutcome::Dead);
            }
        }
    }
    activity.flush().await;
    subagents.flush_all(false).await;
    commit_reply(ctx, target, &reply, reply_to).await;
    Ok(TurnOutcome::Live)
}

/// Post the buffered answer at turn end, split to budget; the first chunk pings,
/// follow-on chunks are silent. Blank/tool-only turns post nothing.
async fn commit_reply(
    ctx: &serenity::Context,
    target: serenity::ChannelId,
    reply: &str,
    reply_to: Option<serenity::MessageId>,
) {
    let listed = crate::render::tables_to_lists(reply);
    let chunks =
        crate::render::split_to_budget(&crate::render::defang_mentions(&listed), crate::render::DISCORD_BUDGET);
    for (i, chunk) in chunks.iter().enumerate() {
        let mut message = serenity::CreateMessage::new().content(chunk.clone());
        if i == 0 {
            if let Some(msg_id) = reply_to {
                // fail_if_not_exists(false): a deleted trigger degrades to a plain message, not a rejected send.
                let reference = serenity::MessageReference::from((target, msg_id)).fail_if_not_exists(false);
                message = message.reference_message(reference);
            }
        } else {
            message = message.flags(serenity::MessageFlags::SUPPRESS_NOTIFICATIONS);
        }
        if let Err(e) = target.send_message(ctx, message).await {
            tracing::warn!(error = %e, "reply send failed");
        }
    }
}

const ACTIVITY_THROTTLE: Duration = Duration::from_secs(1);
/// Hard ceiling on the actually-sent activity text, just under Discord's 2000-
/// char limit. The rollover caps budget *raw* lines, but defang expansion and
/// in-place failure-line rewrites can inflate the sent text past them, and an
/// over-limit edit would 400 on every retry.
const ACTIVITY_SEND_MAX: usize = 1990;

/// A turn's coalesced tool-call + reasoning feed: one line per event in a silent
/// message, edited in place (throttled) and rolled over at the activity caps.
struct Activity<'a> {
    ctx: &'a serenity::Context,
    channel: serenity::ChannelId,
    hosts: Vec<ActivityHost>,
    /// tool_call_id → (host index, line index), so a tool's failure can rewrite
    /// the exact line it started.
    placements: std::collections::HashMap<String, (usize, usize)>,
    last_edit: Instant,
}

struct ActivityHost {
    message: serenity::Message,
    lines: Vec<String>,
    /// Last text actually sent (mention-defanged), so an unchanged flush no-ops.
    rendered: String,
    dirty: bool,
}

impl ActivityHost {
    /// Lines joined, mention-defanged so tool args / thinking can't ping, and
    /// clamped to [`ACTIVITY_SEND_MAX`] so an inflated host can't exceed the
    /// hard message limit.
    fn text(&self) -> String {
        let body = crate::render::defang_mentions(&self.lines.join("\n"));
        if body.chars().count() <= ACTIVITY_SEND_MAX {
            return body;
        }
        body.chars().take(ACTIVITY_SEND_MAX).collect()
    }

    fn char_count(&self) -> usize {
        let body: usize = self.lines.iter().map(|l| l.chars().count()).sum();
        body + self.lines.len().saturating_sub(1)
    }
}

impl<'a> Activity<'a> {
    fn new(ctx: &'a serenity::Context, channel: serenity::ChannelId) -> Self {
        Activity {
            ctx,
            channel,
            hosts: Vec::new(),
            placements: std::collections::HashMap::new(),
            last_edit: Instant::now(),
        }
    }

    async fn start(&mut self, tool: &ToolCallStart) {
        let line = crate::render::tool_activity_line(tool);
        if let Some(placement) = self.append(line).await {
            self.placements.insert(tool.call().tool_call_id.clone(), placement);
        }
    }

    async fn thinking(&mut self, content: &str) {
        let line = crate::render::thinking_line(content);
        if !line.is_empty() {
            self.append(line).await;
        }
    }

    async fn end(&mut self, tool: &ToolCallEnd) {
        let Some((host_idx, line_idx)) = self.placements.remove(&tool.tool_call_id) else {
            return;
        };
        if !tool.is_error {
            return;
        }
        let error = crate::render::error_text(&tool.result);
        let Some(host) = self.hosts.get_mut(host_idx) else {
            return;
        };
        let Some(current) = host.lines.get(line_idx) else {
            return;
        };
        let next = crate::render::with_failure_line(current, error.as_deref());
        if next == *current {
            return;
        }
        host.lines[line_idx] = next;
        host.dirty = true;
        self.maybe_flush().await;
    }

    async fn append(&mut self, line: String) -> Option<(usize, usize)> {
        let rollover = match self.hosts.last() {
            None => true,
            Some(host) => {
                let count = host.lines.len();
                let projected = host.char_count() + line.chars().count() + usize::from(count > 0);
                count + 1 > crate::render::ACTIVITY_LINE_CAP || projected > crate::render::ACTIVITY_CHAR_CAP
            }
        };
        if rollover {
            let sent = crate::render::defang_mentions(&line);
            let message = self.post(&sent).await?;
            self.hosts.push(ActivityHost {
                message,
                lines: vec![line],
                rendered: sent,
                dirty: false,
            });
            self.last_edit = Instant::now();
            return Some((self.hosts.len() - 1, 0));
        }
        let host_idx = self.hosts.len() - 1;
        let line_idx = {
            let host = self.hosts.last_mut().expect("host present when not rolling over");
            let idx = host.lines.len();
            host.lines.push(line);
            host.dirty = true;
            idx
        };
        self.maybe_flush().await;
        Some((host_idx, line_idx))
    }

    async fn post(&self, content: &str) -> Option<serenity::Message> {
        let message = serenity::CreateMessage::new()
            .content(content.to_string())
            .flags(serenity::MessageFlags::SUPPRESS_NOTIFICATIONS);
        match self.channel.send_message(self.ctx, message).await {
            Ok(message) => Some(message),
            Err(e) => {
                tracing::warn!(error = %e, "activity send failed");
                None
            }
        }
    }

    async fn maybe_flush(&mut self) {
        if self.last_edit.elapsed() >= ACTIVITY_THROTTLE {
            self.flush().await;
        }
    }

    async fn flush(&mut self) {
        let ctx = self.ctx;
        for host in &mut self.hosts {
            if !host.dirty {
                continue;
            }
            let text = host.text();
            if text == host.rendered {
                host.dirty = false;
                continue;
            }
            // Leave `dirty` set on failure so the next flush retries, not stuck stale.
            match host
                .message
                .edit(ctx, serenity::EditMessage::new().content(text.clone()))
                .await
            {
                Ok(()) => {
                    host.rendered = text;
                    host.dirty = false;
                }
                Err(e) => tracing::warn!(error = %e, "activity edit failed"),
            }
        }
        self.last_edit = Instant::now();
    }
}

/// Edit throttle for a live subagent batch — looser than [`ACTIVITY_THROTTLE`]
/// because progress snapshots arrive far more often than tool-call lines.
const SUBAGENT_THROTTLE: Duration = Duration::from_secs(2);

/// Per-`task`-batch render: one Discord message per batch (keyed by tool-call
/// id), one row per subagent, edited in place from `tool_execution_update`
/// snapshots. Mirrors [`Activity`]'s throttled-edit model but keeps each batch
/// as its own message instead of a coalesced feed.
struct SubagentFeed<'a> {
    ctx: &'a serenity::Context,
    channel: serenity::ChannelId,
    batches: std::collections::HashMap<String, SubagentBatch>,
}

struct SubagentBatch {
    message: serenity::Message,
    rows: Vec<crate::render::SubagentRow>,
    started_at: Instant,
    last_edit: Instant,
    /// Last text actually sent (defanged + clamped) so an unchanged edit no-ops.
    rendered: String,
}

impl<'a> SubagentFeed<'a> {
    fn new(ctx: &'a serenity::Context, channel: serenity::ChannelId) -> Self {
        SubagentFeed {
            ctx,
            channel,
            batches: std::collections::HashMap::new(),
        }
    }

    async fn start(&mut self, call: &ToolCall) {
        let rows = crate::render::extract_subagent_rows(&call.args);
        if rows.is_empty() {
            return;
        }
        let content = subagent_send_text(&crate::render::render_subagent_batch(&rows, 0));
        let Some(message) = self.post(&content).await else {
            return;
        };
        let now = Instant::now();
        self.batches.insert(
            call.tool_call_id.clone(),
            SubagentBatch {
                message,
                rows,
                started_at: now,
                last_edit: now,
                rendered: content,
            },
        );
    }

    async fn update(&mut self, tool: &ToolCallUpdate) {
        let Some(batch) = self.batches.get_mut(&tool.tool_call_id) else {
            return;
        };
        crate::render::apply_progress(&mut batch.rows, &tool.partial_result);
        let due = batch.last_edit.elapsed() >= SUBAGENT_THROTTLE;
        if due {
            self.edit(&tool.tool_call_id).await;
        }
    }

    async fn end(&mut self, tool: &ToolCallEnd) {
        let Some(batch) = self.batches.get_mut(&tool.tool_call_id) else {
            return;
        };
        crate::render::settle_rows(&mut batch.rows, tool.is_error);
        self.edit(&tool.tool_call_id).await;
        self.batches.remove(&tool.tool_call_id);
    }

    /// Flush every open batch's current state — used when the turn ends without
    /// a per-batch end frame (cancel, async error, child death). When
    /// `settle_failed` the subagents are definitively gone (OMP error / dead
    /// child), so in-progress rows settle to ❌; on a cancel/restart the turn may
    /// resume, so rows keep their live status instead.
    async fn flush_all(&mut self, settle_failed: bool) {
        let keys: Vec<String> = self.batches.keys().cloned().collect();
        for key in keys {
            if settle_failed && let Some(batch) = self.batches.get_mut(&key) {
                crate::render::settle_rows(&mut batch.rows, true);
            }
            self.edit(&key).await;
        }
    }

    async fn edit(&mut self, key: &str) {
        let Some(batch) = self.batches.get_mut(key) else {
            return;
        };
        let elapsed = batch.started_at.elapsed().as_millis() as u64;
        let content = subagent_send_text(&crate::render::render_subagent_batch(&batch.rows, elapsed));
        if content == batch.rendered {
            batch.last_edit = Instant::now();
            return;
        }
        match batch
            .message
            .edit(self.ctx, serenity::EditMessage::new().content(content.clone()))
            .await
        {
            Ok(()) => {
                batch.rendered = content;
                batch.last_edit = Instant::now();
            }
            Err(e) => tracing::warn!(error = %e, "subagent edit failed"),
        }
    }

    async fn post(&self, content: &str) -> Option<serenity::Message> {
        let message = serenity::CreateMessage::new()
            .content(content.to_string())
            .flags(serenity::MessageFlags::SUPPRESS_NOTIFICATIONS);
        match self.channel.send_message(self.ctx, message).await {
            Ok(message) => Some(message),
            Err(e) => {
                tracing::warn!(error = %e, "subagent send failed");
                None
            }
        }
    }
}

/// Defang mentions in a subagent batch render (descriptions and tool args are
/// user/model controlled) and clamp to the Discord hard limit so an oversized
/// batch can't 400 every edit.
fn subagent_send_text(raw: &str) -> String {
    let defanged = crate::render::defang_mentions(raw);
    if defanged.chars().count() <= ACTIVITY_SEND_MAX {
        defanged
    } else {
        defanged.chars().take(ACTIVITY_SEND_MAX).collect()
    }
}

fn is_thread(kind: serenity::ChannelType) -> bool {
    matches!(
        kind,
        serenity::ChannelType::PublicThread | serenity::ChannelType::PrivateThread | serenity::ChannelType::NewsThread
    )
}

/// A Discord thread name (<=100 chars) from the first line of the opening message.
fn thread_name(prompt: &str) -> String {
    let line = prompt.lines().next().unwrap_or("").trim();
    let name: String = line.chars().take(90).collect();
    if name.is_empty() { "chat".to_owned() } else { name }
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use crate::{bindings::Binding, config::GuildDefault};

    fn guild_default(profile: &str, cwd: &str) -> GuildDefault {
        GuildDefault {
            profile: profile.to_owned(),
            cwd: PathBuf::from(cwd),
        }
    }

    fn binding(profile: &str, cwd: &str) -> Binding {
        Binding {
            channel_id: "123456789012345678".to_owned(),
            profile: profile.to_owned(),
            cwd: PathBuf::from(cwd),
        }
    }

    #[test]
    fn binding_wins_over_guild_default() {
        let d = guild_default("default", "/default");
        let b = binding("sen", "/work");
        let (profile, cwd) = super::resolve_route(&d, Some(&b));
        assert_eq!(profile, "sen");
        assert_eq!(cwd, PathBuf::from("/work"));
    }

    #[test]
    fn unbound_channel_uses_guild_default() {
        let d = guild_default("default", "/default");
        let (profile, cwd) = super::resolve_route(&d, None);
        assert_eq!(profile, "default");
        assert_eq!(cwd, PathBuf::from("/default"));
    }
}
