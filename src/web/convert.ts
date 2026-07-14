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

export function toUiMessages(messages: AgentMessage[]): UiMessage[] {
  const results = new Map<string, ToolResultMessage>();
  for (const message of messages) {
    if ("role" in message && message.role === "toolResult") {
      results.set(message.toolCallId, message);
    }
  }

  const out: UiMessage[] = [];
  for (const [index, message] of messages.entries()) {
    if (!("role" in message)) continue;
    if (message.role === "user") {
      const text = textFrom(message.content);
      if (text)
        out.push({
          id: `m${index}`,
          role: "user",
          parts: [{ type: "text", text }],
        });
      continue;
    }
    if (message.role !== "assistant") continue;

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
    if (parts.length > 0)
      out.push({ id: `m${index}`, role: "assistant", parts });
  }
  return out;
}
