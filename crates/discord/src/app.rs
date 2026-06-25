use std::path::Path;

use color_eyre::eyre::WrapErr;
use pico_core::omp::pool::OmpPool;
use poise::serenity_prelude as serenity;
use tokio_util::{sync::CancellationToken, task::TaskTracker};

pub struct App {
    client: serenity::Client,
    ready_rx: tokio::sync::oneshot::Receiver<()>,
    cancel: CancellationToken,
    tracker: TaskTracker,
}

impl App {
    pub async fn build(root: &Path, supervisor_socket: Option<std::path::PathBuf>) -> color_eyre::Result<App> {
        let token = read_secret(root, "discord_bot_token")?;
        let db = pico_core::db::open(root).await.wrap_err("opening worker database")?;
        match crate::approval::reconcile_pending_aborted(&db).await {
            Ok(0) => {}
            Ok(n) => tracing::info!(count = n, "reconciled abandoned approval requests to aborted"),
            Err(e) => tracing::warn!(error = %format!("{e:#}"), "reconciling pending approvals failed"),
        }
        let cancel = CancellationToken::new();
        let tracker = TaskTracker::new();
        let camofox = pico_core::omp::camofox::CamofoxDaemon::new(root, cancel.clone(), &tracker);
        let host_config = pico_core::omp::client::HostConfig {
            env: camofox.host_env(pico_core::config::any_browser_enabled(root)),
        };
        let pool = OmpPool::new(root.to_path_buf(), host_config, cancel.clone(), &tracker);
        let (ready_tx, ready_rx) = tokio::sync::oneshot::channel();
        let intents = serenity::GatewayIntents::GUILDS
            | serenity::GatewayIntents::GUILD_MESSAGES
            | serenity::GatewayIntents::MESSAGE_CONTENT
            | serenity::GatewayIntents::DIRECT_MESSAGES;
        let client = serenity::ClientBuilder::new(&token, intents)
            .framework(crate::discord::framework(
                root.to_path_buf(),
                db,
                pool,
                camofox,
                ready_tx,
                supervisor_socket,
                cancel.clone(),
                tracker.clone(),
            ))
            .await
            .wrap_err("build discord client")?;
        Ok(App {
            client,
            ready_rx,
            cancel,
            tracker,
        })
    }

    pub async fn run<S, R, Rf>(self, shutdown: S, on_connected: R) -> color_eyre::Result<()>
    where
        S: Future<Output = ()> + Send + 'static,
        R: FnOnce() -> Rf + Send + 'static,
        Rf: Future<Output = Option<pico_shared::proto::DeployReport>> + Send + 'static,
    {
        let App {
            mut client,
            ready_rx,
            cancel,
            tracker,
        } = self;
        let shard_manager = client.shard_manager.clone();
        let http = client.http.clone();
        {
            let cancel = cancel.clone();
            tracker.spawn(async move {
                tokio::select! {
                    () = shutdown => {}
                    () = cancel.cancelled() => {}
                }
                tracing::info!("stopping discord gateway");
                cancel.cancel();
                shard_manager.shutdown_all().await;
            });
        }
        {
            let cancel = cancel.clone();
            tracker.spawn(async move {
                tokio::select! {
                    () = cancel.cancelled() => {}
                    ready = ready_rx => {
                        if ready.is_ok()
                            && let Some(report) = on_connected().await
                        {
                            crate::discord::post_deploy_report(&http, report).await;
                        }
                    }
                }
            });
        }
        let result = client.start().await.wrap_err("discord client error");
        cancel.cancel();
        tracker.close();
        tracker.wait().await;
        result
    }
}

fn read_secret(root: &Path, name: &str) -> color_eyre::Result<String> {
    let path = pico_shared::paths::worker_secret(root, name);
    let raw = std::fs::read_to_string(&path).wrap_err_with(|| format!("read secret {}", path.display()))?;
    let value = raw.trim();
    if value.is_empty() {
        color_eyre::eyre::bail!("secret {} is empty", path.display());
    }
    Ok(value.to_owned())
}

#[cfg(test)]
mod tests {
    use std::{
        path::{Path, PathBuf},
        sync::atomic::{AtomicU64, Ordering},
    };

    fn tmp_root() -> PathBuf {
        static N: AtomicU64 = AtomicU64::new(0);
        let n = N.fetch_add(1, Ordering::Relaxed);
        std::env::temp_dir().join(format!("pico-secret-{}-{}", std::process::id(), n))
    }

    fn write_secret(root: &Path, body: &str) {
        let dir = root.join("secrets");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("discord_bot_token"), body).unwrap();
    }

    #[test]
    fn reads_and_trims_surrounding_whitespace() {
        let root = tmp_root();
        write_secret(&root, "  abc123\n");
        assert_eq!(super::read_secret(&root, "discord_bot_token").unwrap(), "abc123");
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn missing_secret_errors() {
        let root = tmp_root();
        assert!(super::read_secret(&root, "discord_bot_token").is_err());
    }

    #[test]
    fn whitespace_only_secret_errors() {
        let root = tmp_root();
        write_secret(&root, "   \n");
        assert!(super::read_secret(&root, "discord_bot_token").is_err());
        std::fs::remove_dir_all(&root).ok();
    }
}
