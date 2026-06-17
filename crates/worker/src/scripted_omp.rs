//! Scripted `omp` stand-in for the Discord chat e2e: speaks enough of the
//! `rpc` protocol to drive a deterministic thread reply without Copilot, plus
//! the `config get`/`-p` title one-shots. The driver's `TELL <text>` message is
//! echoed back as the assistant reply. see also: crates/core/tests/discord_chat.rs.

use std::io::{BufRead, Write};

use serde_json::{Value, json};

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.iter().any(|a| a == "--version" || a == "-V") {
        println!("scripted-omp 0.0.0");
    } else if args.first().map(String::as_str) == Some("config") {
        // roles object so the title path resolves a smol model.
        println!(r#"{{"value":{{"smol":"scripted/smol","default":"scripted/default"}}}}"#);
    } else if args.iter().any(|a| a == "-p") {
        println!("Scripted thread title");
    } else {
        run_rpc();
    }
}

fn reply_for(message: &str) -> String {
    let message = message.trim();
    match message.split_once(' ') {
        Some(("TELL", rest)) => rest.to_owned(),
        _ => message.to_owned(),
    }
}

/// Emits `read → task → read` for the timeline e2e: the host must seal the activity
/// feed after the `task` so the second `read` opens a new message below the task.
fn emit_seq(out: &mut impl Write, marker: &str) {
    let frames = [
        json!({ "type": "tool_execution_start", "toolCallId": "seq-a", "toolName": "read", "args": { "path": format!("ACT-A-{marker}") } }),
        json!({ "type": "tool_execution_end", "toolCallId": "seq-a", "toolName": "read", "result": {}, "isError": false }),
        json!({ "type": "tool_execution_start", "toolCallId": "seq-task", "toolName": "task", "args": { "agent": "task", "tasks": [{ "id": "seq-child", "description": format!("SEQCHILD-{marker}") }] } }),
        json!({ "type": "tool_execution_end", "toolCallId": "seq-task", "toolName": "task", "result": {}, "isError": false }),
        json!({ "type": "tool_execution_start", "toolCallId": "seq-b", "toolName": "read", "args": { "path": format!("ACT-B-{marker}") } }),
        json!({ "type": "tool_execution_end", "toolCallId": "seq-b", "toolName": "read", "result": {}, "isError": false }),
    ];
    for frame in &frames {
        emit(out, frame);
    }
}

fn run_rpc() {
    let stdin = std::io::stdin();
    let mut out = std::io::stdout();
    emit(&mut out, &json!({ "type": "ready" }));

    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let Ok(frame) = serde_json::from_str::<Value>(trimmed) else {
            continue;
        };
        let kind = frame.get("type").and_then(Value::as_str).unwrap_or_default();
        let id = frame.get("id").and_then(Value::as_str).unwrap_or_default();
        match kind {
            "prompt" => {
                ack(&mut out, "prompt", id);
                emit(&mut out, &json!({ "type": "agent_start" }));
                let message = frame.get("message").and_then(Value::as_str).unwrap_or_default();
                match message.trim().split_once(' ') {
                    Some(("SEQ", marker)) => emit_seq(&mut out, marker),
                    _ => emit(
                        &mut out,
                        &json!({
                            "type": "message_update",
                            "assistantMessageEvent": { "type": "text_delta", "delta": reply_for(message) },
                        }),
                    ),
                }
                emit(&mut out, &json!({ "type": "agent_end" }));
            }
            // Any other drive command just needs an ack, or dispatch() would time out.
            _ if !id.is_empty() => ack(&mut out, kind, id),
            _ => {}
        }
    }
}

fn ack(out: &mut impl Write, command: &str, id: &str) {
    emit(
        out,
        &json!({ "type": "response", "command": command, "success": true, "id": id }),
    );
}

fn emit(out: &mut impl Write, frame: &Value) {
    // Newline-delimited JSON; flush so the host's blocked read wakes immediately.
    let _ = writeln!(out, "{frame}");
    let _ = out.flush();
}
