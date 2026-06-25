use std::{
    collections::HashMap,
    io::{BufRead, Stdout, Write},
    sync::{Arc, Mutex},
    thread,
    time::Duration,
};

use serde_json::{Value, json};

type Out = Arc<Mutex<Stdout>>;

fn main() {
    let out: Out = Arc::new(Mutex::new(std::io::stdout()));
    if let Ok(path) = std::env::var("SCRIPTED_OMP_PIDFILE") {
        let _ = std::fs::write(path, std::process::id().to_string());
    }
    emit(&out, &json!({ "type": "ready" }));

    let stdin = std::io::stdin();
    let mut queue_pending: HashMap<String, String> = HashMap::new();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let Ok(frame) = serde_json::from_str::<Value>(trimmed) else {
            continue;
        };
        dispatch(&out, &frame, &mut queue_pending);
    }
}

fn dispatch(out: &Out, frame: &Value, queue_pending: &mut HashMap<String, String>) {
    let kind = frame.get("type").and_then(Value::as_str).unwrap_or_default();
    let id = frame.get("id").and_then(Value::as_str).unwrap_or_default();
    let session_id = frame.get("sessionId").and_then(Value::as_str).unwrap_or_default();
    match kind {
        "completion" => emit(
            out,
            &json!({
                "type": "response",
                "id": id,
                "command": "completion",
                "success": true,
                "result": "Scripted thread title",
            }),
        ),
        "prompt" => {
            ack(out, "prompt", id, session_id);
            handle_prompt(out, session_id, frame, queue_pending);
        }
        "follow_up" | "steer" => {
            ack(out, kind, id, session_id);
            if let Some(marker) = queue_pending.remove(session_id) {
                let message = frame.get("message").and_then(Value::as_str).unwrap_or_default();
                emit_queue_tail(out, session_id, &marker, kind, unwrap_message(message));
            }
        }
        _ if !id.is_empty() => ack(out, kind, id, session_id),
        _ => {}
    }
}

fn handle_prompt(out: &Out, session_id: &str, frame: &Value, queue_pending: &mut HashMap<String, String>) {
    emit(out, &event(session_id, "agent_start"));
    let message = frame.get("message").and_then(Value::as_str).unwrap_or_default();
    let message = unwrap_message(message);
    match message.trim().split_once(' ') {
        Some(("SEQ", marker)) => {
            emit_seq(out, session_id, marker);
            emit(out, &event(session_id, "agent_end"));
        }
        Some(("WHITE", marker)) => {
            emit_white(out, session_id, marker);
            emit(out, &event(session_id, "agent_end"));
        }
        Some(("BGTASK", marker)) => emit_bgtask(out, session_id, marker),
        Some(("QUEUE", marker)) => {
            emit_queue_head(out, session_id, marker);
            queue_pending.insert(session_id.to_owned(), marker.to_owned());
        }
        _ => {
            emit(out, &text_delta(session_id, &reply_for(message)));
            emit(out, &event(session_id, "agent_end"));
        }
    }
}

fn reply_for(message: &str) -> String {
    let message = message.trim();
    match message.split_once(' ') {
        Some(("TELL", rest)) => rest.to_owned(),
        _ => message.to_owned(),
    }
}

fn unwrap_message(message: &str) -> &str {
    let trimmed = message.trim_start();
    if let Some((first_line, rest)) = trimmed.split_once('\n')
        && first_line.starts_with("<discord-message")
        && first_line.trim_end().ends_with("/>")
    {
        return rest;
    }
    message
}

fn emit_seq(out: &Out, session_id: &str, marker: &str) {
    emit(
        out,
        &tool_start(session_id, "seq-a", "read", json!({ "path": format!("ACT-A-{marker}") })),
    );
    emit(out, &tool_end(session_id, "seq-a", "read"));
    emit(
        out,
        &tool_start(
            session_id,
            "seq-task",
            "task",
            json!({ "agent": "task", "tasks": [{ "id": "seq-child", "description": format!("SEQCHILD-{marker}") }] }),
        ),
    );
    emit(out, &tool_end(session_id, "seq-task", "task"));
    emit(
        out,
        &tool_start(session_id, "seq-b", "read", json!({ "path": format!("ACT-B-{marker}") })),
    );
    emit(out, &tool_end(session_id, "seq-b", "read"));
}

fn emit_bgtask(out: &Out, session_id: &str, marker: &str) {
    emit(
        out,
        &tool_start(
            session_id,
            "bg-task",
            "task",
            json!({ "agent": "task", "tasks": [{ "id": "bg-child", "description": format!("BGCHILD-{marker}") }] }),
        ),
    );
    emit(
        out,
        &json!({
            "type": "tool_execution_end",
            "sessionId": session_id,
            "toolCallId": "bg-task",
            "toolName": "task",
            "result": { "async": { "state": "running" } },
            "isError": false,
        }),
    );
    emit(out, &text_delta(session_id, &format!("BGKICK-{marker}")));
    emit(out, &event(session_id, "turn_end"));
    emit(out, &event(session_id, "agent_end"));

    let out = Arc::clone(out);
    let session_id = session_id.to_owned();
    let marker = marker.to_owned();
    thread::spawn(move || {
        thread::sleep(Duration::from_secs(4));
        emit(&out, &event(&session_id, "agent_start"));
        emit(&out, &text_delta(&session_id, &format!("BGDONE-{marker}")));
        emit(&out, &event(&session_id, "turn_end"));
        emit(&out, &event(&session_id, "agent_end"));
    });
}

fn emit_white(out: &Out, session_id: &str, marker: &str) {
    emit(out, &white_text(session_id, "text_start", None));
    emit(
        out,
        &white_text(session_id, "text_delta", Some(("delta", format!("PRE-{marker}")))),
    );
    emit(
        out,
        &white_text(session_id, "text_end", Some(("content", format!("PRE-{marker}")))),
    );
    emit(
        out,
        &tool_start(session_id, "white-a", "read", json!({ "path": format!("WACT-{marker}") })),
    );
    emit(out, &tool_end(session_id, "white-a", "read"));
    emit(out, &white_text(session_id, "text_start", None));
    emit(
        out,
        &white_text(session_id, "text_delta", Some(("delta", format!("POST-{marker}")))),
    );
    emit(
        out,
        &white_text(session_id, "text_end", Some(("content", format!("POST-{marker}")))),
    );
    emit(out, &event(session_id, "turn_end"));
}

fn emit_queue_head(out: &Out, session_id: &str, marker: &str) {
    emit(
        out,
        &tool_start(
            session_id,
            &format!("q-{marker}"),
            "read",
            json!({ "path": format!("QWAIT-{marker}") }),
        ),
    );
    emit(out, &tool_end(session_id, &format!("q-{marker}"), "read"));
}

fn emit_queue_tail(out: &Out, session_id: &str, marker: &str, cmd: &str, message: &str) {
    emit(out, &text_delta(session_id, &format!("ALPHA-{marker}-{cmd}")));
    emit(out, &event(session_id, "turn_end"));
    emit(out, &text_delta(session_id, &reply_for(message)));
    emit(out, &event(session_id, "turn_end"));
    emit(out, &event(session_id, "agent_end"));
}

fn event(session_id: &str, ty: &str) -> Value {
    json!({ "type": ty, "sessionId": session_id })
}

fn text_delta(session_id: &str, delta: &str) -> Value {
    json!({
        "type": "message_update",
        "sessionId": session_id,
        "assistantMessageEvent": { "type": "text_delta", "delta": delta },
    })
}

fn white_text(session_id: &str, ty: &str, field: Option<(&str, String)>) -> Value {
    let mut ev = json!({ "type": ty, "contentIndex": 0 });
    if let Some((key, value)) = field {
        ev[key] = Value::String(value);
    }
    json!({ "type": "message_update", "sessionId": session_id, "assistantMessageEvent": ev })
}

fn tool_start(session_id: &str, tool_call_id: &str, tool_name: &str, args: Value) -> Value {
    json!({
        "type": "tool_execution_start",
        "sessionId": session_id,
        "toolCallId": tool_call_id,
        "toolName": tool_name,
        "args": args,
    })
}

fn tool_end(session_id: &str, tool_call_id: &str, tool_name: &str) -> Value {
    json!({
        "type": "tool_execution_end",
        "sessionId": session_id,
        "toolCallId": tool_call_id,
        "toolName": tool_name,
        "result": {},
        "isError": false,
    })
}

fn ack(out: &Out, command: &str, id: &str, session_id: &str) {
    emit(
        out,
        &json!({ "type": "response", "id": id, "sessionId": session_id, "command": command, "success": true }),
    );
}

fn emit(out: &Out, frame: &Value) {
    let mut guard = out.lock().unwrap_or_else(|e| e.into_inner());
    let _ = writeln!(guard, "{frame}");
    let _ = guard.flush();
}
