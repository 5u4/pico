import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type {
  ImageContent,
  TextContent,
  ToolResultMessage,
} from "@oh-my-pi/pi-ai";
import type { JsonObject, UiMessage, UiPart } from "./protocol";

function textFrom(content: string | (TextContent | ImageContent)[]): string {
  if (typeof content === "string") return content;
  return content
    .filter((block): block is TextContent => block.type === "text")
    .map((block) => block.text)
    .join("");
}

function resultText(message: ToolResultMessage): string {
  return message.content
    .filter((block): block is TextContent => block.type === "text")
    .map((block) => block.text)
    .join("");
}

export function collectResults(
  messages: AgentMessage[],
): Map<string, ToolResultMessage> {
  const results = new Map<string, ToolResultMessage>();
  for (const message of messages) {
    if ("role" in message && message.role === "toolResult") {
      results.set(message.toolCallId, message);
    }
  }
  return results;
}

export function toUiMessage(
  message: AgentMessage,
  index: number,
  results: Map<string, ToolResultMessage>,
): UiMessage | undefined {
  if (!("role" in message)) return undefined;
  if (message.role === "user") {
    const text = textFrom(message.content);
    if (!text) return undefined;
    return { id: `m${index}`, role: "user", parts: [{ type: "text", text }] };
  }
  if (message.role !== "assistant") return undefined;

  const parts: UiPart[] = [];
  for (const block of message.content) {
    if (block.type === "text") {
      if (block.text) parts.push({ type: "text", text: block.text });
    } else if (block.type === "thinking") {
      if (block.thinking)
        parts.push({ type: "reasoning", text: block.thinking });
    } else if (block.type === "toolCall") {
      const result = results.get(block.id);
      parts.push({
        type: "tool-call",
        toolCallId: block.id,
        toolName: block.name,
        args: block.arguments as JsonObject,
        result: result ? resultText(result) : undefined,
        isError: result?.isError,
      });
    }
  }
  if (parts.length === 0) return undefined;
  return { id: `m${index}`, role: "assistant", parts };
}

export function toUiMessages(messages: AgentMessage[]): UiMessage[] {
  const results = collectResults(messages);
  const out: UiMessage[] = [];
  for (const [index, message] of messages.entries()) {
    const ui = toUiMessage(message, index, results);
    if (ui) out.push(ui);
  }
  return out;
}
