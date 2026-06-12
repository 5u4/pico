use std::{
    sync::Arc,
    time::{Duration, Instant},
};

use color_eyre::eyre::{WrapErr, eyre};
use pico_shared::proto;
use poise::serenity_prelude as serenity;

use crate::{
    bindings::Bindings,
    omp::{
        pool::{OmpPool, ThreadSession},
        protocol::{AssistantMessageEvent, OmpEvent},
    },
};

pub(crate) struct Data {
    root: Arc<std::path::PathBuf>,
    bindings: Arc<parking_lot::Mutex<Bindings>>,
    pool: Arc<OmpPool>,
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
    #[description = "git rev to deploy (or path:<binary> for a prebuilt worker)"] target: String,
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
        Ok(proto::Response::Status(_)) => {}
        Err(e) => {
            ctx.say(format!("deploy outcome unknown: {e}")).await?;
        }
    }
    Ok(())
}

fn parse_deploy_target(arg: &str) -> proto::DeployTarget {
    if let Some(path) = arg.strip_prefix("path:") {
        proto::DeployTarget::Path {
            path: std::path::PathBuf::from(path),
        }
    } else {
        proto::DeployTarget::Rev {
            rev: arg.strip_prefix("rev:").unwrap_or(arg).to_owned(),
        }
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
        let message = new_message.clone();
        tokio::spawn(async move {
            if let Err(e) = route_message(ctx, root, bindings, pool, message).await {
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
    let config = crate::omp::client::SpawnConfig {
        model: crate::config::load(&pico_shared::paths::profile_config(&root, &profile))?.model,
        cwd: Some(cwd),
        session_dir: Some(session_dir),
        continue_session: true,
        append_system_prompt: identity.is_file().then_some(identity),
    };

    let handle = pool.get_or_spawn(&thread_id, &config).await?;
    let mut session = handle.lock().await;
    drive_turn(&ctx, target, &mut session, prompt).await
}

/// Send the prompt and stream the reply into `target`, editing the posted
/// message(s) at most once per second so a long reply stays under Discord's
/// per-channel edit rate limit. Tool/thinking deltas are ignored in Stage 1.
async fn drive_turn(
    ctx: &serenity::Context,
    target: serenity::ChannelId,
    session: &mut ThreadSession,
    prompt: &str,
) -> color_eyre::Result<()> {
    let _typing = target.start_typing(&ctx.http);
    session.client.prompt(prompt).await?;

    let mut reply = String::new();
    let mut posted: Vec<serenity::Message> = Vec::new();
    let mut last = Instant::now();
    let throttle = Duration::from_secs(1);

    loop {
        match session.events.recv().await {
            Some(OmpEvent::Message(AssistantMessageEvent::TextDelta { delta })) => {
                reply.push_str(&delta);
                if last.elapsed() >= throttle {
                    reconcile(ctx, target, &reply, &mut posted).await;
                    last = Instant::now();
                }
            }
            Some(OmpEvent::AgentEnd) | None => break,
            Some(OmpEvent::Error(e)) => {
                let _ = target.say(ctx, format!("OMP error: {e}")).await;
                return Ok(());
            }
            Some(_) => {}
        }
    }
    reconcile(ctx, target, &reply, &mut posted).await;
    Ok(())
}

/// Reconcile the posted Discord messages against the current reply text:
/// edit a chunk that changed, post a chunk that does not exist yet. `reply`
/// only grows, so chunk indices are stable.
async fn reconcile(
    ctx: &serenity::Context,
    target: serenity::ChannelId,
    reply: &str,
    posted: &mut Vec<serenity::Message>,
) {
    let chunks = crate::render::split_to_budget(&crate::render::defang_mentions(reply), crate::render::DISCORD_BUDGET);
    for (i, chunk) in chunks.iter().enumerate() {
        match posted.get_mut(i) {
            Some(message) if message.content != *chunk => {
                if let Err(e) = message
                    .edit(ctx, serenity::EditMessage::new().content(chunk.clone()))
                    .await
                {
                    tracing::warn!(error = %e, "reply edit failed");
                }
            }
            Some(_) => {}
            None => match target.say(ctx, chunk.clone()).await {
                Ok(message) => posted.push(message),
                Err(e) => tracing::warn!(error = %e, "reply send failed"),
            },
        }
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
    fn bare_arg_is_a_rev_explicit_prefixes_win() {
        assert!(matches!(parse_deploy_target("main"), DeployTarget::Rev { rev } if rev == "main"));
        assert!(matches!(parse_deploy_target("rev:abc123"), DeployTarget::Rev { rev } if rev == "abc123"));
        assert!(
            matches!(parse_deploy_target("path:/opt/worker"), DeployTarget::Path { path } if path == std::path::Path::new("/opt/worker"))
        );
    }
}
