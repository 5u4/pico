use tokio::signal::unix::{SignalKind, signal};

/// Resolve once the process receives `SIGTERM` or `SIGINT`. When first polled
/// the future registers both handlers before awaiting, so a signal that arrives
/// after registration is still delivered even if it precedes `recv()`. Errors
/// only if the handlers cannot be registered.
pub async fn wait_for_shutdown() -> color_eyre::Result<()> {
    let mut term = signal(SignalKind::terminate())?;
    let mut interrupt = signal(SignalKind::interrupt())?;
    tokio::select! {
        _ = term.recv() => {}
        _ = interrupt.recv() => {}
    }
    Ok(())
}
