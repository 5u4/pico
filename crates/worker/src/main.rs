#[tokio::main]
async fn main() -> color_eyre::Result<()> {
    color_eyre::install()?;

    let root = pico_shared::paths::pico_home()?.join("workers").join("default");
    let _log_guard = pico_shared::logging::init(&root.join("logs"), "worker")?;
    tracing::info!(version = env!("CARGO_PKG_VERSION"), "pico worker starting");

    tracing::warn!("scaffold build — no App wired yet");
    Ok(())
}
