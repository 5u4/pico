//! End-to-end tests for the OMP RPC client. `#[ignore]`d by default: they spawn
//! the real `omp --mode rpc-ui` binary (Bun), and `streams_a_prompt_reply` /
//! `ask_tool_round_trips_a_selection` also hit GitHub Copilot over the network.
//! Run with `--include-ignored`.

use std::{
    path::PathBuf,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use pico_core::omp::{
    client::{OmpClient, SpawnConfig},
    protocol::{AssistantMessageEvent, OmpEvent, ToolCallStart, UiRequest, UiResponse},
};
use tokio_util::{sync::CancellationToken, task::TaskTracker};

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
/// populated; new_session/set_model/abort/follow_up resolve locally — no prompt,
/// no network — and an unknown model exercises the failure path.
#[tokio::test]
#[ignore]
async fn roundtrip_commands_without_model_calls() {
    let cwd = TempDir::new("pico-omp-cwd");
    let config = SpawnConfig {
        model: Some("github-copilot/gpt-4o-mini".to_owned()),
        cwd: Some(cwd.path.clone()),
        ..SpawnConfig::default()
    };

    let tracker = TaskTracker::new();
    let (client, _events) = OmpClient::spawn(&config, &CancellationToken::new(), &tracker)
        .await
        .expect("spawn omp --mode rpc-ui");

    client.new_session().await.expect("new_session");
    client
        .set_model("github-copilot", "gpt-4o-mini")
        .await
        .expect("set_model to a known model");
    // follow_up queues a message for after the (here absent) turn; it acks
    // without starting a model call.
    client.follow_up("noop follow-up").await.expect("follow_up");
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
        ..SpawnConfig::default()
    };

    let tracker = TaskTracker::new();
    let (client, mut events) = OmpClient::spawn(&config, &CancellationToken::new(), &tracker)
        .await
        .expect("spawn omp --mode rpc-ui");
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

/// A real `tool_execution_start` frame must classify through the
/// `#[serde(from = "ToolCall")]` path; the text-only cases never decode a tool.
#[tokio::test]
#[ignore]
async fn classifies_a_real_tool_call() {
    let cwd = TempDir::new("pico-omp-tool");
    let config = SpawnConfig {
        model: Some("github-copilot/gpt-4o-mini".to_owned()),
        cwd: Some(cwd.path.clone()),
        ..SpawnConfig::default()
    };

    let tracker = TaskTracker::new();
    let (client, mut events) = OmpClient::spawn(&config, &CancellationToken::new(), &tracker)
        .await
        .expect("spawn omp --mode rpc-ui");
    client
        .prompt("Run this shell command with the bash tool and report nothing else: echo pong")
        .await
        .expect("prompt acked");

    let mut bash_command: Option<String> = None;
    let mut other_tools: Vec<String> = Vec::new();
    loop {
        let event = tokio::time::timeout(Duration::from_secs(90), events.recv())
            .await
            .expect("timed out waiting for omp events")
            .expect("event stream closed before agent_end");
        match event {
            OmpEvent::ToolStart(ToolCallStart::Bash(call)) => {
                bash_command = Some(call.args["command"].as_str().unwrap_or_default().to_owned());
            }
            OmpEvent::ToolStart(other) => other_tools.push(other.call().tool_name.clone()),
            OmpEvent::AgentEnd => break,
            OmpEvent::Error(e) => panic!("omp reported an error: {e}"),
            _ => {}
        }
    }

    let command = bash_command.unwrap_or_else(|| panic!("no bash tool call decoded; saw tools: {other_tools:?}"));
    assert!(command.contains("echo"), "bash command was: {command:?}");

    client.shutdown().await.expect("shutdown");
}

/// A real `task` call's `tool_execution_update` must carry the
/// `details.progress[]` shape `apply_progress` reads. Slow: spawns a subagent.
#[tokio::test]
#[ignore]
async fn task_update_carries_subagent_progress() {
    let cwd = TempDir::new("pico-omp-task");
    let config = SpawnConfig {
        model: Some("github-copilot/gpt-4o-mini".to_owned()),
        cwd: Some(cwd.path.clone()),
        ..SpawnConfig::default()
    };

    let tracker = TaskTracker::new();
    let (client, mut events) = OmpClient::spawn(&config, &CancellationToken::new(), &tracker)
        .await
        .expect("spawn omp --mode rpc-ui");
    client
        .prompt(
            "Use the task tool to spawn exactly one subagent: agent type \"explore\", one task whose \
             assignment is to reply with the single word done. Use the task tool — do not do it yourself.",
        )
        .await
        .expect("prompt acked");

    let mut saw_task_start = false;
    let mut saw_progress = false;
    loop {
        let event = tokio::time::timeout(Duration::from_secs(180), events.recv())
            .await
            .expect("timed out waiting for omp events")
            .expect("event stream closed before agent_end");
        match event {
            OmpEvent::ToolStart(ToolCallStart::Task(_)) => saw_task_start = true,
            OmpEvent::ToolUpdate(update)
                if update.tool_name == "task" && update.partial_result["details"]["progress"].is_array() =>
            {
                saw_progress = true;
            }
            OmpEvent::AgentEnd => break,
            OmpEvent::Error(e) => panic!("omp reported an error: {e}"),
            _ => {}
        }
    }

    assert!(saw_task_start, "never saw a task tool_execution_start");
    assert!(saw_progress, "task tool_execution_update never carried details.progress[]");

    client.shutdown().await.expect("shutdown");
}

/// The `ask` tool blocks (no default timeout) until the host answers its
/// `extension_ui_request`; drive a real call, reply, and assert it resolves.
#[tokio::test]
#[ignore]
async fn ask_tool_round_trips_a_selection() {
    let cwd = TempDir::new("pico-omp-ask");
    let config = SpawnConfig {
        model: Some("github-copilot/gpt-4o-mini".to_owned()),
        cwd: Some(cwd.path.clone()),
        ..SpawnConfig::default()
    };

    let tracker = TaskTracker::new();
    let (client, mut events) = OmpClient::spawn(&config, &CancellationToken::new(), &tracker)
        .await
        .expect("spawn omp --mode rpc-ui");
    client
        .prompt(
            "Use the ask tool — and nothing else — to ask me to pick a color. Provide exactly two \
             options: \"Red\" and \"Blue\". You MUST call the ask tool and wait for my selection; do \
             not answer yourself or pick for me.",
        )
        .await
        .expect("prompt acked");

    let mut chosen: Option<String> = None;
    let mut ask_succeeded = false;
    loop {
        let event = tokio::time::timeout(Duration::from_secs(120), events.recv())
            .await
            .expect("timed out waiting for omp events")
            .expect("event stream closed before agent_end");
        match event {
            // Pick a real option (not "Other", which would chain into an editor).
            OmpEvent::UiRequest(UiRequest::Select { id, options, .. }) => {
                let choice = options
                    .iter()
                    .find(|o| !o.contains("Other"))
                    .cloned()
                    .unwrap_or_else(|| options.first().cloned().unwrap_or_default());
                client
                    .ui_response(&UiResponse::value(&id, &choice))
                    .await
                    .expect("send extension_ui_response");
                chosen = Some(choice);
            }
            OmpEvent::ToolEnd(end) if end.tool_name == "ask" => {
                ask_succeeded = !end.is_error;
            }
            OmpEvent::AgentEnd => break,
            OmpEvent::Error(e) => panic!("omp reported an error: {e}"),
            _ => {}
        }
    }
    let chosen = chosen.expect("never received an `ask` select request to answer");
    assert!(
        chosen.contains("Red") || chosen.contains("Blue"),
        "unexpected option set: {chosen:?}"
    );
    assert!(
        ask_succeeded,
        "ask tool did not resolve successfully after the selection was sent"
    );

    client.shutdown().await.expect("shutdown");
}

/// Picking "Other" chains the select into an `editor` request; the host answers
/// it with free text and the ask must resolve with that custom input. Grounds the
/// editor round-trip that `ui::text_prompt`'s modal loop drives.
#[tokio::test]
#[ignore]
async fn ask_tool_round_trips_custom_input() {
    let cwd = TempDir::new("pico-omp-ask-custom");
    let config = SpawnConfig {
        model: Some("github-copilot/gpt-4o-mini".to_owned()),
        cwd: Some(cwd.path.clone()),
        ..SpawnConfig::default()
    };

    let tracker = TaskTracker::new();
    let (client, mut events) = OmpClient::spawn(&config, &CancellationToken::new(), &tracker)
        .await
        .expect("spawn omp --mode rpc-ui");
    client
        .prompt(
            "Use the ask tool — and nothing else — to ask me to pick a color. Provide exactly two \
             options: \"Red\" and \"Blue\". You MUST call the ask tool and wait for my selection; do \
             not answer yourself or pick for me.",
        )
        .await
        .expect("prompt acked");

    const CUSTOM: &str = "Chartreuse";
    let mut saw_editor = false;
    let mut ask_succeeded = false;
    loop {
        let event = tokio::time::timeout(Duration::from_secs(120), events.recv())
            .await
            .expect("timed out waiting for omp events")
            .expect("event stream closed before agent_end");
        match event {
            // Choose "Other (type your own)" to force the editor follow-up.
            OmpEvent::UiRequest(UiRequest::Select { id, options, .. }) => {
                let other = options
                    .iter()
                    .find(|o| o.contains("Other"))
                    .cloned()
                    .expect("select offered no Other option");
                client
                    .ui_response(&UiResponse::value(&id, &other))
                    .await
                    .expect("send select response");
            }
            OmpEvent::UiRequest(UiRequest::Editor { id, .. }) => {
                saw_editor = true;
                client
                    .ui_response(&UiResponse::value(&id, CUSTOM))
                    .await
                    .expect("send editor response");
            }
            OmpEvent::ToolEnd(end) if end.tool_name == "ask" => {
                ask_succeeded = !end.is_error;
            }
            OmpEvent::AgentEnd => break,
            OmpEvent::Error(e) => panic!("omp reported an error: {e}"),
            _ => {}
        }
    }
    assert!(saw_editor, "picking Other never produced an editor request");
    assert!(ask_succeeded, "ask tool did not resolve after the custom input was sent");

    client.shutdown().await.expect("shutdown");
}

/// The hardening for unrecognised UI methods replies `cancelled` keyed by the
/// request's `id`. That is only safe if OMP ignores a response whose `id` has no
/// pending dialog (a fire-and-forget method, or a method this build doesn't
/// model). Send a bogus `extension_ui_response`, then a normal prompt, and assert
/// the session still completes the turn — i.e. the stray reply didn't wedge it.
#[tokio::test]
#[ignore]
async fn stale_ui_response_is_ignored() {
    let cwd = TempDir::new("pico-omp-stale-ui");
    let config = SpawnConfig {
        model: Some("github-copilot/gpt-4o-mini".to_owned()),
        cwd: Some(cwd.path.clone()),
        ..SpawnConfig::default()
    };

    let tracker = TaskTracker::new();
    let (client, mut events) = OmpClient::spawn(&config, &CancellationToken::new(), &tracker)
        .await
        .expect("spawn omp --mode rpc-ui");

    // No dialog is pending, so this id matches nothing — OMP must drop it.
    client
        .ui_response(&UiResponse::cancelled("no-such-dialog", false))
        .await
        .expect("send stale extension_ui_response");

    client
        .prompt("Reply with exactly the word: pong")
        .await
        .expect("prompt acked");

    let mut reply = String::new();
    loop {
        let event = tokio::time::timeout(Duration::from_secs(90), events.recv())
            .await
            .expect("timed out waiting for omp events")
            .expect("event stream closed before agent_end");
        match event {
            OmpEvent::Message(AssistantMessageEvent::TextDelta { delta }) => reply.push_str(&delta),
            OmpEvent::AgentEnd => break,
            OmpEvent::Error(e) => panic!("omp reported an error: {e}"),
            _ => {}
        }
    }

    assert!(
        reply.to_lowercase().contains("pong"),
        "turn did not complete normally; reply was {reply:?}"
    );

    client.shutdown().await.expect("shutdown");
}
