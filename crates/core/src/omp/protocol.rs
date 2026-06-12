//! Wire types for the `omp --mode rpc` newline-delimited JSON protocol.
//!
//! Only the frames Stage 1 drives are modeled; every other frame OMP emits
//! decodes to [`Inbound::Unknown`] and is dropped by the reader rather than
//! treated as an error.

use serde::{Deserialize, Serialize};

/// A drive command pico writes to OMP's stdin. Each carries a host-generated
/// `id` so the matching [`RpcResponse`] correlates back to the awaiting caller.
#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "snake_case", rename_all_fields = "camelCase")]
pub(crate) enum Command<'a> {
    Prompt {
        id: &'a str,
        message: &'a str,
    },
    Steer {
        id: &'a str,
        message: &'a str,
    },
    Abort {
        id: &'a str,
    },
    NewSession {
        id: &'a str,
    },
    SetModel {
        id: &'a str,
        provider: &'a str,
        model_id: &'a str,
    },
}

/// OMP's reply to a command (`{type:"response", command, success, error?}`).
/// `prompt` is acked with `success:true` immediately; a later failure may arrive
/// as a second response with the same `id` (see [`crate::omp::client`]).
#[derive(Debug, Deserialize)]
pub(crate) struct RpcResponse {
    pub id: Option<String>,
    pub command: String,
    pub success: bool,
    #[serde(default)]
    pub error: Option<String>,
}

/// A streaming event from an OMP session, delivered on the client's event
/// channel. Control frames (`ready`, command responses) and unmodeled session
/// frames never appear here — they are handled or discarded by the reader.
#[derive(Debug, Clone)]
pub enum OmpEvent {
    AgentStart,
    Message(AssistantMessageEvent),
    ToolStart(ToolCallStart),
    ToolEnd(ToolCallEnd),
    /// The agent finished the turn. Terminal for the current prompt.
    AgentEnd,
    /// An asynchronous failure surfaced after the prompt was already acked
    /// (e.g. the model rejected the request). Terminal for the current turn.
    Error(String),
}

/// The `assistantMessageEvent` payload of a `message_update` frame. Only the
/// text/thinking deltas pico streams are modeled; all other delta kinds
/// (`start`, `done`, tool-call deltas, …) collapse to
/// [`AssistantMessageEvent::Other`].
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum AssistantMessageEvent {
    TextDelta {
        delta: String,
    },
    ThinkingDelta {
        delta: String,
    },
    #[serde(other)]
    Other,
}

/// Payload of a `tool_execution_start` frame.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolCallStart {
    pub tool_call_id: String,
    pub tool_name: String,
    pub args: serde_json::Value,
    #[serde(default)]
    pub intent: Option<String>,
}

/// Payload of a `tool_execution_end` frame.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolCallEnd {
    pub tool_call_id: String,
    pub tool_name: String,
    pub result: serde_json::Value,
    #[serde(default)]
    pub is_error: bool,
}

/// Every frame the client reads off OMP's stdout; unmodeled frames decode to
/// [`Inbound::Unknown`].
#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", rename_all_fields = "camelCase")]
pub(crate) enum Inbound {
    Ready,
    Response(RpcResponse),
    AgentStart,
    AgentEnd,
    MessageUpdate {
        assistant_message_event: AssistantMessageEvent,
    },
    ToolExecutionStart(ToolCallStart),
    ToolExecutionEnd(ToolCallEnd),
    #[serde(other)]
    Unknown,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(line: &str) -> Inbound {
        serde_json::from_str(line).expect("decode inbound frame")
    }

    #[test]
    fn serializes_commands_with_camelcase_fields() {
        assert_eq!(
            serde_json::to_value(Command::Prompt {
                id: "req_0",
                message: "hi"
            })
            .unwrap(),
            serde_json::json!({"type": "prompt", "id": "req_0", "message": "hi"}),
        );
        // snake_case tag, camelCase modelId.
        assert_eq!(
            serde_json::to_value(Command::SetModel {
                id: "req_1",
                provider: "github-copilot",
                model_id: "gpt-4o-mini",
            })
            .unwrap(),
            serde_json::json!({
                "type": "set_model",
                "id": "req_1",
                "provider": "github-copilot",
                "modelId": "gpt-4o-mini",
            }),
        );
        assert_eq!(
            serde_json::to_value(Command::NewSession { id: "req_2" }).unwrap(),
            serde_json::json!({"type": "new_session", "id": "req_2"}),
        );
    }

    #[test]
    fn routes_ready_and_response_frames() {
        assert!(matches!(parse(r#"{"type":"ready"}"#), Inbound::Ready));

        match parse(r#"{"id":"p1","type":"response","command":"prompt","success":true}"#) {
            Inbound::Response(r) => {
                assert_eq!(r.id.as_deref(), Some("p1"));
                assert_eq!(r.command, "prompt");
                assert!(r.success);
                assert!(r.error.is_none());
            }
            other => panic!("expected response, got {other:?}"),
        }

        match parse(
            r#"{"id":"b","type":"response","command":"set_model","success":false,"error":"Model not found: nope/nope"}"#,
        ) {
            Inbound::Response(r) => {
                assert!(!r.success);
                assert_eq!(r.error.as_deref(), Some("Model not found: nope/nope"));
            }
            other => panic!("expected response, got {other:?}"),
        }
    }

    #[test]
    fn decodes_text_delta_inside_message_update() {
        // Captured from a live gpt-4o-mini turn; the real frame also carries a
        // large `partial` object that must be ignored.
        let line = r#"{"type":"message_update","assistantMessageEvent":{"type":"text_delta","contentIndex":0,"delta":"pong","partial":{"role":"assistant","content":[]}},"message":{"role":"assistant","content":[]}}"#;
        match parse(line) {
            Inbound::MessageUpdate {
                assistant_message_event: AssistantMessageEvent::TextDelta { delta },
            } => {
                assert_eq!(delta, "pong");
            }
            other => panic!("expected text delta, got {other:?}"),
        }
    }

    #[test]
    fn decodes_thinking_delta_and_collapses_other_deltas() {
        match parse(
            r#"{"type":"message_update","assistantMessageEvent":{"type":"thinking_delta","contentIndex":0,"delta":"hmm"}}"#,
        ) {
            Inbound::MessageUpdate {
                assistant_message_event: AssistantMessageEvent::ThinkingDelta { delta },
            } => {
                assert_eq!(delta, "hmm");
            }
            other => panic!("expected thinking delta, got {other:?}"),
        }
        // toolcall/text_end/start deltas are not individually modeled.
        assert!(matches!(
            parse(r#"{"type":"message_update","assistantMessageEvent":{"type":"toolcall_start","contentIndex":0}}"#),
            Inbound::MessageUpdate {
                assistant_message_event: AssistantMessageEvent::Other
            },
        ));
    }

    #[test]
    fn decodes_tool_execution_frames() {
        match parse(
            r#"{"type":"tool_execution_start","toolCallId":"call_1","toolName":"bash","args":{"command":"echo hi"},"intent":"Running echo"}"#,
        ) {
            Inbound::ToolExecutionStart(t) => {
                assert_eq!(t.tool_call_id, "call_1");
                assert_eq!(t.tool_name, "bash");
                assert_eq!(t.args["command"], "echo hi");
                assert_eq!(t.intent.as_deref(), Some("Running echo"));
            }
            other => panic!("expected tool start, got {other:?}"),
        }

        match parse(
            r#"{"type":"tool_execution_end","toolCallId":"call_1","toolName":"bash","result":{"content":[]},"isError":false}"#,
        ) {
            Inbound::ToolExecutionEnd(t) => {
                assert_eq!(t.tool_call_id, "call_1");
                assert!(!t.is_error);
            }
            other => panic!("expected tool end, got {other:?}"),
        }
    }

    #[test]
    fn agent_lifecycle_and_unknown_frames() {
        assert!(matches!(parse(r#"{"type":"agent_start"}"#), Inbound::AgentStart));
        assert!(matches!(parse(r#"{"type":"agent_end","messages":[]}"#), Inbound::AgentEnd));
        // Frames Stage 1 does not consume must not error out the stream.
        assert!(matches!(parse(r#"{"type":"turn_start"}"#), Inbound::Unknown));
        assert!(matches!(
            parse(r#"{"type":"extension_ui_request","id":"x","method":"setWidget"}"#),
            Inbound::Unknown,
        ));
    }
}
