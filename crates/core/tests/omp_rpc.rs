//! End-to-end tests for the OMP RPC client. `#[ignore]`d by default: they spawn
//! the real `omp --mode rpc` binary (Bun), and `streams_a_prompt_reply` also
//! hits GitHub Copilot over the network. Run with `--include-ignored`.

use std::{
    path::PathBuf,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use pico_core::omp::{
    client::{OmpClient, SpawnConfig},
    protocol::{AssistantMessageEvent, OmpEvent},
};

/// A throwaway directory removed on drop, so a panicking test leaves nothing
/// behind under `$TMPDIR`.
struct TempDir {
    path: PathBuf,
}

impl TempDir {
    fn new(prefix: &str) -> TempDir {
        let nanos = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let path = std::env::temp_dir().join(format!("{prefix}-{}-{nanos}", std::process::id()));
        std::fs::create_dir_all(&path).unwrap();
        TempDir { path }
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        std::fs::remove_dir_all(&self.path).ok();
    }
}

/// Drives the command/response plumbing against the real binary without an LLM
/// call. Uses the developer's authenticated agent dir so the model catalog is
/// populated; `new_session`/`set_model`/`abort` resolve locally — no prompt, no
/// network — and an unknown model exercises the failure path.
#[tokio::test]
#[ignore]
async fn roundtrip_commands_without_model_calls() {
    let cwd = TempDir::new("pico-omp-cwd");
    let config = SpawnConfig {
        model: Some("github-copilot/gpt-4o-mini".to_owned()),
        cwd: Some(cwd.path.clone()),
        copilot_token: None,
    };

    let (client, _events) = OmpClient::spawn(&config).await.expect("spawn omp --mode rpc");

    client.new_session().await.expect("new_session");
    client
        .set_model("github-copilot", "gpt-4o-mini")
        .await
        .expect("set_model to a known model");
    client.abort().await.expect("abort");

    let err = client
        .set_model("nope", "nope")
        .await
        .expect_err("set_model with an unknown model must fail");
    assert!(err.to_string().contains("Model not found"), "unexpected error: {err:#}");

    client.shutdown().await.expect("shutdown");
}

/// Spawns OMP against the developer's authenticated agent dir and streams a real
/// Copilot reply, asserting the AgentStart → text deltas → AgentEnd lifecycle.
#[tokio::test]
#[ignore]
async fn streams_a_prompt_reply() {
    let cwd = TempDir::new("pico-omp-cwd");
    let config = SpawnConfig {
        model: Some("github-copilot/gpt-4o-mini".to_owned()),
        cwd: Some(cwd.path.clone()),
        copilot_token: None,
    };

    let (client, mut events) = OmpClient::spawn(&config).await.expect("spawn omp --mode rpc");
    client
        .prompt("Reply with exactly the word: pong")
        .await
        .expect("prompt acked");

    let mut saw_start = false;
    let mut reply = String::new();
    loop {
        let event = tokio::time::timeout(Duration::from_secs(90), events.recv())
            .await
            .expect("timed out waiting for omp events")
            .expect("event stream closed before agent_end");
        match event {
            OmpEvent::AgentStart => saw_start = true,
            OmpEvent::Message(AssistantMessageEvent::TextDelta { delta }) => reply.push_str(&delta),
            OmpEvent::AgentEnd => break,
            OmpEvent::Error(e) => panic!("omp reported an error: {e}"),
            _ => {}
        }
    }

    assert!(saw_start, "never saw agent_start");
    assert!(reply.to_lowercase().contains("pong"), "reply was: {reply:?}");

    client.shutdown().await.expect("shutdown");
}
