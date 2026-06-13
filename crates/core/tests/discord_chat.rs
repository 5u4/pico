//! End-to-end test for the message-driven chat path: a driver bot posts in a
//! channel bound to a profile; pico opens a thread off that message and posts a
//! buffered OMP (Copilot) reply into it, then a follow-up posted inside the thread
//! comes back as a native Discord reply referencing it. Also asserts the gateway connects and shuts
//! down cleanly — folded in from a former standalone gateway test so the pico
//! bot connects only once per run; two back-to-back connections of the same bot
//! trip Discord's per-bot identify/session limit and flake on connect.
//!
//! `#[ignore]`d by default — it spawns the real `omp` binary, connects two live
//! Discord bots, and hits Copilot over the network. Run with `--include-ignored`
//! after filling `.env.e2e` (see `.env.e2e.example`). The pico bot needs the
//! privileged MESSAGE_CONTENT intent enabled in the Discord developer portal.

use std::{
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    time::Duration,
};

use pico_core::app::App;
use poise::serenity_prelude as serenity;
use tokio::sync::oneshot;

fn load_env() {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../.env.e2e");
    let _ = dotenvy::from_path(path);
}

fn var(key: &str) -> String {
    std::env::var(key).unwrap_or_else(|_| panic!("set {key} in .env.e2e at the workspace root (see .env.e2e.example)"))
}

/// A throwaway worker root: bot token, a `default` profile, and a binding that
/// routes the e2e channel to it. Removed on drop so a panicking test leaves
/// nothing behind.
struct TempRoot {
    path: PathBuf,
}

impl TempRoot {
    fn new(bot_token: &str, channel_id: u64) -> TempRoot {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!("pico-chat-e2e-{}-{nanos}", std::process::id()));

        let secrets = path.join("secrets");
        std::fs::create_dir_all(&secrets).unwrap();
        let token_file = secrets.join("discord_bot_token");
        std::fs::write(&token_file, bot_token).unwrap();
        std::fs::set_permissions(&token_file, std::fs::Permissions::from_mode(0o600)).unwrap();

        let profile = path.join("profiles").join("default");
        std::fs::create_dir_all(&profile).unwrap();
        std::fs::write(profile.join("config.toml"), "[llm]\nmodel = \"github-copilot/gpt-4o-mini\"\n").unwrap();

        let workdir = path.join("work");
        std::fs::create_dir_all(&workdir).unwrap();
        let bindings = format!(
            "[[binding]]\nchannel_id = \"{channel_id}\"\nprofile = \"default\"\nkind = \"regular\"\ncwd = \"{}\"\n",
            workdir.display()
        );
        std::fs::write(path.join("bindings.toml"), bindings).unwrap();

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
async fn bound_message_opens_thread_and_replies() {
    let _ = tracing_subscriber::fmt()
        .with_env_filter("pico_core=debug,info")
        .try_init();
    load_env();
    let pico_token = var("E2E_PICO_BOT_TOKEN");
    let driver_token = var("E2E_DRIVER_BOT_TOKEN");
    let channel_id: u64 = var("E2E_CHANNEL_ID")
        .parse()
        .expect("E2E_CHANNEL_ID must be a snowflake");
    let root = TempRoot::new(&pico_token, channel_id);

    let app = App::build(&root.path, None).await.expect("build pico app");
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
    tokio::time::timeout(Duration::from_secs(30), connected_rx)
        .await
        .expect("pico did not connect within 30s")
        .expect("on_connected never fired (setup likely errored)");

    // Driver bot posts a unique prompt in the bound channel.
    let driver = serenity::http::Http::new(&driver_token);
    let channel = serenity::ChannelId::new(channel_id);
    let marker = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis();
    let prompt = format!("Reply with exactly the single word: pong (e2e {marker})");
    let posted = channel.say(&driver, prompt).await.expect("driver failed to post");

    // pico should open a thread from that message and stream a "pong" reply.
    let mut thread: Option<serenity::ChannelId> = None;
    let mut replied = false;
    for _ in 0..20 {
        tokio::time::sleep(Duration::from_secs(3)).await;
        if thread.is_none()
            && let Ok(message) = channel.message(&driver, posted.id).await
            && let Some(started) = message.thread
        {
            thread = Some(started.id);
        }
        if let Some(tid) = thread
            && let Ok(messages) = tid.messages(&driver, serenity::GetMessages::new().limit(25)).await
            && messages.iter().any(|m| m.content.to_lowercase().contains("pong"))
        {
            replied = true;
            break;
        }
    }

    // Second turn inside the thread: pico's reply must natively reference it (the top-level message got none).
    let mut referenced = false;
    if let Some(tid) = thread {
        let followup = tid
            .say(&driver, format!("Reply with exactly the single word: pong (e2e {marker} b)"))
            .await
            .expect("driver failed to post follow-up in thread");
        for _ in 0..20 {
            tokio::time::sleep(Duration::from_secs(3)).await;
            if let Ok(messages) = tid.messages(&driver, serenity::GetMessages::new().limit(25)).await
                && messages
                    .iter()
                    .any(|m| m.message_reference.as_ref().and_then(|r| r.message_id) == Some(followup.id))
            {
                referenced = true;
                break;
            }
        }
    }

    // Tear down before asserting so a failure still cleans up the thread + bot.
    if let Some(tid) = thread {
        let _ = tid.delete(&driver).await;
    }
    let _ = shutdown_tx.send(());
    let shutdown = tokio::time::timeout(Duration::from_secs(15), server).await;

    assert!(thread.is_some(), "pico never opened a thread for the bound-channel message");
    assert!(replied, "pico opened a thread but never posted a 'pong' reply");
    assert!(referenced, "pico's in-thread reply did not reference the follow-up message");
    shutdown
        .expect("pico did not shut down within 15s")
        .expect("run task panicked")
        .expect("discord client returned an error");
}
