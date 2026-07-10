use clap::Args;
use tokio_util::sync::CancellationToken;

#[derive(Args)]
pub struct WebArgs {
    #[arg(long)]
    port: Option<u16>,
}

pub async fn run(args: WebArgs) -> color_eyre::Result<()> {
    let root = pico_shared::paths::worker_root()?;
    let cwd = std::env::current_dir()?;
    let port = match args.port {
        Some(p) => p,
        None => pico_core::config::load_root(&pico_shared::paths::worker_config(&root))?.web_port(),
    };

    let cancel = CancellationToken::new();
    let signal_cancel = cancel.clone();
    tokio::spawn(async move {
        if pico_shared::signal::wait_for_shutdown().await.is_ok() {
            signal_cancel.cancel();
        }
    });

    pico_web::server::serve(root, cwd, port, cancel, None).await
}
