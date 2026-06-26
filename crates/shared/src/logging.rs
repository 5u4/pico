use std::{
    backtrace::Backtrace,
    panic::{self, PanicHookInfo},
    path::Path,
};

use tracing_appender::{
    non_blocking::{NonBlocking, WorkerGuard},
    rolling::{Builder, Rotation},
};
use tracing_error::ErrorLayer;
use tracing_subscriber::{EnvFilter, Layer, filter::LevelFilter, fmt, prelude::*};

const MAX_LOG_FILES: usize = 7;

const STDOUT_DEFAULT: &str = "info";

const FILE_DEFAULT: &str = "debug";

fn file_filter() -> EnvFilter {
    let mut filter = EnvFilter::new(FILE_DEFAULT);
    let Ok(env) = std::env::var("RUST_LOG") else {
        return filter;
    };
    for raw in env.split(',') {
        let directive = raw.trim();
        if directive.is_empty() {
            continue;
        }
        if let Ok(level) = directive.parse::<LevelFilter>() {
            if level > LevelFilter::DEBUG {
                filter = filter.add_directive(level.into());
            }
            continue;
        }
        if let Ok(parsed) = directive.parse() {
            filter = filter.add_directive(parsed);
        }
    }
    filter
}

fn file_writer(dir: &Path, prefix: &str) -> color_eyre::Result<(NonBlocking, WorkerGuard)> {
    std::fs::create_dir_all(dir)?;
    let appender = Builder::new()
        .rotation(Rotation::DAILY)
        .filename_prefix(prefix)
        .filename_suffix("log")
        .max_log_files(MAX_LOG_FILES)
        .build(dir)?;
    Ok(tracing_appender::non_blocking(appender))
}

pub fn init(dir: &Path, prefix: &str) -> color_eyre::Result<WorkerGuard> {
    let (writer, guard) = file_writer(dir, prefix)?;

    tracing_subscriber::registry()
        .with(fmt::layer().with_filter(EnvFilter::new(STDOUT_DEFAULT)))
        .with(
            fmt::layer()
                .with_ansi(false)
                .with_writer(writer)
                .with_filter(file_filter()),
        )
        .with(ErrorLayer::default())
        .try_init()?;

    install_panic_hook();
    Ok(guard)
}

pub fn init_file_only(dir: &Path, prefix: &str) -> color_eyre::Result<WorkerGuard> {
    let (writer, guard) = file_writer(dir, prefix)?;

    tracing_subscriber::registry()
        .with(
            fmt::layer()
                .with_ansi(false)
                .with_writer(writer)
                .with_filter(file_filter()),
        )
        .with(ErrorLayer::default())
        .try_init()?;

    Ok(guard)
}

fn panic_payload(info: &PanicHookInfo) -> String {
    let payload = info.payload();
    if let Some(s) = payload.downcast_ref::<&str>() {
        (*s).to_owned()
    } else if let Some(s) = payload.downcast_ref::<String>() {
        s.clone()
    } else {
        "<non-string panic payload>".to_owned()
    }
}

fn install_panic_hook() {
    let prior = panic::take_hook();
    panic::set_hook(Box::new(move |info| {
        let location = info.location().map(ToString::to_string).unwrap_or_default();
        tracing::error!(
            panic = %panic_payload(info),
            location = %location,
            backtrace = %Backtrace::force_capture(),
            "thread panicked"
        );
        prior(info);
    }));
}

#[cfg(test)]
mod tests {
    use std::sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    };

    use tracing::Level;
    use tracing_subscriber::layer::{Context, Layer, SubscriberExt};

    use super::install_panic_hook;

    #[derive(Clone, Default)]
    struct CaptureError(Arc<AtomicBool>);

    impl<S: tracing::Subscriber> Layer<S> for CaptureError {
        fn on_event(&self, event: &tracing::Event<'_>, _ctx: Context<'_, S>) {
            if *event.metadata().level() == Level::ERROR {
                self.0.store(true, Ordering::SeqCst);
            }
        }
    }

    #[test]
    fn panic_hook_emits_tracing_error() {
        let capture = CaptureError::default();
        let saw_error = capture.0.clone();

        let restore = std::panic::take_hook();
        install_panic_hook();
        let worker = std::thread::spawn(move || {
            let subscriber = tracing_subscriber::registry().with(capture);
            tracing::subscriber::with_default(subscriber, || {
                let _ = std::panic::catch_unwind(|| panic!("boom from a worker thread"));
            });
        });
        worker.join().unwrap();
        std::panic::set_hook(restore);

        assert!(
            saw_error.load(Ordering::SeqCst),
            "panic hook did not emit an ERROR-level tracing event from a worker thread"
        );
    }
}
