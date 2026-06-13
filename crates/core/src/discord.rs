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
        protocol::{AssistantMessageEvent, OmpEvent, ToolCallEnd, ToolCallStart},
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

/// Liveness check — replies "Pong!".
#[poise::command(slash_command)]
async fn ping(ctx: Context<'_>) -> Result<(), Error> {
    ctx.say("Pong!").await?;
    Ok(())
}

// Standalone runs (no supervisor socket) report `/deploy` as unavailable.
/// Trigger a supervisor hot-update (deploy a git rev or prebuilt worker binary).
#[poise::command(slash_command)]
async fn deploy(
    ctx: Context<'_>,
    #[description = "worker binary path (or rev:<git-rev> to build a revision)"] target: String,
) -> Result<(), Error> {
    let Some(socket) = ctx.data().supervisor_socket.clone() else {
        ctx.say("not running under a supervisor (standalone) — `/deploy` is unavailable")
            .await?;
        return Ok(());
    };
    // A successful deploy replaces this worker before the reply lands, so the
    // confirmation is the bot reconnecting; a build failure returns here first.
    ctx.say(format!(
        "deploying `{target}` — I restart on success; a build error comes back here."
    ))
    .await?;
    match request_deploy(&socket, parse_deploy_target(&target)).await {
        Ok(proto::Response::Ok { detail }) => {
            ctx.say(format!("deployed: {detail}")).await?;
        }
        Ok(proto::Response::Error { message }) => {
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

fn parse_deploy_target(arg: &str) -> proto::DeployTarget {
    match arg.strip_prefix("rev:") {
        Some(rev) => proto::DeployTarget::Rev { rev: rev.to_owned() },
        None => proto::DeployTarget::Path {
            path: std::path::PathBuf::from(arg.strip_prefix("path:").unwrap_or(arg)),
        },
    }
}

async fn request_deploy(socket: &std::path::Path, target: proto::DeployTarget) -> color_eyre::Result<proto::Response> {
    let stream = tokio::time::timeout(Duration::from_secs(5), tokio::net::UnixStream::connect(socket))
        .await
        .map_err(|_| eyre!("connecting to supervisor timed out"))?
        .wrap_err("connect to supervisor socket")?;
    let (read_half, mut write_half) = stream.into_split();
    proto::write_frame(&mut write_half, &proto::Request::Deploy { target }).await?;
    let mut reader = tokio::io::BufReader::new(read_half);
    tokio::time::timeout(Duration::from_secs(600), proto::read_frame::<proto::Response, _>(&mut reader))
        .await
        .map_err(|_| eyre!("deploy did not complete within 10m"))?
        .wrap_err("read deploy response")?
        .ok_or_else(|| eyre!("supervisor closed the connection without replying"))
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

    let serenity::Channel::Guild(channel) = message.channel_id.to_channel(&ctx).await? else {
        return Ok(());
    };
    // A thread routes via its parent channel's binding; the thread itself is the
    // session. A top-level message in a bound channel opens a fresh thread.
    let in_thread = is_thread(channel.kind);
    let bound_channel = if in_thread {
        match channel.parent_id {
            Some(parent) => parent,
            None => return Ok(()),
        }
    } else {
        channel.id
    };

    let Some((profile, cwd)) = ({
        let table = bindings.lock();
        table
            .get(&bound_channel.to_string())
            .map(|b| (b.profile.clone(), b.cwd.clone()))
    }) else {
        tracing::debug!(%bound_channel, "channel not bound; ignoring message");
        return Ok(());
    };

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
        drive_turn(&ctx, target, &mut session, prompt, &cancel, profile_config.surface_thinking).await?
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

/// Drive one OMP turn: render tool-call/reasoning activity as silent messages,
/// then post the buffered answer — only text not followed by a tool survives.
async fn drive_turn(
    ctx: &serenity::Context,
    target: serenity::ChannelId,
    session: &mut ThreadSession,
    prompt: &str,
    cancel: &CancellationToken,
    surface_thinking: bool,
) -> color_eyre::Result<TurnOutcome> {
    let _typing = target.start_typing(&ctx.http);
    session.client.prompt(prompt).await?;

    let mut reply = String::new();
    let mut activity = Activity::new(ctx, target);

    loop {
        let event = tokio::select! {
            () = cancel.cancelled() => {
                activity.flush().await;
                commit_reply(ctx, target, &reply).await;
                let _ = target
                    .say(ctx, "worker is restarting; resend your message to continue")
                    .await;
                return Ok(TurnOutcome::Live);
            }
            event = session.events.recv() => event,
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
                activity.start(&tool).await;
            }
            Some(OmpEvent::ToolEnd(tool)) => {
                activity.end(&tool).await;
            }
            Some(OmpEvent::AgentEnd) => break,
            Some(OmpEvent::Error(e)) => {
                activity.flush().await;
                let _ = target.say(ctx, format!("OMP error: {e}")).await;
                return Ok(TurnOutcome::Live);
            }
            // No `_`: listing the inert variants keeps the match exhaustive, so
            // a new `OmpEvent` is a compile error here, not a silent drop.
            Some(OmpEvent::AgentStart | OmpEvent::Message(AssistantMessageEvent::Other)) => {}
            // Stream closed: the child died mid-turn — flush, notify, and report it dead so the pool respawns it.
            None => {
                activity.flush().await;
                commit_reply(ctx, target, &reply).await;
                let _ = target
                    .say(ctx, "the OMP session ended unexpectedly; send another message to restart it")
                    .await;
                return Ok(TurnOutcome::Dead);
            }
        }
    }
    activity.flush().await;
    commit_reply(ctx, target, &reply).await;
    Ok(TurnOutcome::Live)
}

/// Post the buffered answer at turn end, split to budget; the first chunk pings,
/// follow-on chunks are silent. Blank/tool-only turns post nothing.
async fn commit_reply(ctx: &serenity::Context, target: serenity::ChannelId, reply: &str) {
    let chunks = crate::render::split_to_budget(&crate::render::defang_mentions(reply), crate::render::DISCORD_BUDGET);
    for (i, chunk) in chunks.iter().enumerate() {
        let mut message = serenity::CreateMessage::new().content(chunk.clone());
        if i != 0 {
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
        let line = crate::render::tool_activity_line(&tool.tool_name, &tool.args);
        if let Some(placement) = self.append(line).await {
            self.placements.insert(tool.tool_call_id.clone(), placement);
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
    use pico_shared::proto::DeployTarget;

    use super::parse_deploy_target;

    #[test]
    fn bare_arg_is_a_path_explicit_prefixes_win() {
        assert!(
            matches!(parse_deploy_target("/opt/worker"), DeployTarget::Path { path } if path == std::path::Path::new("/opt/worker"))
        );
        assert!(matches!(parse_deploy_target("rev:abc123"), DeployTarget::Rev { rev } if rev == "abc123"));
        assert!(
            matches!(parse_deploy_target("path:/opt/worker"), DeployTarget::Path { path } if path == std::path::Path::new("/opt/worker"))
        );
    }
}
