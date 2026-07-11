use std::{
    path::PathBuf,
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use pico_core::omp::{
    client::{HostConfig, OmpHost, OmpSessionHandle, SessionConfig},
    pool::OmpPool,
    protocol::{AssistantMessageEvent, OmpEvent, UiResponse},
};
use tokio::sync::mpsc;
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

async fn open_session(
    session_id: &str,
    cwd: &TempDir,
    cancel: &CancellationToken,
    tracker: &TaskTracker,
) -> (Arc<OmpHost>, OmpSessionHandle, mpsc::UnboundedReceiver<OmpEvent>) {
    let host = OmpHost::spawn(&HostConfig::default(), cancel, tracker)
        .await
        .expect("spawn omp host");
    let config = SessionConfig {
        cwd: cwd.path.clone(),
        session_dir: cwd.path.clone(),
        profile: "default".into(),
        ..SessionConfig::default()
    };
    let (client, events) = host.open_session(session_id, &config).await.expect("open_session");
    (host, client, events)
}

async fn drain_reply(events: &mut mpsc::UnboundedReceiver<OmpEvent>) -> String {
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
    reply
}

#[tokio::test]
#[ignore]
async fn roundtrip_commands_without_model_calls() {
    let cwd = TempDir::new("pico-omp-cwd");
    let cancel = CancellationToken::new();
    let tracker = TaskTracker::new();
    let (_host, client, _events) = open_session("roundtrip", &cwd, &cancel, &tracker).await;

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
    assert!(!err.to_string().is_empty(), "rejection should carry a message: {err:#}");

    client.close().await.expect("close");
    cancel.cancel();
}

#[tokio::test]
#[ignore]
async fn streams_a_prompt_reply() {
    let cwd = TempDir::new("pico-omp-cwd");
    let cancel = CancellationToken::new();
    let tracker = TaskTracker::new();
    let (_host, client, mut events) = open_session("stream", &cwd, &cancel, &tracker).await;
    client
        .prompt("Reply with exactly the word: pong", &[])
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

    client.close().await.expect("close");
    cancel.cancel();
}

#[tokio::test]
#[ignore]
async fn two_sessions_on_one_host_stay_isolated() {
    let cwd_a = TempDir::new("pico-omp-mux-a");
    let cwd_b = TempDir::new("pico-omp-mux-b");
    let cancel = CancellationToken::new();
    let tracker = TaskTracker::new();
    let host = OmpHost::spawn(&HostConfig::default(), &cancel, &tracker)
        .await
        .expect("spawn omp host");
    let cfg_a = SessionConfig {
        cwd: cwd_a.path.clone(),
        session_dir: cwd_a.path.clone(),
        profile: "default".into(),
        ..SessionConfig::default()
    };
    let cfg_b = SessionConfig {
        cwd: cwd_b.path.clone(),
        session_dir: cwd_b.path.clone(),
        profile: "default".into(),
        ..SessionConfig::default()
    };
    let (client_a, mut events_a) = host.open_session("mux-a", &cfg_a).await.expect("open session a");
    let (client_b, mut events_b) = host.open_session("mux-b", &cfg_b).await.expect("open session b");

    client_a
        .prompt("Reply with exactly the word: alpha", &[])
        .await
        .expect("prompt a");
    client_b
        .prompt("Reply with exactly the word: bravo", &[])
        .await
        .expect("prompt b");

    let reply_a = drain_reply(&mut events_a).await;
    let reply_b = drain_reply(&mut events_b).await;

    assert!(reply_a.to_lowercase().contains("alpha"), "session A reply was: {reply_a:?}");
    assert!(
        !reply_a.to_lowercase().contains("bravo"),
        "session A leaked B's reply: {reply_a:?}"
    );
    assert!(reply_b.to_lowercase().contains("bravo"), "session B reply was: {reply_b:?}");
    assert!(
        !reply_b.to_lowercase().contains("alpha"),
        "session B leaked A's reply: {reply_b:?}"
    );

    client_a.close().await.expect("close a");
    client_b.close().await.expect("close b");
    cancel.cancel();
}

#[tokio::test]
#[ignore]
async fn concurrent_get_or_spawn_same_thread_shares_one_session() {
    let cwd = TempDir::new("pico-omp-race");
    let cancel = CancellationToken::new();
    let tracker = TaskTracker::new();
    let pool = OmpPool::new(cwd.path.clone(), HostConfig::default(), cancel.clone(), &tracker);
    let cfg = SessionConfig {
        cwd: cwd.path.clone(),
        session_dir: cwd.path.clone(),
        profile: "default".into(),
        ..SessionConfig::default()
    };

    let (ra, rb, rc) = tokio::join!(
        pool.get_or_spawn("same", &cfg),
        pool.get_or_spawn("same", &cfg),
        pool.get_or_spawn("same", &cfg),
    );
    let handle = ra.expect("open a");
    let handle_b = rb.expect("open b");
    let handle_c = rc.expect("open c");
    assert!(
        Arc::ptr_eq(&handle, &handle_b) && Arc::ptr_eq(&handle_b, &handle_c),
        "concurrent get_or_spawn for one thread returned different sessions"
    );

    let (_turn, mut events) = handle.begin_turn().await;
    handle
        .client()
        .prompt("Reply with exactly the word: pong", &[])
        .await
        .expect("shared session prompt");
    let reply = drain_reply(&mut events).await;
    assert!(reply.to_lowercase().contains("pong"), "shared session reply was: {reply:?}");

    cancel.cancel();
}

#[tokio::test]
#[ignore]
async fn append_system_prompt_content_reaches_the_model() {
    let cwd = TempDir::new("pico-omp-append");
    let append = cwd.path.join("append.md");
    std::fs::write(
        &append,
        "IMPORTANT: when asked for the secret pico codeword, reply with exactly the word: platypus",
    )
    .expect("write append file");
    let cancel = CancellationToken::new();
    let tracker = TaskTracker::new();
    let host = OmpHost::spawn(&HostConfig::default(), &cancel, &tracker)
        .await
        .expect("spawn omp host");
    let config = SessionConfig {
        cwd: cwd.path.clone(),
        session_dir: cwd.path.clone(),
        append_system_prompt: Some(append.clone()),
        profile: "default".into(),
        ..SessionConfig::default()
    };
    let (client, mut events) = host.open_session("append", &config).await.expect("open session");
    client
        .prompt("What is the secret pico codeword? Reply with only the word.", &[])
        .await
        .expect("prompt");
    let reply = drain_reply(&mut events).await;
    assert!(
        reply.to_lowercase().contains("platypus"),
        "append-system-prompt content did not reach the model; reply: {reply:?}"
    );
    client.close().await.expect("close");
    cancel.cancel();
}

#[tokio::test]
#[ignore]
async fn classifies_a_real_tool_call() {
    let cwd = TempDir::new("pico-omp-tool");
    let cancel = CancellationToken::new();
    let tracker = TaskTracker::new();
    let (_host, client, mut events) = open_session("tool", &cwd, &cancel, &tracker).await;
    client
        .prompt(
            "Run this shell command with the bash tool and report nothing else: echo pong",
            &[],
        )
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
            OmpEvent::ToolStart(call) if call.tool_name == "bash" => {
                bash_command = Some(call.args["command"].as_str().unwrap_or_default().to_owned());
            }
            OmpEvent::ToolStart(call) => other_tools.push(call.tool_name.clone()),
            OmpEvent::AgentEnd => break,
            OmpEvent::Error(e) => panic!("omp reported an error: {e}"),
            _ => {}
        }
    }

    let command = bash_command.unwrap_or_else(|| panic!("no bash tool call decoded; saw tools: {other_tools:?}"));
    assert!(command.contains("echo"), "bash command was: {command:?}");

    client.close().await.expect("close");
    cancel.cancel();
}

#[tokio::test]
#[ignore]
async fn task_update_carries_subagent_progress() {
    let cwd = TempDir::new("pico-omp-task");
    let cancel = CancellationToken::new();
    let tracker = TaskTracker::new();
    let (_host, client, mut events) = open_session("task", &cwd, &cancel, &tracker).await;
    client
        .prompt(
            "Use the task tool to spawn exactly one subagent: agent type \"scout\", one task whose \
     assignment is to reply with the single word done. Use the task tool — do not do it yourself.",
            &[],
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
            OmpEvent::ToolStart(call) if call.tool_name == "task" => saw_task_start = true,
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

    client.close().await.expect("close");
    cancel.cancel();
}

#[tokio::test]
#[ignore]
async fn stale_ui_response_is_ignored() {
    let cwd = TempDir::new("pico-omp-stale-ui");
    let cancel = CancellationToken::new();
    let tracker = TaskTracker::new();
    let (_host, client, mut events) = open_session("stale-ui", &cwd, &cancel, &tracker).await;

    client
        .ui_response(&UiResponse::cancelled(client.session_id(), "no-such-dialog", false))
        .await
        .expect("send stale extension_ui_response");

    client
        .prompt("Reply with exactly the word: pong", &[])
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

    client.close().await.expect("close");
    cancel.cancel();
}

#[tokio::test]
#[ignore]
async fn abort_ends_an_in_flight_turn() {
    let cwd = TempDir::new("pico-omp-abort");
    let cancel = CancellationToken::new();
    let tracker = TaskTracker::new();
    let (_host, client, mut events) = open_session("abort", &cwd, &cancel, &tracker).await;
    client
        .prompt(
            "Use the bash tool to run exactly this command and report its output: sleep 60 && echo done",
            &[],
        )
        .await
        .expect("prompt acked");

    loop {
        let event = tokio::time::timeout(Duration::from_secs(90), events.recv())
            .await
            .expect("timed out waiting for the bash tool to start")
            .expect("event stream closed before the tool started");
        match event {
            OmpEvent::ToolStart(call) if call.tool_name == "bash" => break,
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

    client.close().await.expect("close");
    cancel.cancel();
}

#[tokio::test]
#[ignore]
async fn distinct_profiles_get_distinct_hosts() {
    let root = TempDir::new("pico-omp-profiles-root");
    let cwd_a = TempDir::new("pico-omp-profiles-a");
    let cwd_b = TempDir::new("pico-omp-profiles-b");
    let cancel = CancellationToken::new();
    let tracker = TaskTracker::new();
    let pool = OmpPool::new(root.path.clone(), HostConfig::default(), cancel.clone(), &tracker);
    let cfg_a = SessionConfig {
        cwd: cwd_a.path.clone(),
        session_dir: cwd_a.path.clone(),
        profile: "alpha".into(),
        ..SessionConfig::default()
    };
    let cfg_b = SessionConfig {
        cwd: cwd_b.path.clone(),
        session_dir: cwd_b.path.clone(),
        profile: "bravo".into(),
        ..SessionConfig::default()
    };

    let handle_a = pool
        .get_or_spawn("profile-alpha", &cfg_a)
        .await
        .expect("open alpha session");
    let handle_b = pool
        .get_or_spawn("profile-bravo", &cfg_b)
        .await
        .expect("open bravo session");

    assert!(
        !Arc::ptr_eq(&handle_a, &handle_b),
        "distinct profiles must get distinct sessions"
    );
    assert_eq!(
        pool.host_count().await,
        2,
        "two distinct profiles must spawn two distinct hosts"
    );

    let (_turn_a, mut events_a) = handle_a.begin_turn().await;
    let (_turn_b, mut events_b) = handle_b.begin_turn().await;
    handle_a
        .client()
        .prompt("Reply with exactly the word: alpha", &[])
        .await
        .expect("prompt alpha");
    handle_b
        .client()
        .prompt("Reply with exactly the word: bravo", &[])
        .await
        .expect("prompt bravo");
    let reply_a = drain_reply(&mut events_a).await;
    let reply_b = drain_reply(&mut events_b).await;

    assert!(reply_a.to_lowercase().contains("alpha"), "profile alpha reply was: {reply_a:?}");
    assert!(
        !reply_a.to_lowercase().contains("bravo"),
        "profile alpha leaked profile bravo's reply: {reply_a:?}"
    );
    assert!(reply_b.to_lowercase().contains("bravo"), "profile bravo reply was: {reply_b:?}");
    assert!(
        !reply_b.to_lowercase().contains("alpha"),
        "profile bravo leaked profile alpha's reply: {reply_b:?}"
    );

    cancel.cancel();
}

#[tokio::test]
#[ignore]
async fn same_profile_threads_share_one_host() {
    let root = TempDir::new("pico-omp-share-root");
    let cwd_a = TempDir::new("pico-omp-share-a");
    let cwd_b = TempDir::new("pico-omp-share-b");
    let cancel = CancellationToken::new();
    let tracker = TaskTracker::new();
    let pool = OmpPool::new(root.path.clone(), HostConfig::default(), cancel.clone(), &tracker);
    let cfg_a = SessionConfig {
        cwd: cwd_a.path.clone(),
        session_dir: cwd_a.path.clone(),
        profile: "default".into(),
        ..SessionConfig::default()
    };
    let cfg_b = SessionConfig {
        cwd: cwd_b.path.clone(),
        session_dir: cwd_b.path.clone(),
        profile: "default".into(),
        ..SessionConfig::default()
    };

    let handle_a = pool
        .get_or_spawn("share-one", &cfg_a)
        .await
        .expect("open first session");
    let handle_b = pool
        .get_or_spawn("share-two", &cfg_b)
        .await
        .expect("open second session");

    assert!(
        !Arc::ptr_eq(&handle_a, &handle_b),
        "distinct threads must get distinct sessions"
    );
    assert_eq!(
        pool.host_count().await,
        1,
        "two threads under one profile must share a single host"
    );

    let (_turn, mut events) = handle_a.begin_turn().await;
    handle_a
        .client()
        .prompt("Reply with exactly the word: pong", &[])
        .await
        .expect("shared-host prompt");
    let reply = drain_reply(&mut events).await;
    assert!(reply.to_lowercase().contains("pong"), "shared-host reply was: {reply:?}");

    cancel.cancel();
}

#[tokio::test]
#[ignore]
async fn rebinding_a_thread_to_a_new_profile_replaces_the_session() {
    let root = TempDir::new("pico-omp-rebind-root");
    let cwd_a = TempDir::new("pico-omp-rebind-a");
    let cwd_b = TempDir::new("pico-omp-rebind-b");
    let cancel = CancellationToken::new();
    let tracker = TaskTracker::new();
    let pool = OmpPool::new(root.path.clone(), HostConfig::default(), cancel.clone(), &tracker);
    let cfg_a = SessionConfig {
        cwd: cwd_a.path.clone(),
        session_dir: cwd_a.path.clone(),
        profile: "alpha".into(),
        ..SessionConfig::default()
    };
    let cfg_b = SessionConfig {
        cwd: cwd_b.path.clone(),
        session_dir: cwd_b.path.clone(),
        profile: "bravo".into(),
        ..SessionConfig::default()
    };

    let handle_a = pool
        .get_or_spawn("rebound-thread", &cfg_a)
        .await
        .expect("open alpha session");
    assert_eq!(handle_a.profile(), "alpha");

    let handle_b = pool
        .get_or_spawn("rebound-thread", &cfg_b)
        .await
        .expect("reopen under bravo");

    assert_eq!(
        handle_b.profile(),
        "bravo",
        "same thread reopened under a new profile must get the new profile's session"
    );
    assert!(
        !Arc::ptr_eq(&handle_a, &handle_b),
        "a profile change must not return the stale session"
    );
    assert_eq!(
        pool.host_count().await,
        2,
        "the new profile's host must be spawned alongside the old one"
    );

    cancel.cancel();
}

#[tokio::test]
#[ignore]
async fn context_shake_compact_roundtrip() {
    let cwd = TempDir::new("pico-omp-cwd");
    let cancel = CancellationToken::new();
    let tracker = TaskTracker::new();
    let (_host, client, _events) = open_session("maintenance", &cwd, &cancel, &tracker).await;
    client
        .set_model("github-copilot", "gpt-4o-mini")
        .await
        .expect("set_model to a known model");

    let context = client
        .context()
        .await
        .expect("context round-trips")
        .expect("context returns text");
    assert!(
        context.to_lowercase().contains("tokens"),
        "context report should mention tokens: {context:?}"
    );

    let shake = client
        .shake("elide")
        .await
        .expect("shake round-trips")
        .expect("shake returns a summary");
    assert!(!shake.trim().is_empty(), "shake summary should be non-empty");

    match client.compact(None).await {
        Ok(text) => assert!(text.is_some(), "compact success must carry a summary"),
        Err(e) => {
            let msg = e.to_string();
            assert!(!msg.is_empty(), "compact failure must carry a message: {e:#}");
            assert!(
                !msg.contains("unknown command"),
                "compact must be wired through the host: {e:#}"
            );
        }
    }

    client.close().await.expect("close");
    cancel.cancel();
}

#[tokio::test]
#[ignore]
async fn background_task_auto_delivers_a_second_turn() {
    let cwd = TempDir::new("pico-omp-bg");
    let cancel = CancellationToken::new();
    let tracker = TaskTracker::new();
    let (_host, client, mut events) = open_session("bg", &cwd, &cancel, &tracker).await;
    client
        .prompt(
            "Use the task tool to spawn exactly one subagent: agent type \"task\", one task whose \
     assignment is to run the bash command `sleep 20 && echo BGDONE` and report its output. \
     After the task tool returns its spawn acknowledgement, do NOT poll and do NOT wait — \
     immediately end your turn with a one-line message saying you launched it in the background.",
            &[],
        )
        .await
        .expect("prompt acked");

    let mut log: Vec<String> = Vec::new();
    let mut agent_ends = 0;
    let start = std::time::Instant::now();
    let mut tail_deadline: Option<std::time::Instant> = None;
    let deadline = std::time::Instant::now() + Duration::from_secs(120);
    loop {
        let cap = tail_deadline.unwrap_or(deadline);
        let remaining = cap.saturating_duration_since(std::time::Instant::now());
        if remaining.is_zero() {
            break;
        }
        let recv = tokio::time::timeout(remaining, events.recv()).await;
        let Ok(event) = recv else { break };
        let Some(event) = event else { break };
        let at = start.elapsed().as_millis();
        let label = match &event {
            OmpEvent::AgentStart => "agent_start".to_owned(),
            OmpEvent::AgentEnd => {
                agent_ends += 1;
                format!("agent_end#{agent_ends}")
            }
            OmpEvent::TurnEnd => "turn_end".to_owned(),
            OmpEvent::ToolStart(c) => format!("tool_start:{}", c.tool_name),
            OmpEvent::ToolUpdate(c) => format!("tool_update:{}", c.tool_name),
            OmpEvent::ToolEnd(c) => format!("tool_end:{}", c.tool_name),
            OmpEvent::CustomMessage { custom_type } => format!("custom:{custom_type}"),
            OmpEvent::Message(AssistantMessageEvent::TextDelta { .. }) => "text_delta".to_owned(),
            OmpEvent::Message(_) => "msg_other".to_owned(),
            OmpEvent::MessageEnd(_) => "message_end".to_owned(),
            OmpEvent::UiRequest(_) => "ui_request".to_owned(),
            OmpEvent::Error(e) => panic!("omp reported an error: {e}"),
        };
        log.push(format!("{at}ms:{label}"));
        if agent_ends >= 2 && tail_deadline.is_none() {
            tail_deadline = Some(std::time::Instant::now() + Duration::from_secs(12));
        }
    }

    eprintln!("BG_EVENT_LOG: {log:#?}");
    assert!(agent_ends >= 2, "second (async-result) turn never arrived; log: {log:?}");

    client.close().await.expect("close");
    cancel.cancel();
}

struct RecordingLauncher {
    tx: mpsc::UnboundedSender<bool>,
    tracker: TaskTracker,
}

impl pico_core::omp::pool::BackgroundTurnLauncher for RecordingLauncher {
    fn launch(
        &self,
        _thread_id: String,
        _client: OmpSessionHandle,
        token: pico_core::omp::pool::TurnToken,
        mut events: mpsc::UnboundedReceiver<OmpEvent>,
    ) {
        let tx = self.tx.clone();
        self.tracker.spawn(async move {
            let _token = token;
            while let Ok(Some(event)) = tokio::time::timeout(Duration::from_secs(60), events.recv()).await {
                if matches!(event, OmpEvent::AgentEnd) {
                    let _ = tx.send(true);
                    return;
                }
            }
            let _ = tx.send(false);
        });
    }
}

#[tokio::test]
#[ignore]
async fn pump_routes_async_result_turn_to_background_launcher() {
    let cwd = TempDir::new("pico-omp-pump");
    let cancel = CancellationToken::new();
    let tracker = TaskTracker::new();
    let pool = OmpPool::new(cwd.path.clone(), HostConfig::default(), cancel.clone(), &tracker);
    let (bg_tx, mut bg_rx) = mpsc::unbounded_channel();
    pool.set_background_launcher(std::sync::Arc::new(RecordingLauncher {
        tx: bg_tx,
        tracker: tracker.clone(),
    }));
    let cfg = SessionConfig {
        cwd: cwd.path.clone(),
        session_dir: cwd.path.clone(),
        profile: "default".into(),
        ..SessionConfig::default()
    };
    let handle = pool.get_or_spawn("pump", &cfg).await.expect("open session");

    {
        let (_turn, mut events) = handle.begin_turn().await;
        handle
            .client()
            .prompt(
                "Use the task tool to spawn exactly one subagent: agent type \"task\", one task whose \
         assignment is to run the bash command `sleep 15 && echo BGDONE` and report its output. \
         After the task tool returns its spawn acknowledgement, do NOT poll and do NOT wait — \
         immediately end your turn with a one-line message saying you launched it in the background.",
                &[],
            )
            .await
            .expect("prompt acked");
        loop {
            let event = tokio::time::timeout(Duration::from_secs(120), events.recv())
                .await
                .expect("timed out waiting for turn 1 agent_end")
                .expect("event stream closed before agent_end");
            match event {
                OmpEvent::AgentEnd => break,
                OmpEvent::Error(e) => panic!("omp reported an error: {e}"),
                _ => {}
            }
        }
    }

    let saw_agent_end = tokio::time::timeout(Duration::from_secs(120), bg_rx.recv())
        .await
        .expect("background launcher was never invoked for the async-result turn")
        .expect("background signal channel closed");
    assert!(saw_agent_end, "background turn did not reach agent_end");

    cancel.cancel();
}
