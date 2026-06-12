use std::path::Path;

use color_eyre::eyre::WrapErr;
use poise::serenity_prelude as serenity;

/// The worker's running application: owns the single Discord client (gateway +
/// command framework) for this worker root. Stage 1 is Discord-only; the LLM,
/// per-profile storage, and scheduler attach on later milestones.
pub struct App {
    client: serenity::Client,
    ready_rx: tokio::sync::oneshot::Receiver<()>,
}

impl App {
    /// Load the bot token from `<root>/secrets/discord_bot_token` and construct
    /// the Discord client without connecting ([`App::run`] connects). A missing
    /// or empty token errors here — before the worker can report ready — so a
    /// deploy lacking credentials fails the supervisor's health check and rolls
    /// back instead of half-starting.
    pub async fn build(root: &Path) -> color_eyre::Result<App> {
        let token = read_secret(root, "discord_bot_token")?;
        let (ready_tx, ready_rx) = tokio::sync::oneshot::channel();
        let client = serenity::ClientBuilder::new(&token, serenity::GatewayIntents::empty())
            .framework(crate::discord::framework(ready_tx))
            .await
            .wrap_err("build discord client")?;
        Ok(App { client, ready_rx })
    }

    /// Connect to the gateway and serve until `shutdown` resolves, then stop the
    /// shards cleanly. `on_connected` fires once the gateway is up — the worker
    /// reports ready to the supervisor there — and never fires if the client
    /// fails before connecting.
    pub async fn run<S, R, Rf>(self, shutdown: S, on_connected: R) -> color_eyre::Result<()>
    where
        S: Future<Output = ()> + Send + 'static,
        R: FnOnce() -> Rf + Send + 'static,
        Rf: Future<Output = ()> + Send + 'static,
    {
        let App { mut client, ready_rx } = self;
        let shard_manager = client.shard_manager.clone();
        tokio::spawn(async move {
            shutdown.await;
            tracing::info!("shutdown signal received; stopping discord gateway");
            shard_manager.shutdown_all().await;
        });
        tokio::spawn(async move {
            if ready_rx.await.is_ok() {
                on_connected().await;
            }
        });
        client.start().await.wrap_err("discord client error")?;
        Ok(())
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
    use std::path::{Path, PathBuf};

    fn tmp_root() -> PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!("pico-secret-{}-{nanos}", std::process::id()))
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
