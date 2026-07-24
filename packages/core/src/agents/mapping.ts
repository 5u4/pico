import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent";
import type { ChatEvent, ChatMessage, ChatRole } from "./schema.ts";

type ContentPart = { readonly type: string; readonly text?: string };

function contentText(content: string | readonly ContentPart[]): string {
  if (typeof content === "string") return content;
  return content
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text ?? "")
    .join("");
}

function stringifyResult(result: unknown): string {
  if (typeof result === "string") return result;
  if (result === null || result === undefined) return "";
  try {
    return JSON.stringify(result) ?? String(result);
  } catch {
    return String(result);
  }
}

export function toChatMessage(message: AgentMessage): ChatMessage | null {
  const role = message.role;
  if (role !== "user" && role !== "assistant") return null;
  const chatRole: ChatRole = role;
  return { role: chatRole, text: contentText(message.content) };
}

export function toChatEvent(
  event: AgentSessionEvent,
  index: number,
): ChatEvent | null {
  switch (event.type) {
    case "message_update": {
      const inner = event.assistantMessageEvent;
      switch (inner.type) {
        case "text_delta":
          return { _tag: "text_delta", index, delta: inner.delta };
        case "thinking_delta":
          return { _tag: "thinking_delta", index, delta: inner.delta };
        case "error":
          return {
            _tag: "error",
            reason: inner.reason,
            message: contentText(inner.error.content),
          };
        default:
          return null;
      }
    }
    case "tool_execution_start":
      return {
        _tag: "tool_execution_start",
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        args: event.args,
      };
    case "tool_execution_end":
      return {
        _tag: "tool_execution_end",
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        result: stringifyResult(event.result),
        isError: event.isError ?? false,
      };
    case "agent_start":
      return { _tag: "agent_start" };
    case "agent_end":
      return { _tag: "agent_end" };
    case "turn_start":
      return { _tag: "turn_start" };
    case "turn_end":
      return { _tag: "turn_end" };
    default:
      return null;
  }
}
