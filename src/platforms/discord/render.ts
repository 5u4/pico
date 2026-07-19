import type { Message, MessagePart } from "../../engine/message";

export const DISCORD_MESSAGE_CAP = 2000;
const TOOL_ARGS_CAP = 120;

export function defangMentions(text: string): string {
  return text
    .replaceAll("@everyone", "@\u200beveryone")
    .replaceAll("@here", "@\u200bhere")
    .replace(/<@(!?\d+)>/g, "<@\u200b$1>")
    .replace(/<@&(\d+)>/g, "<@&\u200b$1>");
}

function truncate(text: string, cap: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= cap) return trimmed;
  return `${trimmed.slice(0, cap - 1)}…`;
}

function toolLine(part: Extract<MessagePart, { type: "tool-call" }>): string {
  const args = truncate(JSON.stringify(part.args), TOOL_ARGS_CAP);
  const emoji = part.isError ? "⚠️" : "🛠️";
  return `${emoji} \`${part.toolName}\` ${args}`;
}

export function renderAssistant(messages: Message[]): string {
  const last = [...messages]
    .reverse()
    .find((message) => message.role === "assistant");
  if (!last) return "";
  const blocks: string[] = [];
  for (const part of last.parts) {
    if (part.type === "text") {
      const text = part.text.trim();
      if (text) blocks.push(text);
    } else if (part.type === "tool-call") {
      blocks.push(toolLine(part));
    }
  }
  return blocks.join("\n\n").trim();
}

export function splitToBudget(text: string, budget: number): string[] {
  if (text.length <= budget) return text.length > 0 ? [text] : [];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > budget) {
    let cut = rest.lastIndexOf("\n", budget);
    if (cut <= 0) cut = rest.lastIndexOf(" ", budget);
    if (cut <= 0) cut = budget;
    chunks.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest.length > 0) chunks.push(rest);
  return chunks;
}

export function renderReply(messages: Message[]): string[] {
  const rendered = renderAssistant(messages);
  if (!rendered) return [];
  return splitToBudget(defangMentions(rendered), DISCORD_MESSAGE_CAP);
}
