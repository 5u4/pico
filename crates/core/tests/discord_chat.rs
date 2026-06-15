//! End-to-end chat-path test mostly driven by a deterministic scripted `omp`
//! (PATH-shadowed; see crates/worker/src/scripted_omp.rs); a trailing phase
//! swaps PATH back to the real omp for one Copilot smoke. The `ask` text-answer
//! matrix is answered by typing — Discord has no API for a bot to click a
//! component, so typing is the only bot-drivable path. `#[ignore]`d (two live
//! bots, MESSAGE_CONTENT intent); run `--include-ignored` with `.env.e2e`. The
//! pico bot connects once — a re-connect trips identify, so the smoke rides here.

use std::{
    os::unix::fs::{PermissionsExt, symlink},
    path::{Path, PathBuf},
    process::Command,
    sync::LazyLock,
    time::Duration,
};

use pico_core::app::App;
use poise::serenity_prelude as serenity;
use tokio::sync::oneshot;

/// The scripted `omp` stand-in, built once on demand beside this test binary.
static SCRIPTED_OMP: LazyLock<PathBuf> = LazyLock::new(|| {
    let cargo = std::env::var("CARGO").unwrap_or_else(|_| "cargo".into());
    let status = Command::new(cargo)
        .args([
            "build",
            "-p",
            "pico-worker",
            "--bin",
            "scripted-omp",
            "--features",
            "test-stub",
        ])
        .status()
        .expect("run cargo build -p pico-worker --bin scripted-omp --features test-stub");
    assert!(status.success(), "failed to build scripted-omp binary");
    let exe = std::env::current_exe().expect("current_exe");
    exe.parent()
        .and_then(Path::parent)
        .expect("test binary under <target>/<profile>/deps")
        .join("scripted-omp")
});

fn load_env() {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../.env.e2e");
    let _ = dotenvy::from_path(path);
}

fn var(key: &str) -> String {
    std::env::var(key).unwrap_or_else(|_| panic!("set {key} in .env.e2e at the workspace root (see .env.e2e.example)"))
}

/// A throwaway worker root: bot token, a `default` profile, a binding that
/// routes the e2e channel to it, and a config.toml registering the e2e guild so
/// the guild gate serves it. Removed on drop so a panicking test leaves nothing
/// behind.
struct TempRoot {
    path: PathBuf,
}

impl TempRoot {
    fn new(bot_token: &str, channel_id: u64, guild_id: u64) -> TempRoot {
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
        let config = format!(
            "[[guild]]\nid = \"{guild_id}\"\nprofile = \"default\"\ncwd = \"{}\"\n",
            workdir.display()
        );
        std::fs::write(path.join("config.toml"), config).unwrap();

        TempRoot { path }
    }
}

impl Drop for TempRoot {
    fn drop(&mut self) {
        std::fs::remove_dir_all(&self.path).ok();
    }
}

async fn wait_msg(
    tid: serenity::ChannelId,
    driver: &serenity::Http,
    attempts: usize,
    pred: impl Fn(&serenity::Message) -> bool,
) -> bool {
    for _ in 0..attempts {
        tokio::time::sleep(Duration::from_secs(3)).await;
        if let Ok(messages) = tid.messages(driver, serenity::GetMessages::new().limit(25)).await
            && messages.iter().any(&pred)
        {
            return true;
        }
    }
    false
}

/// Wait for the `❓` carrier (posted only after pico registers the answer), then type `answer`.
async fn answer_carrier(tid: serenity::ChannelId, driver: &serenity::Http, marker: &str, answer: &str) -> bool {
    if !wait_msg(tid, driver, 40, |m| m.content.contains('❓') && m.content.contains(marker)).await {
        return false;
    }
    tid.say(driver, answer).await.is_ok()
}

#[tokio::test]
#[ignore]
async fn scripted_omp_drives_thread_and_ask_flows() {
    let _ = tracing_subscriber::fmt()
        .with_env_filter("pico_core=debug,info")
        .try_init();
    load_env();
    let pico_token = var("E2E_PICO_BOT_TOKEN");
    let driver_token = var("E2E_DRIVER_BOT_TOKEN");
    let channel_id: u64 = var("E2E_CHANNEL_ID")
        .parse()
        .expect("E2E_CHANNEL_ID must be a snowflake");
    let guild_id: u64 = var("E2E_GUILD_ID").parse().expect("E2E_GUILD_ID must be a snowflake");
    let root = TempRoot::new(&pico_token, channel_id, guild_id);

    // Shadow `omp` with the scripted stand-in; set before the pool warms.
    let bindir = root.path.join("bin");
    std::fs::create_dir_all(&bindir).unwrap();
    symlink(&*SCRIPTED_OMP, bindir.join("omp")).unwrap();
    let original_path = std::env::var("PATH").unwrap_or_default();
    let shadowed = format!("{}:{}", bindir.display(), original_path);
    unsafe { std::env::set_var("PATH", shadowed) };

    let app = App::build(&root.path, None).await.expect("build pico app");
    let (connected_tx, connected_rx) = oneshot::channel();
    let (shutdown_tx, shutdown_rx) = oneshot::channel();
    let server = tokio::spawn(app.run(
        async move {
            let _ = shutdown_rx.await;
        },
        move || async move {
            let _ = connected_tx.send(());
            None
        },
    ));
    tokio::time::timeout(Duration::from_secs(30), connected_rx)
        .await
        .expect("pico did not connect within 30s")
        .expect("on_connected never fired (setup likely errored)");

    let driver = serenity::http::Http::new(&driver_token);
    let channel = serenity::ChannelId::new(channel_id);
    let marker = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis();

    let posted = channel
        .say(&driver, format!("TELL reply-{marker}"))
        .await
        .expect("driver failed to post");

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
            && wait_msg(tid, &driver, 1, |m| m.content.contains(&format!("reply-{marker}"))).await
        {
            replied = true;
            break;
        }
    }

    let initial_name: String = format!("TELL reply-{marker}").chars().take(90).collect();
    let mut renamed = false;
    if let Some(tid) = thread {
        for _ in 0..20 {
            tokio::time::sleep(Duration::from_secs(3)).await;
            if let Ok(serenity::Channel::Guild(gc)) = tid.to_channel(&driver).await
                && gc.name != initial_name
            {
                renamed = true;
                break;
            }
        }
    }

    let mut referenced = false;
    if let Some(tid) = thread {
        let followup = tid
            .say(&driver, format!("TELL reply-{marker}-b"))
            .await
            .expect("driver failed to post follow-up in thread");
        referenced = wait_msg(tid, &driver, 20, |m| {
            m.message_reference.as_ref().and_then(|r| r.message_id) == Some(followup.id)
        })
        .await;
    }

    let mut select_ok = false;
    let mut editor_ok = false;
    let mut multi_ok = false;
    if let Some(tid) = thread {
        let _ = tid.say(&driver, format!("ASK_SELECT cD-{marker}")).await;
        select_ok = answer_carrier(tid, &driver, &format!("cD-{marker}"), &format!("aD-{marker}")).await
            && wait_msg(tid, &driver, 20, |m| m.content.contains(&format!("DONE:aD-{marker}"))).await;

        let _ = tid.say(&driver, format!("ASK_EDITOR cE-{marker}")).await;
        editor_ok = answer_carrier(tid, &driver, &format!("cE-{marker}"), &format!("aE-{marker}")).await
            && wait_msg(tid, &driver, 20, |m| m.content.contains(&format!("DONE:aE-{marker}"))).await;

        let _ = tid.say(&driver, format!("ASK_MULTI cF1-{marker} cF2-{marker}")).await;
        multi_ok = answer_carrier(tid, &driver, &format!("cF1-{marker}"), &format!("aF1-{marker}")).await
            && answer_carrier(tid, &driver, &format!("cF2-{marker}"), &format!("aF2-{marker}")).await
            && wait_msg(tid, &driver, 20, |m| {
                m.content.contains(&format!("DONE:aF1-{marker}|aF2-{marker}"))
            })
            .await;
    }

    // Real-LLM smoke on the same gateway: swap PATH back so a fresh thread spawns
    // the real omp, and confirm one Copilot turn round-trips through Discord.
    unsafe { std::env::set_var("PATH", original_path) };
    let mut smoke_ok = false;
    if let Ok(smoke_msg) = channel
        .say(&driver, format!("Reply with exactly the single word: pong (e2e {marker})"))
        .await
    {
        let mut smoke_thread: Option<serenity::ChannelId> = None;
        for _ in 0..40 {
            tokio::time::sleep(Duration::from_secs(3)).await;
            if smoke_thread.is_none()
                && let Ok(m) = channel.message(&driver, smoke_msg.id).await
                && let Some(started) = m.thread
            {
                smoke_thread = Some(started.id);
            }
            if let Some(tid) = smoke_thread
                && wait_msg(tid, &driver, 1, |m| {
                    // A real "pong" omits the marker; the stub's prompt-echo would carry it.
                    let c = m.content.to_lowercase();
                    c.contains("pong") && !c.contains(&marker.to_string())
                })
                .await
            {
                smoke_ok = true;
                break;
            }
        }
        if let Some(tid) = smoke_thread {
            let _ = tid.delete(&driver).await;
        }
    }

    // Tear down before asserting so a failure still cleans up the thread + bot.
    if let Some(tid) = thread {
        let _ = tid.delete(&driver).await;
    }
    let _ = shutdown_tx.send(());
    let shutdown = tokio::time::timeout(Duration::from_secs(15), server).await;

    assert!(thread.is_some(), "pico never opened a thread for the bound-channel message");
    assert!(replied, "pico opened a thread but never posted the scripted reply");
    assert!(renamed, "pico opened a thread but never renamed it to the generated title");
    assert!(referenced, "pico's in-thread reply did not reference the follow-up message");
    assert!(select_ok, "typing an answer did not resolve a `select` ask (no DONE echo)");
    assert!(editor_ok, "typing an answer did not resolve an `editor` ask (no DONE echo)");
    assert!(
        multi_ok,
        "typing answers did not resolve the two-question sequence (no DONE echo)"
    );
    assert!(smoke_ok, "the real omp + Copilot smoke never replied through Discord");
    shutdown
        .expect("pico did not shut down within 15s")
        .expect("run task panicked")
        .expect("discord client returned an error");
}
