use std::path::Path;

use tracing_appender::{
    non_blocking::WorkerGuard,
    rolling::{Builder, Rotation},
};
use tracing_error::ErrorLayer;
use tracing_subscriber::{EnvFilter, fmt, prelude::*};

/// Daily log files retained on disk before the oldest is pruned.
const MAX_LOG_FILES: usize = 14;

/// Install the global tracing subscriber: a daily-rotated `<prefix>.<date>.log`
/// under `dir` (last [`MAX_LOG_FILES`] days kept) alongside console output, both
/// gated by an `EnvFilter` (default `info`), plus the [`ErrorLayer`] that backs
/// `color_eyre`'s spantraces.
///
/// The returned [`WorkerGuard`] flushes the non-blocking file writer when
/// dropped; the caller MUST hold it for the lifetime of the process or trailing
/// log lines are lost.
pub fn init(dir: &Path, prefix: &str) -> color_eyre::Result<WorkerGuard> {
    std::fs::create_dir_all(dir)?;

    let appender = Builder::new()
        .rotation(Rotation::DAILY)
        .filename_prefix(prefix)
        .filename_suffix("log")
        .max_log_files(MAX_LOG_FILES)
        .build(dir)?;
    let (file_writer, guard) = tracing_appender::non_blocking(appender);

    tracing_subscriber::registry()
        .with(EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")))
        .with(fmt::layer())
        .with(fmt::layer().with_ansi(false).with_writer(file_writer))
        .with(ErrorLayer::default())
        .init();

    Ok(guard)
}
