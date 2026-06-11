mod build;
mod config;
mod slots;
mod supervisor;

use std::sync::Arc;

#[tokio::main]
async fn main() -> color_eyre::Result<()> {
    color_eyre::install()?;

    let dir = pico_shared::paths::pico_home()?.join("supervisor");
    let _log_guard = pico_shared::logging::init(&dir.join("logs"), "supervisor")?;
    tracing::info!(version = env!("CARGO_PKG_VERSION"), "pico supervisor starting");

    let config = config::Config::load(&dir)?;
    let worker_root = config.worker_root()?;
    let slots = slots::Slots::new(&dir)?;
    let sup = Arc::new(supervisor::Supervisor::new(config, worker_root, slots));

    sup.boot().await?;
    sup.serve().await
}
