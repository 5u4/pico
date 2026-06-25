use std::path::Path;

use serde::{Deserialize, Serialize};
use ulid::Ulid;

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

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Identity<'a> {
    pub platform: &'a str,
    pub guild: &'a str,
    pub channel: &'a str,
    pub thread: &'a str,
    pub user: &'a str,
}

#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "snake_case", rename_all_fields = "camelCase")]
pub(crate) enum Command<'a> {
    OpenSession {
        id: &'a RequestId,
        session_id: &'a str,
        cwd: &'a Path,
        session_dir: &'a Path,
        continue_from_file: Option<&'a Path>,
        append_system_prompt: Option<&'a Path>,
        model: Option<&'a str>,
        identity: Identity<'a>,
    },
    CloseSession {
        id: &'a RequestId,
        session_id: &'a str,
    },
    Prompt {
        id: &'a RequestId,
        session_id: &'a str,
        message: &'a str,
    },
    Steer {
        id: &'a RequestId,
        session_id: &'a str,
        message: &'a str,
    },
    FollowUp {
        id: &'a RequestId,
        session_id: &'a str,
        message: &'a str,
    },
    Abort {
        id: &'a RequestId,
        session_id: &'a str,
    },
    NewSession {
        id: &'a RequestId,
        session_id: &'a str,
    },
    SetModel {
        id: &'a RequestId,
        session_id: &'a str,
        provider: &'a str,
        model_id: &'a str,
    },
    SetSessionName {
        id: &'a RequestId,
        session_id: &'a str,
        name: &'a str,
    },
    Completion {
        id: &'a RequestId,
        system: &'a str,
        prompt: &'a str,
    },
}

impl Command<'_> {
    pub(crate) fn kind(&self) -> &'static str {
        match self {
            Command::OpenSession { .. } => "open_session",
            Command::CloseSession { .. } => "close_session",
            Command::Prompt { .. } => "prompt",
            Command::Steer { .. } => "steer",
            Command::FollowUp { .. } => "follow_up",
            Command::Abort { .. } => "abort",
            Command::NewSession { .. } => "new_session",
            Command::SetModel { .. } => "set_model",
            Command::SetSessionName { .. } => "set_session_name",
            Command::Completion { .. } => "completion",
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RpcResponse {
    pub id: Option<RequestId>,
    #[serde(default)]
    pub session_id: String,
    pub command: String,
    pub success: bool,
    #[serde(default)]
    pub error: Option<String>,
    #[serde(default)]
    pub result: Option<String>,
}

#[derive(Debug, Clone)]
pub enum OmpEvent {
    AgentStart,
    Message(AssistantMessageEvent),
    ToolStart(ToolCall),
    ToolUpdate(ToolCallUpdate),
    ToolEnd(ToolCallEnd),
    UiRequest(UiRequest),
    AgentEnd,
    TurnEnd,
    Error(String),
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum AssistantMessageEvent {
    TextDelta {
        delta: String,
    },
    TextEnd {
        #[serde(default)]
        content: String,
    },
    ThinkingEnd {
        #[serde(default)]
        content: String,
    },
    #[serde(other)]
    Other,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolCall {
    pub tool_call_id: String,
    pub tool_name: String,
    pub args: serde_json::Value,
    #[serde(default)]
    pub intent: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolCallEnd {
    pub tool_call_id: String,
    pub tool_name: String,
    pub result: serde_json::Value,
    #[serde(default)]
    pub is_error: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolCallUpdate {
    pub tool_call_id: String,
    pub tool_name: String,
    pub partial_result: serde_json::Value,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(from = "RawUiRequest")]
pub enum UiRequest {
    Select {
        id: String,
        title: String,
        options: Vec<String>,
        timeout: Option<u64>,
    },
    Confirm {
        id: String,
        title: String,
        message: String,
        timeout: Option<u64>,
    },
    Input {
        id: String,
        title: String,
        placeholder: Option<String>,
        timeout: Option<u64>,
    },
    Editor {
        id: String,
        title: String,
        prefill: Option<String>,
    },
    Notify {
        message: String,
        notify_type: Option<String>,
    },
    Cancel {
        target_id: String,
    },
    Ignore,
    Unknown {
        id: Option<String>,
        method: String,
    },
}

#[derive(Deserialize)]
struct RawUiRequest {
    method: String,
    #[serde(default)]
    id: Option<String>,
    #[serde(default)]
    title: String,
    #[serde(default)]
    options: Vec<String>,
    #[serde(default)]
    message: String,
    #[serde(default)]
    placeholder: Option<String>,
    #[serde(default)]
    prefill: Option<String>,
    #[serde(default)]
    timeout: Option<u64>,
    #[serde(rename = "notifyType", default)]
    notify_type: Option<String>,
    #[serde(rename = "targetId", default)]
    target_id: Option<String>,
}

impl From<RawUiRequest> for UiRequest {
    fn from(raw: RawUiRequest) -> Self {
        let RawUiRequest {
            method,
            id,
            title,
            options,
            message,
            placeholder,
            prefill,
            timeout,
            notify_type,
            target_id,
        } = raw;
        match (method.as_str(), id) {
            ("select", Some(id)) => Self::Select {
                id,
                title,
                options,
                timeout,
            },
            ("confirm", Some(id)) => Self::Confirm {
                id,
                title,
                message,
                timeout,
            },
            ("input", Some(id)) => Self::Input {
                id,
                title,
                placeholder,
                timeout,
            },
            ("editor", Some(id)) => Self::Editor { id, title, prefill },
            ("notify", _) => Self::Notify { message, notify_type },
            ("cancel", _) => Self::Cancel {
                target_id: target_id.unwrap_or_default(),
            },
            ("setStatus" | "setWidget" | "setTitle" | "set_editor_text" | "open_url", _) => Self::Ignore,
            (_, id) => Self::Unknown { id, method },
        }
    }
}

#[derive(Debug, Serialize)]
pub struct UiResponse<'a> {
    #[serde(rename = "type")]
    kind: &'static str,
    #[serde(rename = "sessionId")]
    session_id: &'a str,
    id: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    value: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    confirmed: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    cancelled: Option<bool>,
    #[serde(rename = "timedOut", skip_serializing_if = "Option::is_none")]
    timed_out: Option<bool>,
}

impl<'a> UiResponse<'a> {
    const KIND: &'static str = "extension_ui_response";

    pub fn value(session_id: &'a str, id: &'a str, value: &'a str) -> Self {
        Self {
            kind: Self::KIND,
            session_id,
            id,
            value: Some(value),
            confirmed: None,
            cancelled: None,
            timed_out: None,
        }
    }

    pub fn confirmed(session_id: &'a str, id: &'a str, confirmed: bool) -> Self {
        Self {
            kind: Self::KIND,
            session_id,
            id,
            value: None,
            confirmed: Some(confirmed),
            cancelled: None,
            timed_out: None,
        }
    }

    pub fn cancelled(session_id: &'a str, id: &'a str, timed_out: bool) -> Self {
        Self {
            kind: Self::KIND,
            session_id,
            id,
            value: None,
            confirmed: None,
            cancelled: Some(true),
            timed_out: timed_out.then_some(true),
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", rename_all_fields = "camelCase")]
pub(crate) enum Inbound {
    Ready,
    Response(RpcResponse),
    AgentStart {
        session_id: String,
    },
    AgentEnd {
        session_id: String,
    },
    TurnEnd {
        session_id: String,
    },
    MessageUpdate {
        session_id: String,
        assistant_message_event: AssistantMessageEvent,
    },
    ToolExecutionStart {
        session_id: String,
        #[serde(flatten)]
        call: ToolCall,
    },
    ToolExecutionUpdate {
        session_id: String,
        #[serde(flatten)]
        update: ToolCallUpdate,
    },
    ToolExecutionEnd {
        session_id: String,
        #[serde(flatten)]
        end: ToolCallEnd,
    },
    ExtensionUiRequest {
        session_id: String,
        #[serde(flatten)]
        request: UiRequest,
    },
    Error {
        session_id: String,
        message: String,
    },
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
            serde_json::to_value(Command::Prompt {
                id: &id,
                session_id: "t1",
                message: "hi",
            })
            .unwrap(),
            serde_json::json!({"type": "prompt", "id": "req_0", "sessionId": "t1", "message": "hi"}),
        );
        assert_eq!(
            serde_json::to_value(Command::FollowUp {
                id: &id,
                session_id: "t1",
                message: "more",
            })
            .unwrap(),
            serde_json::json!({"type": "follow_up", "id": "req_0", "sessionId": "t1", "message": "more"}),
        );
        assert_eq!(
            serde_json::to_value(Command::SetModel {
                id: &id,
                session_id: "t1",
                provider: "github-copilot",
                model_id: "gpt-4o-mini",
            })
            .unwrap(),
            serde_json::json!({
                "type": "set_model",
                "id": "req_0",
                "sessionId": "t1",
                "provider": "github-copilot",
                "modelId": "gpt-4o-mini",
            }),
        );
        assert_eq!(
            serde_json::to_value(Command::NewSession {
                id: &id,
                session_id: "t1"
            })
            .unwrap(),
            serde_json::json!({"type": "new_session", "id": "req_0", "sessionId": "t1"}),
        );
        assert_eq!(
            serde_json::to_value(Command::Abort {
                id: &id,
                session_id: "t1"
            })
            .unwrap(),
            serde_json::json!({"type": "abort", "id": "req_0", "sessionId": "t1"}),
        );
        assert_eq!(
            serde_json::to_value(Command::Completion {
                id: &id,
                system: "You output one short title.",
                prompt: "Write the thread title now.",
            })
            .unwrap(),
            serde_json::json!({
                "type": "completion",
                "id": "req_0",
                "system": "You output one short title.",
                "prompt": "Write the thread title now.",
            }),
        );
    }

    #[test]
    fn serializes_open_and_close_session() {
        let id = RequestId("req_1".to_owned());
        let cwd = Path::new("/work/tree");
        let dir = Path::new("/sessions/t1");
        let cont = Path::new("/sessions/t1/abc.jsonl");
        assert_eq!(
            serde_json::to_value(Command::OpenSession {
                id: &id,
                session_id: "t1",
                cwd,
                session_dir: dir,
                continue_from_file: Some(cont),
                append_system_prompt: None,
                model: Some("github-copilot/claude"),
                identity: Identity {
                    platform: "discord",
                    guild: "1",
                    channel: "2",
                    thread: "3",
                    user: "4",
                },
            })
            .unwrap(),
            serde_json::json!({
                "type": "open_session",
                "id": "req_1",
                "sessionId": "t1",
                "cwd": "/work/tree",
                "sessionDir": "/sessions/t1",
                "continueFromFile": "/sessions/t1/abc.jsonl",
                "appendSystemPrompt": null,
                "model": "github-copilot/claude",
                "identity": {
                    "platform": "discord",
                    "guild": "1",
                    "channel": "2",
                    "thread": "3",
                    "user": "4",
                },
            }),
        );
        assert_eq!(
            serde_json::to_value(Command::CloseSession {
                id: &id,
                session_id: "t1"
            })
            .unwrap(),
            serde_json::json!({"type": "close_session", "id": "req_1", "sessionId": "t1"}),
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

        match parse(r#"{"id":"p1","type":"response","sessionId":"s1","command":"prompt","success":true}"#) {
            Inbound::Response(r) => {
                assert_eq!(r.id, Some(RequestId("p1".to_owned())));
                assert_eq!(r.session_id, "s1");
                assert_eq!(r.command, "prompt");
                assert!(r.success);
                assert!(r.error.is_none());
            }
            other => panic!("expected response, got {other:?}"),
        }

        match parse(
            r#"{"id":"b","type":"response","sessionId":"s1","command":"set_model","success":false,"error":"Model not found: nope/nope"}"#,
        ) {
            Inbound::Response(r) => {
                assert!(!r.success);
                assert_eq!(r.error.as_deref(), Some("Model not found: nope/nope"));
            }
            other => panic!("expected response, got {other:?}"),
        }
    }

    #[test]
    fn decodes_completion_response_with_result() {
        match parse(
            r#"{"id":"c1","type":"response","command":"completion","success":true,"result":"Fix the reconnect bug"}"#,
        ) {
            Inbound::Response(r) => {
                assert_eq!(r.id, Some(RequestId("c1".to_owned())));
                assert_eq!(r.command, "completion");
                assert!(r.success);
                assert_eq!(r.session_id, "");
                assert_eq!(r.result.as_deref(), Some("Fix the reconnect bug"));
            }
            other => panic!("expected response, got {other:?}"),
        }
        match parse(r#"{"id":"c2","type":"response","command":"completion","success":false,"error":"boom"}"#) {
            Inbound::Response(r) => {
                assert!(!r.success);
                assert!(r.result.is_none());
                assert_eq!(r.error.as_deref(), Some("boom"));
            }
            other => panic!("expected response, got {other:?}"),
        }
    }

    #[test]
    fn decodes_text_delta_inside_message_update() {
        let line = r#"{"type":"message_update","sessionId":"s1","assistantMessageEvent":{"type":"text_delta","contentIndex":0,"delta":"pong","partial":{"role":"assistant","content":[]}},"message":{"role":"assistant","content":[]}}"#;
        match parse(line) {
            Inbound::MessageUpdate {
                session_id,
                assistant_message_event: AssistantMessageEvent::TextDelta { delta },
            } => {
                assert_eq!(session_id, "s1");
                assert_eq!(delta, "pong");
            }
            other => panic!("expected text delta, got {other:?}"),
        }
    }

    #[test]
    fn decodes_thinking_end_and_collapses_other_deltas() {
        match parse(
            r#"{"type":"message_update","sessionId":"s1","assistantMessageEvent":{"type":"thinking_end","contentIndex":0,"content":"the plan"}}"#,
        ) {
            Inbound::MessageUpdate {
                assistant_message_event: AssistantMessageEvent::ThinkingEnd { content },
                ..
            } => {
                assert_eq!(content, "the plan");
            }
            other => panic!("expected thinking end, got {other:?}"),
        }
        for line in [
            r#"{"type":"message_update","sessionId":"s1","assistantMessageEvent":{"type":"thinking_delta","contentIndex":0,"delta":"hmm"}}"#,
            r#"{"type":"message_update","sessionId":"s1","assistantMessageEvent":{"type":"toolcall_start","contentIndex":0}}"#,
        ] {
            assert!(matches!(
                parse(line),
                Inbound::MessageUpdate {
                    assistant_message_event: AssistantMessageEvent::Other,
                    ..
                },
            ));
        }
    }

    #[test]
    fn decodes_tool_execution_frames() {
        match parse(
            r#"{"type":"tool_execution_start","sessionId":"s1","toolCallId":"call_1","toolName":"bash","args":{"command":"echo hi"},"intent":"Running echo"}"#,
        ) {
            Inbound::ToolExecutionStart { session_id, call } => {
                assert_eq!(session_id, "s1");
                assert_eq!(call.tool_call_id, "call_1");
                assert_eq!(call.tool_name, "bash");
                assert_eq!(call.args["command"], "echo hi");
                assert_eq!(call.intent.as_deref(), Some("Running echo"));
            }
            other => panic!("expected tool start, got {other:?}"),
        }

        match parse(
            r#"{"type":"tool_execution_end","sessionId":"s1","toolCallId":"call_1","toolName":"bash","result":{"content":[]},"isError":false}"#,
        ) {
            Inbound::ToolExecutionEnd { session_id, end } => {
                assert_eq!(session_id, "s1");
                assert_eq!(end.tool_call_id, "call_1");
                assert!(!end.is_error);
            }
            other => panic!("expected tool end, got {other:?}"),
        }

        match parse(
            r#"{"type":"tool_execution_start","sessionId":"s2","toolCallId":"c","toolName":"mcp__x","args":{}}"#,
        ) {
            Inbound::ToolExecutionStart { call, .. } => assert_eq!(call.tool_name, "mcp__x"),
            other => panic!("expected unknown tool start, got {other:?}"),
        }
    }

    #[test]
    fn decodes_tool_execution_update_with_task_progress() {
        let line = r#"{"type":"tool_execution_update","sessionId":"s1","toolCallId":"call_2","toolName":"task","args":{"agent":"explore"},"partialResult":{"content":[{"type":"text","text":"Running..."}],"details":{"progress":[{"index":0,"status":"running","currentTool":"read"}]}}}"#;
        match parse(line) {
            Inbound::ToolExecutionUpdate { session_id, update } => {
                assert_eq!(session_id, "s1");
                assert_eq!(update.tool_call_id, "call_2");
                assert_eq!(update.tool_name, "task");
                assert_eq!(update.partial_result["details"]["progress"][0]["currentTool"], "read");
            }
            other => panic!("expected tool update, got {other:?}"),
        }
    }

    #[test]
    fn agent_lifecycle_and_unknown_frames() {
        match parse(r#"{"type":"agent_start","sessionId":"s9"}"#) {
            Inbound::AgentStart { session_id } => assert_eq!(session_id, "s9"),
            other => panic!("expected agent_start, got {other:?}"),
        }
        assert!(matches!(
            parse(r#"{"type":"agent_end","sessionId":"s1","messages":[]}"#),
            Inbound::AgentEnd { .. },
        ));
        assert!(matches!(
            parse(r#"{"type":"turn_end","sessionId":"s1"}"#),
            Inbound::TurnEnd { .. },
        ));
        assert!(matches!(parse(r#"{"type":"turn_start","sessionId":"s1"}"#), Inbound::Unknown));
    }

    #[test]
    fn decodes_error_frame() {
        match parse(r#"{"type":"error","sessionId":"s1","message":"AgentBusyError"}"#) {
            Inbound::Error { session_id, message } => {
                assert_eq!(session_id, "s1");
                assert_eq!(message, "AgentBusyError");
            }
            other => panic!("expected error, got {other:?}"),
        }
    }

    #[test]
    fn decodes_extension_ui_requests() {
        match parse(
            r#"{"type":"extension_ui_request","sessionId":"s1","id":"u1","method":"select","title":"Pick","options":["A","B","Other (type your own)"],"timeout":5000}"#,
        ) {
            Inbound::ExtensionUiRequest {
                session_id,
                request:
                    UiRequest::Select {
                        id,
                        title,
                        options,
                        timeout,
                    },
            } => {
                assert_eq!(session_id, "s1");
                assert_eq!(id, "u1");
                assert_eq!(title, "Pick");
                assert_eq!(options, ["A", "B", "Other (type your own)"]);
                assert_eq!(timeout, Some(5000));
            }
            other => panic!("expected select, got {other:?}"),
        }
        match parse(
            r#"{"type":"extension_ui_request","sessionId":"s1","id":"u2","method":"editor","title":"Enter your response:"}"#,
        ) {
            Inbound::ExtensionUiRequest {
                request: UiRequest::Editor { id, title, prefill },
                ..
            } => {
                assert_eq!(id, "u2");
                assert_eq!(title, "Enter your response:");
                assert!(prefill.is_none());
            }
            other => panic!("expected editor, got {other:?}"),
        }
        match parse(
            r#"{"type":"extension_ui_request","sessionId":"s1","id":"u3","method":"confirm","title":"Sure?","message":"do it"}"#,
        ) {
            Inbound::ExtensionUiRequest {
                request: UiRequest::Confirm { id, message, .. },
                ..
            } => {
                assert_eq!(id, "u3");
                assert_eq!(message, "do it");
            }
            other => panic!("expected confirm, got {other:?}"),
        }
        match parse(
            r#"{"type":"extension_ui_request","sessionId":"s1","id":"u4","method":"input","title":"Name","placeholder":"e.g. foo"}"#,
        ) {
            Inbound::ExtensionUiRequest {
                request: UiRequest::Input { placeholder, .. },
                ..
            } => {
                assert_eq!(placeholder.as_deref(), Some("e.g. foo"));
            }
            other => panic!("expected input, got {other:?}"),
        }
        match parse(
            r#"{"type":"extension_ui_request","sessionId":"s1","id":"u5","method":"notify","message":"heads up","notifyType":"warning"}"#,
        ) {
            Inbound::ExtensionUiRequest {
                request: UiRequest::Notify { message, notify_type },
                ..
            } => {
                assert_eq!(message, "heads up");
                assert_eq!(notify_type.as_deref(), Some("warning"));
            }
            other => panic!("expected notify, got {other:?}"),
        }
        match parse(r#"{"type":"extension_ui_request","sessionId":"s1","id":"u6","method":"cancel","targetId":"u1"}"#) {
            Inbound::ExtensionUiRequest {
                request: UiRequest::Cancel { target_id },
                ..
            } => assert_eq!(target_id, "u1"),
            other => panic!("expected cancel, got {other:?}"),
        }
        assert!(matches!(
            parse(
                r#"{"type":"extension_ui_request","sessionId":"s1","id":"u7","method":"setWidget","widgetKey":"k","widgetLines":["x"]}"#
            ),
            Inbound::ExtensionUiRequest {
                request: UiRequest::Ignore,
                ..
            },
        ));
        match parse(
            r#"{"type":"extension_ui_request","sessionId":"s1","id":"u8","method":"multiselect","options":["a"]}"#,
        ) {
            Inbound::ExtensionUiRequest {
                request: UiRequest::Unknown { id, method },
                ..
            } => {
                assert_eq!(id.as_deref(), Some("u8"));
                assert_eq!(method, "multiselect");
            }
            other => panic!("expected unknown, got {other:?}"),
        }
    }

    #[test]
    fn serializes_ui_responses() {
        assert_eq!(
            serde_json::to_value(UiResponse::value("s1", "u1", "A")).unwrap(),
            serde_json::json!({"type": "extension_ui_response", "sessionId": "s1", "id": "u1", "value": "A"}),
        );
        assert_eq!(
            serde_json::to_value(UiResponse::confirmed("s1", "u3", true)).unwrap(),
            serde_json::json!({"type": "extension_ui_response", "sessionId": "s1", "id": "u3", "confirmed": true}),
        );
        assert_eq!(
            serde_json::to_value(UiResponse::cancelled("s1", "u1", false)).unwrap(),
            serde_json::json!({"type": "extension_ui_response", "sessionId": "s1", "id": "u1", "cancelled": true}),
        );
        assert_eq!(
            serde_json::to_value(UiResponse::cancelled("s1", "u1", true)).unwrap(),
            serde_json::json!({"type": "extension_ui_response", "sessionId": "s1", "id": "u1", "cancelled": true, "timedOut": true}),
        );
    }
}
