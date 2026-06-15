//! Scripted `omp` stand-in for the Discord chat e2e: speaks enough of the
//! `rpc-ui` protocol to drive deterministic `ask` flows without Copilot, plus
//! the `config get`/`-p` title one-shots. The driver's message is the script;
//! answers echo back as `DONE:<answers>`. see also: crates/core/tests/discord_chat.rs.

use std::{
    collections::VecDeque,
    io::{BufRead, Write},
};

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

struct Script {
    asks: VecDeque<Ask>,
    answers: Vec<String>,
    reply: String,
    had_asks: bool,
}

struct Ask {
    method: &'static str,
    title: String,
}

impl Script {
    fn parse(message: &str) -> Script {
        let message = message.trim();
        let (head, rest) = message.split_once(' ').unwrap_or((message, ""));
        let mut asks = VecDeque::new();
        let mut reply = message.to_owned();
        match head {
            "TELL" => reply = rest.to_owned(),
            "ASK_SELECT" => asks.push_back(Ask {
                method: "select",
                title: rest.to_owned(),
            }),
            "ASK_EDITOR" => asks.push_back(Ask {
                method: "editor",
                title: rest.to_owned(),
            }),
            "ASK_INPUT" => asks.push_back(Ask {
                method: "input",
                title: rest.to_owned(),
            }),
            "ASK_MULTI" => {
                for title in rest.split_whitespace() {
                    asks.push_back(Ask {
                        method: "select",
                        title: title.to_owned(),
                    });
                }
            }
            _ => {}
        }
        let had_asks = !asks.is_empty();
        Script {
            asks,
            answers: Vec::new(),
            reply,
            had_asks,
        }
    }
}

fn run_rpc() {
    let stdin = std::io::stdin();
    let mut out = std::io::stdout();
    emit(&mut out, &json!({ "type": "ready" }));

    let mut pending: Option<Script> = None;
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
                let mut script = Script::parse(message);
                pending = (!advance(&mut out, &mut script)).then_some(script);
            }
            "extension_ui_response" => {
                if let Some(mut script) = pending.take() {
                    let answer = frame.get("value").and_then(Value::as_str).unwrap_or_default();
                    script.answers.push(answer.to_owned());
                    pending = (!advance(&mut out, &mut script)).then_some(script);
                }
            }
            // Any other drive command just needs an ack, or dispatch() would time out.
            _ if !id.is_empty() => ack(&mut out, kind, id),
            _ => {}
        }
    }
}

fn advance(out: &mut impl Write, script: &mut Script) -> bool {
    if let Some(ask) = script.asks.pop_front() {
        let id = format!("ask-{}", script.answers.len());
        let frame = match ask.method {
            "select" => json!({
                "type": "extension_ui_request", "method": "select",
                "id": id, "title": ask.title, "options": ["A", "B"],
            }),
            "input" => json!({
                "type": "extension_ui_request", "method": "input",
                "id": id, "title": ask.title, "placeholder": "type here",
            }),
            _ => json!({
                "type": "extension_ui_request", "method": "editor",
                "id": id, "title": ask.title,
            }),
        };
        emit(out, &frame);
        return false;
    }
    let text = if script.had_asks {
        format!("DONE:{}", script.answers.join("|"))
    } else {
        script.reply.clone()
    };
    emit(
        out,
        &json!({
            "type": "message_update",
            "assistantMessageEvent": { "type": "text_delta", "delta": text },
        }),
    );
    emit(out, &json!({ "type": "agent_end" }));
    true
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
