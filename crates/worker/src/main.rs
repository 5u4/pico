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
        None => pico_shared::paths::worker_root()?,
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

    let config_path = pico_shared::paths::worker_config(&args.root);
    let root_config = pico_core::config::load_root(&config_path)?;
    let (run_discord, run_web) = resolve_platforms(root_config.platforms(), &config_path)?;

    let web_cancel = tokio_util::sync::CancellationToken::new();
    let web_only = run_web && !run_discord;
    let (bound_tx, bound_rx) = if web_only {
        let (tx, rx) = tokio::sync::oneshot::channel();
        (Some(tx), Some(rx))
    } else {
        (None, None)
    };
    let web_handle = if run_web {
        let root = args.root.clone();
        let port = root_config.web_port();
        let bind = root_config.web_bind();
        let cancel = web_cancel.clone();
        Some(tokio::spawn(async move {
            let cwd = std::env::current_dir().unwrap_or_else(|_| root.clone());
            if let Err(e) = pico_web::server::serve(root, cwd, bind, port, cancel, bound_tx).await {
                tracing::error!(error = %format!("{e:#}"), "web server exited with error");
            }
        }))
    } else {
        None
    };

    if run_discord {
        let app = pico_discord::app::App::build(&args.root, args.socket.clone()).await?;
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
    } else {
        let bound = match bound_rx {
            Some(rx) => rx.await.is_ok(),
            None => true,
        };
        if !bound {
            tracing::error!("web server exited before binding; not reporting ready");
        } else {
            match args.socket.as_ref() {
                Some(socket) => {
                    let token = args.ready_token.clone().unwrap_or_default();
                    match report_ready(socket, &token).await {
                        Ok(_) => tracing::info!(socket = %socket.display(), "web reported ready to supervisor"),
                        Err(e) => tracing::warn!(error = %format!("{e:#}"), "web failed to report ready to supervisor"),
                    }
                }
                None => tracing::warn!("standalone web (no --socket): hot-update disabled"),
            }
            let web_exit = async {
                match web_handle {
                    Some(handle) => {
                        let _ = handle.await;
                    }
                    None => std::future::pending::<()>().await,
                }
            };
            tokio::select! {
                res = pico_shared::signal::wait_for_shutdown() => {
                    if let Err(e) = res {
                        tracing::error!(error = %format!("{e:#}"), "signal wait failed; shutting down");
                    }
                }
                () = web_exit => {
                    tracing::error!("web server task exited; shutting down worker");
                }
            }
        }
    }
    web_cancel.cancel();

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

fn resolve_platforms(platforms: &[String], config_path: &Path) -> color_eyre::Result<(bool, bool)> {
    let mut run_discord = false;
    let mut run_web = false;
    for name in platforms {
        match name.as_str() {
            "discord" => run_discord = true,
            "web" => run_web = true,
            other => color_eyre::eyre::bail!(
                "unknown platform {other:?} in {} (known platforms: discord, web)",
                config_path.display()
            ),
        }
    }
    if !run_discord && !run_web {
        color_eyre::eyre::bail!(
            "no platforms configured: set platforms = [\"discord\"] (and/or \"web\") in {}",
            config_path.display()
        );
    }
    Ok((run_discord, run_web))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn names(values: &[&str]) -> Vec<String> {
        values.iter().map(|v| (*v).to_owned()).collect()
    }

    #[test]
    fn accepts_discord() {
        assert_eq!(resolve_platforms(&names(&["discord"]), Path::new("/x")).unwrap(), (true, false));
    }

    #[test]
    fn accepts_web_and_both() {
        assert_eq!(resolve_platforms(&names(&["web"]), Path::new("/x")).unwrap(), (false, true));
        assert_eq!(
            resolve_platforms(&names(&["discord", "web"]), Path::new("/x")).unwrap(),
            (true, true)
        );
    }

    #[test]
    fn rejects_unknown_platform() {
        assert!(resolve_platforms(&names(&["discord", "slack"]), Path::new("/x")).is_err());
    }

    #[test]
    fn rejects_empty_list() {
        assert!(resolve_platforms(&names(&[]), Path::new("/x")).is_err());
    }
}
