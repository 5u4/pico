use std::{
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    time::Duration,
};

use pico_core::app::App;
use tokio::sync::oneshot;

fn load_secrets() {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../.env.e2e");
    let _ = dotenvy::from_path(path);
}

/// Holds the bot token under `$TMPDIR`; removed on drop so a panicking or
/// timed-out test never leaves the secret behind.
struct TempRoot {
    path: PathBuf,
}

impl TempRoot {
    fn new(token: &str) -> TempRoot {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!("pico-discord-e2e-{}-{nanos}", std::process::id()));
        let secrets = path.join("secrets");
        std::fs::create_dir_all(&secrets).unwrap();
        let token_file = secrets.join("discord_bot_token");
        std::fs::write(&token_file, token).unwrap();
        std::fs::set_permissions(&token_file, std::fs::Permissions::from_mode(0o600)).unwrap();
        TempRoot { path }
    }
}

impl Drop for TempRoot {
    fn drop(&mut self) {
        std::fs::remove_dir_all(&self.path).ok();
    }
}

#[tokio::test]
#[ignore]
async fn connects_to_gateway_then_shuts_down_cleanly() {
    load_secrets();
    let token = std::env::var("E2E_PICO_BOT_TOKEN")
        .expect("set E2E_PICO_BOT_TOKEN in .env.e2e at the workspace root (see .env.e2e.example)");
    let root = TempRoot::new(&token);

    let app = App::build(&root.path, None).await.expect("build discord client");

    let (connected_tx, connected_rx) = oneshot::channel();
    let (shutdown_tx, shutdown_rx) = oneshot::channel();

    let server = tokio::spawn(app.run(
        async move {
            let _ = shutdown_rx.await;
        },
        move || async move {
            let _ = connected_tx.send(());
        },
    ));

    // 30s of slack over the supervisor's 10s health_timeout for the handshake.
    tokio::time::timeout(Duration::from_secs(30), connected_rx)
        .await
        .expect("gateway did not connect within 30s")
        .expect("on_connected never fired (setup likely errored)");

    shutdown_tx.send(()).expect("send shutdown");
    tokio::time::timeout(Duration::from_secs(15), server)
        .await
        .expect("client did not shut down within 15s")
        .expect("run task panicked")
        .expect("discord client returned an error");
}
