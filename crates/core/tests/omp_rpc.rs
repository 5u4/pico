use std::{
    path::PathBuf,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use pico_core::omp::{
    client::{OmpClient, SpawnConfig},
    protocol::{AssistantMessageEvent, OmpEvent, ToolCallStart, UiResponse},
};
use tokio_util::{sync::CancellationToken, task::TaskTracker};

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
        .expect("spawn omp --mode rpc");

    client.new_session().await.expect("new_session");
    client
        .set_model("github-copilot", "gpt-4o-mini")
        .await
        .expect("set_model to a known model");
    client.follow_up("noop follow-up").await.expect("follow_up");
    client.abort().await.expect("abort");

    let err = client
        .set_model("nope", "nope")
        .await
        .expect_err("set_model with an unknown model must fail");
    assert!(err.to_string().contains("Model not found"), "unexpected error: {err:#}");

    client.shutdown().await.expect("shutdown");
}

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
        .expect("spawn omp --mode rpc");
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
        .expect("spawn omp --mode rpc");
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
        .expect("spawn omp --mode rpc");
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
        .expect("spawn omp --mode rpc");

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

#[tokio::test]
#[ignore]
async fn abort_ends_an_in_flight_turn() {
    let cwd = TempDir::new("pico-omp-abort");
    let config = SpawnConfig {
        model: Some("github-copilot/gpt-4o-mini".to_owned()),
        cwd: Some(cwd.path.clone()),
        ..SpawnConfig::default()
    };

    let tracker = TaskTracker::new();
    let (client, mut events) = OmpClient::spawn(&config, &CancellationToken::new(), &tracker)
        .await
        .expect("spawn omp --mode rpc");
    client
        .prompt("Use the bash tool to run exactly this command and report its output: sleep 60 && echo done")
        .await
        .expect("prompt acked");

    loop {
        let event = tokio::time::timeout(Duration::from_secs(90), events.recv())
            .await
            .expect("timed out waiting for the bash tool to start")
            .expect("event stream closed before the tool started");
        match event {
            OmpEvent::ToolStart(ToolCallStart::Bash(_)) => break,
            OmpEvent::AgentEnd => panic!("turn ended before the bash tool started"),
            OmpEvent::Error(e) => panic!("omp reported an error: {e}"),
            _ => {}
        }
    }

    client.abort().await.expect("abort");

    let mut saw_end = false;
    while let Ok(recv) = tokio::time::timeout(Duration::from_secs(25), events.recv()).await {
        match recv.expect("event stream closed before agent_end") {
            OmpEvent::AgentEnd => {
                saw_end = true;
                break;
            }
            OmpEvent::Error(e) => panic!("omp reported an error: {e}"),
            _ => {}
        }
    }
    assert!(saw_end, "abort did not end the turn; agent_end never arrived");

    client.shutdown().await.expect("shutdown");
}
