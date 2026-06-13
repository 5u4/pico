mod build;
mod client;
mod config;
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
        Some("status") => client::status().await,
        Some("stop") => client::stop().await,
        Some("rollback") => client::rollback().await,
        Some(other) => Err(color_eyre::eyre::eyre!(
            "unknown command {other:?}; expected deploy|status|stop|rollback, or no argument to run the daemon"
        )),
    }
}

async fn run_daemon() -> color_eyre::Result<()> {
    let dir = pico_shared::paths::supervisor_dir()?;
    let _log_guard = pico_shared::logging::init(&dir.join("logs"), "supervisor")?;
    tracing::info!(version = env!("CARGO_PKG_VERSION"), "pico supervisor starting");

    let config = config::Config::load(&dir)?;
    let worker_root = config.worker_root()?;
    let socket_path = config.socket_path.clone().unwrap_or_else(|| dir.join("pico.sock"));
    let slots = slots::Slots::new(&dir)?;
    let sup = Arc::new(supervisor::Supervisor::new(config, worker_root, socket_path, slots));

    sup.serve().await
}
