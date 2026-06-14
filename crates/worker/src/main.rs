use std::path::{Path, PathBuf};

use pico_shared::proto::{self, Request};
use tokio::net::UnixStream;

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
    if std::env::args().skip(1).any(|a| a == "--version" || a == "-V") {
        println!("{}", env!("PICO_VERSION"));
        return Ok(());
    }
    color_eyre::install()?;

    let args = parse_args()?;
    let _log_guard = pico_shared::logging::init(&args.root.join("logs"), "worker")?;
    tracing::info!(
        version = env!("PICO_VERSION"),
        root = %args.root.display(),
        "pico worker starting"
    );

    let app = pico_core::app::App::build(&args.root, args.socket.clone()).await?;

    let on_connected = {
        let socket = args.socket.clone();
        let token = args.ready_token.clone().unwrap_or_default();
        move || async move {
            match socket {
                Some(socket) => match report_ready(&socket, &token).await {
                    Ok(report) => {
                        tracing::info!(socket = %socket.display(), "reported ready to supervisor");
                        report
                    }
                    Err(e) => {
                        tracing::warn!(error = %format!("{e:#}"), "failed to report ready to supervisor");
                        None
                    }
                },
                None => {
                    tracing::warn!("standalone (no --socket): hot-update disabled");
                    None
                }
            }
        }
    };

    app.run(
        async {
            if let Err(e) = pico_shared::signal::wait_for_shutdown().await {
                tracing::error!(error = %format!("{e:#}"), "signal wait failed; shutting down");
            }
        },
        on_connected,
    )
    .await?;

    tracing::info!("shutdown complete; exiting");
    Ok(())
}

async fn report_ready(socket: &Path, token: &str) -> color_eyre::Result<Option<proto::DeployReport>> {
    let stream = UnixStream::connect(socket).await?;
    let (read_half, mut write_half) = stream.into_split();
    proto::write_frame(
        &mut write_half,
        &Request::Ready {
            token: token.to_owned(),
        },
    )
    .await?;
    // Best-effort: the ping above already validated readiness, so a missing or
    // late reply (older supervisor, clean EOF) just means no report.
    let mut reader = tokio::io::BufReader::new(read_half);
    match tokio::time::timeout(
        std::time::Duration::from_secs(10),
        proto::read_frame::<proto::ReadyAck, _>(&mut reader),
    )
    .await
    {
        Ok(Ok(ack)) => Ok(ack.and_then(|a| a.report)),
        Ok(Err(e)) => {
            tracing::debug!(error = %format!("{e:#}"), "malformed ready ack; ignoring");
            Ok(None)
        }
        Err(_) => {
            tracing::debug!("no ready ack within 10s; ignoring");
            Ok(None)
        }
    }
}
