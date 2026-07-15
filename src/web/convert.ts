import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type {
  AssistantMessage,
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

function assistantParts(
  message: AssistantMessage,
  results: Map<string, ToolResultMessage>,
): UiPart[] {
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
  return parts;
}

export function toUiMessages(messages: AgentMessage[]): UiMessage[] {
  const results = collectResults(messages);
  const out: UiMessage[] = [];
  let run: { id: string; parts: UiPart[] } | null = null;

  const flush = () => {
    if (run && run.parts.length > 0) {
      out.push({ id: run.id, role: "assistant", parts: run.parts });
    }
    run = null;
  };

  for (const [index, message] of messages.entries()) {
    if (!("role" in message)) continue;
    if (message.role === "user") {
      flush();
      const text = textFrom(message.content);
      if (text) {
        out.push({
          id: `m${index}`,
          role: "user",
          parts: [{ type: "text", text }],
        });
      }
      continue;
    }
    if (message.role === "assistant") {
      if (!run) run = { id: `m${index}`, parts: [] };
      run.parts.push(...assistantParts(message, results));
    }
  }
  flush();
  return out;
}

function runStartIndex(messages: AgentMessage[]): number {
  let start = messages.length;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (!message || !("role" in message)) continue;
    if (message.role === "user") break;
    if (message.role === "assistant") start = i;
  }
  return start;
}

export function toStreamMessage(
  committed: AgentMessage[],
  stream: AgentMessage,
): UiMessage | null {
  const start = runStartIndex(committed);
  const turn = [...committed.slice(start), stream];
  const results = collectResults(turn);
  const parts: UiPart[] = [];
  for (const message of turn) {
    if ("role" in message && message.role === "assistant") {
      parts.push(...assistantParts(message, results));
    }
  }
  if (parts.length === 0) return null;
  return { id: `m${start}`, role: "assistant", parts };
}
