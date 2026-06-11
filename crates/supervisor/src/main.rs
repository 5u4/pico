use tracing_error::ErrorLayer;
use tracing_subscriber::{EnvFilter, fmt, prelude::*};

#[tokio::main]
async fn main() -> color_eyre::Result<()> {
    color_eyre::install()?;

    tracing_subscriber::registry()
        .with(EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")))
        .with(fmt::layer())
        .with(ErrorLayer::default())
        .init();
    tracing::info!(version = env!("CARGO_PKG_VERSION"), "pico supervisor starting");

    tracing::warn!("scaffold build — no control loop wired yet");
    Ok(())
}
