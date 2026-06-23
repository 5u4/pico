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
    SetSessionName {
        id: &'a RequestId,
        name: &'a str,
    },
}

impl Command<'_> {
    pub(crate) fn kind(&self) -> &'static str {
        match self {
            Command::Prompt { .. } => "prompt",
            Command::Steer { .. } => "steer",
            Command::FollowUp { .. } => "follow_up",
            Command::Abort { .. } => "abort",
            Command::NewSession { .. } => "new_session",
            Command::SetModel { .. } => "set_model",
            Command::SetSessionName { .. } => "set_session_name",
        }
    }
}

#[derive(Debug, Deserialize)]
pub(crate) struct RpcResponse {
    pub id: Option<RequestId>,
    pub command: String,
    pub success: bool,
    #[serde(default)]
    pub error: Option<String>,
}

#[derive(Debug, Clone)]
pub enum OmpEvent {
    AgentStart,
    Message(AssistantMessageEvent),
    ToolStart(ToolCallStart),
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
    TextEnd,
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
#[serde(from = "ToolCall")]
pub enum ToolCallStart {
    Read(ToolCall),
    Search(ToolCall),
    Find(ToolCall),
    Lsp(ToolCall),
    Edit(ToolCall),
    Write(ToolCall),
    Bash(ToolCall),
    Browser(ToolCall),
    Eval(ToolCall),
    WebSearch(ToolCall),
    Task(ToolCall),
    Job(ToolCall),
    Todo(ToolCall),
    Github(ToolCall),
    Irc(ToolCall),
    AstGrep(ToolCall),
    AstEdit(ToolCall),
    Debug(ToolCall),
    InspectImage(ToolCall),
    ManageSkill(ToolCall),
    Resolve(ToolCall),
    GenerateImage(ToolCall),
    Camo(ToolCall),
    Unknown(ToolCall),
}

impl From<ToolCall> for ToolCallStart {
    fn from(call: ToolCall) -> Self {
        match call.tool_name.as_str() {
            "read" => Self::Read(call),
            "search" => Self::Search(call),
            "find" => Self::Find(call),
            "lsp" => Self::Lsp(call),
            "edit" => Self::Edit(call),
            "write" => Self::Write(call),
            "bash" => Self::Bash(call),
            "browser" => Self::Browser(call),
            "eval" => Self::Eval(call),
            "web_search" => Self::WebSearch(call),
            "task" => Self::Task(call),
            "job" => Self::Job(call),
            "todo" => Self::Todo(call),
            "github" => Self::Github(call),
            "irc" => Self::Irc(call),
            "ast_grep" => Self::AstGrep(call),
            "ast_edit" => Self::AstEdit(call),
            "debug" => Self::Debug(call),
            "inspect_image" => Self::InspectImage(call),
            "manage_skill" => Self::ManageSkill(call),
            "resolve" => Self::Resolve(call),
            "generate_image" => Self::GenerateImage(call),
            name if name.starts_with("camo_") => Self::Camo(call),
            _ => Self::Unknown(call),
        }
    }
}

impl ToolCallStart {
    pub fn call(&self) -> &ToolCall {
        match self {
            Self::Read(c)
            | Self::Search(c)
            | Self::Find(c)
            | Self::Lsp(c)
            | Self::Edit(c)
            | Self::Write(c)
            | Self::Bash(c)
            | Self::Browser(c)
            | Self::Eval(c)
            | Self::WebSearch(c)
            | Self::Task(c)
            | Self::Job(c)
            | Self::Todo(c)
            | Self::Github(c)
            | Self::Irc(c)
            | Self::AstGrep(c)
            | Self::AstEdit(c)
            | Self::Debug(c)
            | Self::InspectImage(c)
            | Self::ManageSkill(c)
            | Self::Resolve(c)
            | Self::GenerateImage(c)
            | Self::Camo(c)
            | Self::Unknown(c) => c,
        }
    }
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

    pub fn value(id: &'a str, value: &'a str) -> Self {
        Self {
            kind: Self::KIND,
            id,
            value: Some(value),
            confirmed: None,
            cancelled: None,
            timed_out: None,
        }
    }

    pub fn confirmed(id: &'a str, confirmed: bool) -> Self {
        Self {
            kind: Self::KIND,
            id,
            value: None,
            confirmed: Some(confirmed),
            cancelled: None,
            timed_out: None,
        }
    }

    pub fn cancelled(id: &'a str, timed_out: bool) -> Self {
        Self {
            kind: Self::KIND,
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
    AgentStart,
    AgentEnd,
    TurnEnd,
    MessageUpdate {
        assistant_message_event: AssistantMessageEvent,
    },
    ToolExecutionStart(ToolCallStart),
    ToolExecutionUpdate(ToolCallUpdate),
    ToolExecutionEnd(ToolCallEnd),
    ExtensionUiRequest(UiRequest),
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
            Inbound::ToolExecutionStart(ToolCallStart::Bash(c)) => {
                assert_eq!(c.tool_call_id, "call_1");
                assert_eq!(c.tool_name, "bash");
                assert_eq!(c.args["command"], "echo hi");
                assert_eq!(c.intent.as_deref(), Some("Running echo"));
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

        match parse(r#"{"type":"tool_execution_start","toolCallId":"c","toolName":"mcp__x","args":{}}"#) {
            Inbound::ToolExecutionStart(ToolCallStart::Unknown(c)) => assert_eq!(c.tool_name, "mcp__x"),
            other => panic!("expected unknown tool start, got {other:?}"),
        }
    }

    #[test]
    fn decodes_tool_execution_update_with_task_progress() {
        let line = r#"{"type":"tool_execution_update","toolCallId":"call_2","toolName":"task","args":{"agent":"explore"},"partialResult":{"content":[{"type":"text","text":"Running..."}],"details":{"progress":[{"index":0,"status":"running","currentTool":"read"}]}}}"#;
        match parse(line) {
            Inbound::ToolExecutionUpdate(t) => {
                assert_eq!(t.tool_call_id, "call_2");
                assert_eq!(t.tool_name, "task");
                assert_eq!(t.partial_result["details"]["progress"][0]["currentTool"], "read");
            }
            other => panic!("expected tool update, got {other:?}"),
        }
    }

    #[test]
    fn agent_lifecycle_and_unknown_frames() {
        assert!(matches!(parse(r#"{"type":"agent_start"}"#), Inbound::AgentStart));
        assert!(matches!(parse(r#"{"type":"agent_end","messages":[]}"#), Inbound::AgentEnd));
        assert!(matches!(parse(r#"{"type":"turn_start"}"#), Inbound::Unknown));
    }

    #[test]
    fn decodes_extension_ui_requests() {
        match parse(
            r#"{"type":"extension_ui_request","id":"u1","method":"select","title":"Pick","options":["A","B","Other (type your own)"],"timeout":5000}"#,
        ) {
            Inbound::ExtensionUiRequest(UiRequest::Select {
                id,
                title,
                options,
                timeout,
            }) => {
                assert_eq!(id, "u1");
                assert_eq!(title, "Pick");
                assert_eq!(options, ["A", "B", "Other (type your own)"]);
                assert_eq!(timeout, Some(5000));
            }
            other => panic!("expected select, got {other:?}"),
        }
        match parse(r#"{"type":"extension_ui_request","id":"u2","method":"editor","title":"Enter your response:"}"#) {
            Inbound::ExtensionUiRequest(UiRequest::Editor { id, title, prefill }) => {
                assert_eq!(id, "u2");
                assert_eq!(title, "Enter your response:");
                assert!(prefill.is_none());
            }
            other => panic!("expected editor, got {other:?}"),
        }
        match parse(r#"{"type":"extension_ui_request","id":"u3","method":"confirm","title":"Sure?","message":"do it"}"#)
        {
            Inbound::ExtensionUiRequest(UiRequest::Confirm { id, message, .. }) => {
                assert_eq!(id, "u3");
                assert_eq!(message, "do it");
            }
            other => panic!("expected confirm, got {other:?}"),
        }
        match parse(
            r#"{"type":"extension_ui_request","id":"u4","method":"input","title":"Name","placeholder":"e.g. foo"}"#,
        ) {
            Inbound::ExtensionUiRequest(UiRequest::Input { placeholder, .. }) => {
                assert_eq!(placeholder.as_deref(), Some("e.g. foo"));
            }
            other => panic!("expected input, got {other:?}"),
        }
        match parse(
            r#"{"type":"extension_ui_request","id":"u5","method":"notify","message":"heads up","notifyType":"warning"}"#,
        ) {
            Inbound::ExtensionUiRequest(UiRequest::Notify { message, notify_type }) => {
                assert_eq!(message, "heads up");
                assert_eq!(notify_type.as_deref(), Some("warning"));
            }
            other => panic!("expected notify, got {other:?}"),
        }
        match parse(r#"{"type":"extension_ui_request","id":"u6","method":"cancel","targetId":"u1"}"#) {
            Inbound::ExtensionUiRequest(UiRequest::Cancel { target_id }) => assert_eq!(target_id, "u1"),
            other => panic!("expected cancel, got {other:?}"),
        }
        assert!(matches!(
            parse(
                r#"{"type":"extension_ui_request","id":"u7","method":"setWidget","widgetKey":"k","widgetLines":["x"]}"#
            ),
            Inbound::ExtensionUiRequest(UiRequest::Ignore),
        ));
        match parse(r#"{"type":"extension_ui_request","id":"u8","method":"multiselect","options":["a"]}"#) {
            Inbound::ExtensionUiRequest(UiRequest::Unknown { id, method }) => {
                assert_eq!(id.as_deref(), Some("u8"));
                assert_eq!(method, "multiselect");
            }
            other => panic!("expected unknown, got {other:?}"),
        }
    }

    #[test]
    fn serializes_ui_responses() {
        assert_eq!(
            serde_json::to_value(UiResponse::value("u1", "A")).unwrap(),
            serde_json::json!({"type": "extension_ui_response", "id": "u1", "value": "A"}),
        );
        assert_eq!(
            serde_json::to_value(UiResponse::confirmed("u3", true)).unwrap(),
            serde_json::json!({"type": "extension_ui_response", "id": "u3", "confirmed": true}),
        );
        assert_eq!(
            serde_json::to_value(UiResponse::cancelled("u1", false)).unwrap(),
            serde_json::json!({"type": "extension_ui_response", "id": "u1", "cancelled": true}),
        );
        assert_eq!(
            serde_json::to_value(UiResponse::cancelled("u1", true)).unwrap(),
            serde_json::json!({"type": "extension_ui_response", "id": "u1", "cancelled": true, "timedOut": true}),
        );
    }
}
