use tokio::signal::unix::{SignalKind, signal};

/// Resolve once the process receives `SIGTERM` or `SIGINT`. Both handlers are
/// registered before the `select!`, so a signal delivered after registration
/// is caught even if it lands before this future is polled. Errors only if the
/// handlers cannot be registered.
pub async fn wait_for_shutdown() -> color_eyre::Result<()> {
    let mut term = signal(SignalKind::terminate())?;
    let mut interrupt = signal(SignalKind::interrupt())?;
    tokio::select! {
        _ = term.recv() => {}
        _ = interrupt.recv() => {}
    }
    Ok(())
}
