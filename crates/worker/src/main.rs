use std::path::{Path, PathBuf};

use pico_shared::proto::{self, Request};
use tokio::{
    net::UnixStream,
    signal::unix::{SignalKind, signal},
};

struct Args {
    root: PathBuf,
    socket: Option<PathBuf>,
    ready_token: Option<String>,
}

fn parse_args() -> color_eyre::Result<Args> {
    let mut root = None;
    let mut socket = None;
    let mut ready_token = None;
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        let mut take = |flag: &str| {
            args.next()
                .ok_or_else(|| color_eyre::eyre::eyre!("{flag} requires a value"))
        };
        match arg.as_str() {
            "--path" => root = Some(PathBuf::from(take("--path")?)),
            "--socket" => socket = Some(PathBuf::from(take("--socket")?)),
            "--ready-token" => ready_token = Some(take("--ready-token")?),
            other => return Err(color_eyre::eyre::eyre!("unknown argument: {other}")),
        }
    }
    let root = match root {
        Some(root) => root,
        None => pico_shared::paths::worker_root(pico_shared::paths::DEFAULT_WORKER)?,
    };
    Ok(Args {
        root,
        socket,
        ready_token,
    })
}

#[tokio::main]
async fn main() -> color_eyre::Result<()> {
    color_eyre::install()?;

    let args = parse_args()?;
    let _log_guard = pico_shared::logging::init(&args.root.join("logs"), "worker")?;
    tracing::info!(
        version = env!("CARGO_PKG_VERSION"),
        root = %args.root.display(),
        "pico worker starting"
    );

    match &args.socket {
        Some(socket) => {
            let token = args.ready_token.clone().unwrap_or_default();
            match report_ready(socket, &token).await {
                Ok(()) => tracing::info!(socket = %socket.display(), "reported ready to supervisor"),
                Err(e) => tracing::warn!(error = %format!("{e:#}"), "failed to report ready to supervisor"),
            }
        }
        None => tracing::warn!("standalone (no --socket): hot-update disabled"),
    }

    tracing::warn!("scaffold build — no App wired yet");

    wait_for_shutdown().await?;
    tracing::info!("shutdown signal received; exiting");
    Ok(())
}

async fn report_ready(socket: &Path, token: &str) -> color_eyre::Result<()> {
    let mut stream = UnixStream::connect(socket).await?;
    proto::write_frame(
        &mut stream,
        &Request::Ready {
            token: token.to_owned(),
        },
    )
    .await
}

async fn wait_for_shutdown() -> color_eyre::Result<()> {
    let mut term = signal(SignalKind::terminate())?;
    let mut interrupt = signal(SignalKind::interrupt())?;
    tokio::select! {
        _ = term.recv() => {}
        _ = interrupt.recv() => {}
    }
    Ok(())
}
