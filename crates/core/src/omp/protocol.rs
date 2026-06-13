//! Wire types for the `omp --mode rpc` newline-delimited JSON protocol.
//!
//! Only the frames Stage 1 drives are modeled; every other frame OMP emits
//! decodes to [`Inbound::Unknown`] and is dropped by the reader rather than
//! treated as an error.

use serde::{Deserialize, Serialize};
use ulid::Ulid;

/// Correlation id for a command/response round-trip. Wraps a ULID so ids are
/// globally unique and time-sortable — and greppable across pico and omp logs.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub(crate) struct RequestId(String);

impl RequestId {
    pub(crate) fn new() -> RequestId {
        RequestId(Ulid::new().to_string())
    }
}

impl std::fmt::Display for RequestId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

/// A drive command pico writes to OMP's stdin. Each carries a host-generated
/// [`RequestId`] so the matching [`RpcResponse`] correlates back to the
/// awaiting caller.
#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "snake_case", rename_all_fields = "camelCase")]
pub(crate) enum Command<'a> {
    Prompt {
        id: &'a RequestId,
        message: &'a str,
    },
    Steer {
        id: &'a RequestId,
        message: &'a str,
    },
    FollowUp {
        id: &'a RequestId,
        message: &'a str,
    },
    Abort {
        id: &'a RequestId,
    },
    NewSession {
        id: &'a RequestId,
    },
    SetModel {
        id: &'a RequestId,
        provider: &'a str,
        model_id: &'a str,
    },
}

impl Command<'_> {
    /// The wire `type` tag, for logging the RPC conversation.
    pub(crate) fn kind(&self) -> &'static str {
        match self {
            Command::Prompt { .. } => "prompt",
            Command::Steer { .. } => "steer",
            Command::FollowUp { .. } => "follow_up",
            Command::Abort { .. } => "abort",
            Command::NewSession { .. } => "new_session",
            Command::SetModel { .. } => "set_model",
        }
    }
}

/// OMP's reply to a command (`{type:"response", command, success, error?}`).
/// `prompt` is acked with `success:true` immediately; a later failure may arrive
/// as a second response with the same `id` (see [`crate::omp::client`]).
#[derive(Debug, Deserialize)]
pub(crate) struct RpcResponse {
    pub id: Option<RequestId>,
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

/// The `assistantMessageEvent` payload of a `message_update` frame. pico
/// streams the answer from `text_delta` and surfaces reasoning from the
/// terminal `thinking_end` (which carries the whole thinking block); every
/// other delta kind (`start`, `done`, tool-call + intermediate thinking
/// deltas, …) collapses to [`AssistantMessageEvent::Other`].
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum AssistantMessageEvent {
    TextDelta {
        delta: String,
    },
    ThinkingEnd {
        #[serde(default)]
        content: String,
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
        let id = RequestId("req_0".to_owned());
        assert_eq!(
            serde_json::to_value(Command::Prompt { id: &id, message: "hi" }).unwrap(),
            serde_json::json!({"type": "prompt", "id": "req_0", "message": "hi"}),
        );
        assert_eq!(
            serde_json::to_value(Command::FollowUp {
                id: &id,
                message: "more"
            })
            .unwrap(),
            serde_json::json!({"type": "follow_up", "id": "req_0", "message": "more"}),
        );
        // snake_case tag, camelCase modelId.
        assert_eq!(
            serde_json::to_value(Command::SetModel {
                id: &id,
                provider: "github-copilot",
                model_id: "gpt-4o-mini",
            })
            .unwrap(),
            serde_json::json!({
                "type": "set_model",
                "id": "req_0",
                "provider": "github-copilot",
                "modelId": "gpt-4o-mini",
            }),
        );
        assert_eq!(
            serde_json::to_value(Command::NewSession { id: &id }).unwrap(),
            serde_json::json!({"type": "new_session", "id": "req_0"}),
        );
    }

    #[test]
    fn request_id_is_transparent_on_the_wire() {
        let id = RequestId("01ABC".to_owned());
        assert_eq!(serde_json::to_value(&id).unwrap(), serde_json::json!("01ABC"));
        assert_eq!(serde_json::from_value::<RequestId>(serde_json::json!("01ABC")).unwrap(), id);
    }

    #[test]
    fn routes_ready_and_response_frames() {
        assert!(matches!(parse(r#"{"type":"ready"}"#), Inbound::Ready));

        match parse(r#"{"id":"p1","type":"response","command":"prompt","success":true}"#) {
            Inbound::Response(r) => {
                assert_eq!(r.id, Some(RequestId("p1".to_owned())));
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
    fn decodes_thinking_end_and_collapses_other_deltas() {
        match parse(
            r#"{"type":"message_update","assistantMessageEvent":{"type":"thinking_end","contentIndex":0,"content":"the plan"}}"#,
        ) {
            Inbound::MessageUpdate {
                assistant_message_event: AssistantMessageEvent::ThinkingEnd { content },
            } => {
                assert_eq!(content, "the plan");
            }
            other => panic!("expected thinking end, got {other:?}"),
        }
        for line in [
            r#"{"type":"message_update","assistantMessageEvent":{"type":"thinking_delta","contentIndex":0,"delta":"hmm"}}"#,
            r#"{"type":"message_update","assistantMessageEvent":{"type":"toolcall_start","contentIndex":0}}"#,
        ] {
            assert!(matches!(
                parse(line),
                Inbound::MessageUpdate {
                    assistant_message_event: AssistantMessageEvent::Other
                },
            ));
        }
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
