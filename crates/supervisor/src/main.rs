#[tokio::main]
async fn main() -> color_eyre::Result<()> {
    color_eyre::install()?;

    let log_dir = pico_shared::paths::pico_home()?.join("supervisor").join("logs");
    let _log_guard = pico_shared::logging::init(&log_dir, "supervisor")?;
    tracing::info!(version = env!("CARGO_PKG_VERSION"), "pico supervisor starting");

    tracing::warn!("scaffold build — no control loop wired yet");
    Ok(())
}
