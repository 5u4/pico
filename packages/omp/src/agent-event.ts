import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session-events";
import type { AgentEvent } from "@pico/contract/agent-event";
import type * as Agent from "@pico/contract/agent-message";

type SessionMessage = Extract<AgentSessionEvent, { readonly type: "message_end" }>["message"];
type UserMessage = Extract<SessionMessage, { readonly role: "user" }>;
type AssistantMessage = Extract<SessionMessage, { readonly role: "assistant" }>;
type ToolResultMessage = Extract<SessionMessage, { readonly role: "toolResult" }>;

const stringifyArguments = (value: object): string => JSON.stringify(value) ?? "null";

const normalizeUserContent = (
  content: UserMessage["content"],
): ReadonlyArray<Agent.AgentUserContent> => {
  if (typeof content === "string") return [{ type: "text", text: content }];

  return content.map((block) => {
    switch (block.type) {
      case "text":
        return { type: "text", text: block.text };
      case "image":
        return { type: "image", data: block.data, mimeType: block.mimeType };
      default: {
        const exhaustive: never = block;
        return exhaustive;
      }
    }
  });
};

const normalizeAssistantContent = (
  content: AssistantMessage["content"],
): ReadonlyArray<Agent.AgentAssistantContent> => {
  const normalized: Array<Agent.AgentAssistantContent> = [];
  for (const block of content) {
    switch (block.type) {
      case "text":
        normalized.push({ type: "text", text: block.text });
        break;
      case "thinking":
        normalized.push({ type: "thinking", text: block.thinking });
        break;
      case "image":
        normalized.push({ type: "image", data: block.data, mimeType: block.mimeType });
        break;
      case "toolCall":
        normalized.push({
          type: "tool-call",
          id: block.id,
          name: block.name,
          argumentsJson: stringifyArguments(block.arguments),
        });
        break;
      case "redactedThinking":
      case "fallback":
      case "anthropicServerTool":
        break;
      default: {
        const exhaustive: never = block;
        return exhaustive;
      }
    }
  }
  return normalized;
};

const normalizeToolResultContent = (
  content: ToolResultMessage["content"],
): ReadonlyArray<Agent.AgentToolResultContent> =>
  content.map((block) => {
    switch (block.type) {
      case "text":
        return { type: "text", text: block.text };
      case "image":
        return { type: "image", data: block.data, mimeType: block.mimeType };
      default: {
        const exhaustive: never = block;
        return exhaustive;
      }
    }
  });

export const normalizeMessage = (message: SessionMessage): Agent.AgentMessage | undefined => {
  switch (message.role) {
    case "user":
      return {
        role: "user",
        content: normalizeUserContent(message.content),
        timestamp: message.timestamp,
      };
    case "assistant": {
      const content = normalizeAssistantContent(message.content);
      switch (message.stopReason) {
        case "stop":
        case "length":
        case "toolUse":
          return {
            role: "assistant",
            status: "completed",
            stopReason: message.stopReason === "toolUse" ? "tool-use" : message.stopReason,
            content,
            model: message.model,
            timestamp: message.timestamp,
          };
        case "error":
        case "aborted":
          return {
            role: "assistant",
            status: "failed",
            stopReason: message.stopReason,
            message: message.errorMessage ?? null,
            content,
            model: message.model,
            timestamp: message.timestamp,
          };
        default: {
          const exhaustive: never = message.stopReason;
          return exhaustive;
        }
      }
    }
    case "toolResult":
      return {
        role: "tool-result",
        toolCallId: message.toolCallId,
        toolName: message.toolName,
        content: normalizeToolResultContent(message.content),
        status: message.isError ? "failed" : "succeeded",
        timestamp: message.timestamp,
      };
    case "developer":
    case "bashExecution":
    case "pythonExecution":
    case "custom":
    case "hookMessage":
    case "branchSummary":
    case "compactionSummary":
    case "fileMention":
      return undefined;
    default: {
      const exhaustive: never = message;
      return exhaustive;
    }
  }
};

export const normalizeTranscript = (
  messages: ReadonlyArray<SessionMessage>,
): Agent.AgentTranscript => {
  const transcript: Array<Agent.AgentMessage> = [];
  for (const message of messages) {
    const normalized = normalizeMessage(message);
    if (normalized !== undefined) transcript.push(normalized);
  }
  return transcript;
};

const normalizeMessageUpdate = (
  event: Extract<AgentSessionEvent, { readonly type: "message_update" }>,
): AgentEvent | undefined => {
  switch (event.assistantMessageEvent.type) {
    case "text_delta":
      return {
        type: "text-delta",
        contentIndex: event.assistantMessageEvent.contentIndex,
        text: event.assistantMessageEvent.delta,
      };
    case "thinking_delta":
      return {
        type: "thinking-delta",
        contentIndex: event.assistantMessageEvent.contentIndex,
        text: event.assistantMessageEvent.delta,
      };
    case "start":
    case "text_start":
    case "text_end":
    case "thinking_start":
    case "thinking_end":
    case "image_end":
    case "toolcall_start":
    case "toolcall_delta":
    case "toolcall_end":
    case "done":
    case "error":
      return undefined;
    default: {
      const exhaustive: never = event.assistantMessageEvent;
      return exhaustive;
    }
  }
};

const runOutcome = (
  messages: Extract<AgentSessionEvent, { readonly type: "agent_end" }>["messages"],
): "completed" | "failed" | "aborted" => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "assistant") continue;
    if (message.stopReason === "aborted") return "aborted";
    if (message.stopReason === "error") return "failed";
    return "completed";
  }
  return "completed";
};

export const normalizeAgentEvent = (event: AgentSessionEvent): AgentEvent | undefined => {
  switch (event.type) {
    case "agent_start":
      return { type: "run-started" };
    case "agent_end":
      return event.isTerminal === false
        ? undefined
        : { type: "run-finished", outcome: runOutcome(event.messages) };
    case "message_update":
      return normalizeMessageUpdate(event);
    case "message_end": {
      const message = normalizeMessage(event.message);
      return message === undefined ? undefined : { type: "message-settled", message };
    }
    case "tool_execution_start":
      return {
        type: "tool-started",
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        argumentsJson: stringifyArguments(event.args),
      };
    case "tool_execution_end":
      return {
        type: "tool-finished",
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        status: event.isError === true ? "failed" : "succeeded",
      };
    case "notice":
      return { type: "notice", level: event.level, message: event.message };
    case "turn_start":
    case "turn_end":
    case "message_start":
    case "tool_execution_update":
    case "auto_compaction_start":
    case "auto_compaction_end":
    case "auto_retry_start":
    case "auto_retry_end":
    case "retry_fallback_applied":
    case "retry_fallback_succeeded":
    case "model_changed":
    case "advisor_cost_changed":
    case "ttsr_triggered":
    case "todo_reminder":
    case "todo_auto_clear":
    case "irc_message":
    case "thinking_level_changed":
    case "goal_updated":
      return undefined;
    default: {
      const exhaustive: never = event;
      return exhaustive;
    }
  }
};
