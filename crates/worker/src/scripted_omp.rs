use std::io::{BufRead, Write};

use serde_json::{Value, json};

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.iter().any(|a| a == "--version" || a == "-V") {
        println!("scripted-omp 0.0.0");
    } else if args.first().map(String::as_str) == Some("config") {
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

fn emit_bgtask(out: &mut impl Write, marker: &str) {
    let run1 = [
        json!({ "type": "tool_execution_start", "toolCallId": "bg-task", "toolName": "task", "args": { "agent": "task", "tasks": [{ "id": "bg-child", "description": format!("BGCHILD-{marker}") }] } }),
        json!({ "type": "tool_execution_end", "toolCallId": "bg-task", "toolName": "task", "result": { "async": { "state": "running" } }, "isError": false }),
        json!({ "type": "message_update", "assistantMessageEvent": { "type": "text_delta", "delta": format!("BGKICK-{marker}") } }),
        json!({ "type": "turn_end" }),
        json!({ "type": "agent_end" }),
    ];
    for frame in &run1 {
        emit(out, frame);
    }
    std::thread::sleep(std::time::Duration::from_secs(4));
    let run2 = [
        json!({ "type": "agent_start" }),
        json!({ "type": "message_update", "assistantMessageEvent": { "type": "text_delta", "delta": format!("BGDONE-{marker}") } }),
        json!({ "type": "turn_end" }),
        json!({ "type": "agent_end" }),
    ];
    for frame in &run2 {
        emit(out, frame);
    }
}

fn emit_white(out: &mut impl Write, marker: &str) {
    let frames = [
        json!({ "type": "message_update", "assistantMessageEvent": { "type": "text_start", "contentIndex": 0 } }),
        json!({ "type": "message_update", "assistantMessageEvent": { "type": "text_delta", "contentIndex": 0, "delta": format!("PRE-{marker}") } }),
        json!({ "type": "message_update", "assistantMessageEvent": { "type": "text_end", "contentIndex": 0, "content": format!("PRE-{marker}") } }),
        json!({ "type": "tool_execution_start", "toolCallId": "white-a", "toolName": "read", "args": { "path": format!("WACT-{marker}") } }),
        json!({ "type": "tool_execution_end", "toolCallId": "white-a", "toolName": "read", "result": {}, "isError": false }),
        json!({ "type": "message_update", "assistantMessageEvent": { "type": "text_start", "contentIndex": 0 } }),
        json!({ "type": "message_update", "assistantMessageEvent": { "type": "text_delta", "contentIndex": 0, "delta": format!("POST-{marker}") } }),
        json!({ "type": "message_update", "assistantMessageEvent": { "type": "text_end", "contentIndex": 0, "content": format!("POST-{marker}") } }),
        json!({ "type": "turn_end" }),
    ];
    for frame in &frames {
        emit(out, frame);
    }
}

fn run_rpc() {
    let stdin = std::io::stdin();
    let mut out = std::io::stdout();
    emit(&mut out, &json!({ "type": "ready" }));

    let mut lines = stdin.lock().lines();
    while let Some(Ok(line)) = lines.next() {
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
                    Some(("WHITE", marker)) => emit_white(&mut out, marker),
                    Some(("BGTASK", marker)) => {
                        emit_bgtask(&mut out, marker);
                        continue;
                    }
                    Some(("QUEUE", marker)) => {
                        run_queue(&mut out, &mut lines, marker);
                        continue;
                    }
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
            _ if !id.is_empty() => ack(&mut out, kind, id),
            _ => {}
        }
    }
}

fn run_queue<R: std::io::BufRead>(out: &mut impl Write, lines: &mut std::io::Lines<R>, marker: &str) {
    emit(
        out,
        &json!({ "type": "tool_execution_start", "toolCallId": format!("q-{marker}"), "toolName": "read", "args": { "path": format!("QWAIT-{marker}") } }),
    );
    emit(
        out,
        &json!({ "type": "tool_execution_end", "toolCallId": format!("q-{marker}"), "toolName": "read", "result": {}, "isError": false }),
    );

    let mut queued: Option<(String, String)> = None;
    for line in lines {
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
        if !id.is_empty() {
            ack(out, kind, id);
        }
        if kind == "follow_up" || kind == "steer" {
            let message = frame.get("message").and_then(Value::as_str).unwrap_or_default();
            queued = Some((kind.to_owned(), message.to_owned()));
            break;
        }
    }

    let cmd = queued.as_ref().map_or("none", |(kind, _)| kind.as_str());
    emit(
        out,
        &json!({ "type": "message_update", "assistantMessageEvent": { "type": "text_delta", "delta": format!("ALPHA-{marker}-{cmd}") } }),
    );
    emit(out, &json!({ "type": "turn_end" }));
    if let Some((_, msg)) = &queued {
        emit(
            out,
            &json!({ "type": "message_update", "assistantMessageEvent": { "type": "text_delta", "delta": reply_for(msg) } }),
        );
        emit(out, &json!({ "type": "turn_end" }));
    }
    emit(out, &json!({ "type": "agent_end" }));
}

fn ack(out: &mut impl Write, command: &str, id: &str) {
    emit(
        out,
        &json!({ "type": "response", "command": command, "success": true, "id": id }),
    );
}

fn emit(out: &mut impl Write, frame: &Value) {
    let _ = writeln!(out, "{frame}");
    let _ = out.flush();
}
