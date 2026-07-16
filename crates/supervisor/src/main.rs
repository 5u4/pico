mod client;
mod config;
mod proto;
mod slots;
mod supervisor;

use std::sync::Arc;

#[tokio::main]
async fn main() -> color_eyre::Result<()> {
    color_eyre::install()?;

    let mut args = std::env::args().skip(1);
    match args.next().as_deref() {
        None => run_daemon().await,
        Some("deploy") => client::deploy(args.next()).await,
        Some("rollback") => client::rollback().await,
        Some("status") => client::status().await,
        Some("stop") => client::stop().await,
        Some(other) => Err(color_eyre::eyre::eyre!(
            "unknown command {other:?}; expected deploy|rollback|status|stop, or no argument to run the daemon"
        )),
    }
}

async fn run_daemon() -> color_eyre::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();
    tracing::info!(version = env!("CARGO_PKG_VERSION"), "pico supervisor starting");

    let dir = config::supervisor_dir()?;
    let config = config::Config::load(&dir)?;
    let bun = config.resolve_bun()?;
    tracing::info!(bun = %bun.display(), "resolved bun");
    let socket_path = config.socket_path.clone().unwrap_or_else(|| dir.join("pico.sock"));
    let slots = slots::Slots::new(&dir)?;
    let sup = Arc::new(supervisor::Supervisor::new(config, bun, socket_path, slots));

    sup.serve().await
}
