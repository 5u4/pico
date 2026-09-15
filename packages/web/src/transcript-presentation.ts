import type {
  AgentAssistantMessage,
  AgentMessage,
  AgentToolResultMessage,
  AgentTranscript,
} from "@pico/contract/agent-message";
import { ApplicationError, ChatClosed } from "@pico/contract/errors";
import type * as FrontendState from "@pico/frontend-state/client";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import type {
  AssistantBlock,
  AssistantState,
  ToolCallPresentation,
  ToolState,
  TranscriptItem,
  TranscriptPresentation,
} from "./chat/chat-model.ts";

const timeFormat = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });

export function errorMessage(cause: Cause.Cause<unknown>): string {
  const error = Option.getOrNull(Cause.findErrorOption(cause));
  if (error instanceof ApplicationError) return error.message;
  if (error instanceof ChatClosed) return "This chat is closed. Create a new chat to continue.";
  return "The request could not be completed.";
}

export function presentTranscript(
  snapshot: AsyncResult.AsyncResult<AgentTranscript, unknown>,
  live: FrontendState.LiveChat,
  disclosures: ReadonlySet<string>,
  connection: FrontendState.Connection,
): TranscriptPresentation {
  const messages = Option.getOrElse(AsyncResult.value(snapshot), () => []);
  const results = new Map<string, AgentToolResultMessage[]>();
  for (const message of messages) {
    if (message.role !== "tool-result") continue;
    const current = results.get(message.toolCallId);
    if (current) current.push(message);
    else results.set(message.toolCallId, [message]);
  }
  const anchoredTools = new Set<string>();
  const items: TranscriptItem[] = [];
  const tool = (id: string, name: string, key: string) => {
    anchoredTools.add(id);
    const output = results.get(id);
    const activity = live.tools.get(id);
    const last = output?.at(-1);
    const state: ToolState = last
      ? { kind: last.status, label: last.status === "failed" ? "Failed" : "Complete" }
      : activity?.kind === "finished"
        ? {
            kind: activity.end.status,
            label: activity.end.status === "failed" ? "Failed" : "Complete",
          }
        : activity?.kind === "running" &&
            live.run.kind === "running" &&
            connection.kind === "active"
          ? { kind: "running", label: "Running" }
          : { kind: "unknown", label: "Status unknown" };
    const call: ToolCallPresentation = {
      id: key,
      label: name,
      summary: "Tool call",
      state,
      output: output
        ?.flatMap((message) =>
          message.content.map((content) =>
            content.type === "text" ? content.text : "[Image result]",
          ),
        )
        .join("\n"),
    };
    items.push({
      kind: "tool-group",
      id: key,
      title: `${name} · ${state.label}`,
      calls: [call],
      open: disclosures.has(key),
    });
  };
  const append = (message: AgentMessage, key: string) => {
    if (message.role === "user") {
      items.push({
        kind: "user",
        id: key,
        text: message.content
          .map((content) => (content.type === "text" ? content.text : "[Image attachment]"))
          .join("\n"),
        timestampLabel: timeFormat.format(message.timestamp),
      });
      return;
    }
    if (message.role === "tool-result") {
      if (!anchoredTools.has(message.toolCallId)) tool(message.toolCallId, message.toolName, key);
      return;
    }
    let blocks: AssistantBlock[] = [];
    let part = 0;
    const flush = () => {
      if (blocks.length === 0) return;
      items.push({
        kind: "assistant",
        id: `${key}-part-${part++}`,
        blocks,
        state: assistantState(message),
        timestampLabel: timeFormat.format(message.timestamp),
        modelLabel: message.model,
      });
      blocks = [];
    };
    for (const [index, content] of message.content.entries()) {
      const id = `${key}-content-${index}`;
      switch (content.type) {
        case "text":
          blocks.push({ kind: "text", id, text: content.text });
          break;
        case "thinking":
          blocks.push({
            kind: "thinking",
            id,
            label: "Thinking",
            text: content.text,
            open: disclosures.has(id),
            phase: "complete",
          });
          break;
        case "image":
          blocks.push({ kind: "text", id, text: "[Image response]" });
          break;
        case "tool-call":
          flush();
          tool(content.id, content.name, id);
          break;
        default: {
          const exhaustive: never = content;
          return exhaustive;
        }
      }
    }
    flush();
    if (message.status === "failed")
      items.push({
        kind: "notice",
        id: `${key}-failure`,
        tone: message.stopReason === "aborted" ? "warning" : "error",
        title: message.stopReason === "aborted" ? "Response stopped" : "Response failed",
        text: message.message ?? "Partial output is retained. Send a message to continue.",
      });
  };
  const appendDraft = (
    draft: Extract<FrontendState.LiveAssistant, { readonly kind: "draft" }>,
    key: string,
  ) => {
    const active =
      draft.phase === "streaming" && live.run.kind === "running" && connection.kind === "active";
    items.push({
      kind: "assistant",
      id: `${key}-part-0`,
      timestampLabel: "Live response",
      modelLabel: "pico",
      state: active
        ? { kind: "streaming", label: "Responding" }
        : { kind: "unknown", label: "Partial response retained" },
      blocks: [...draft.blocks.values()]
        .sort((a, b) => a.contentIndex - b.contentIndex)
        .map((block): AssistantBlock => {
          const id = `${key}-content-${block.contentIndex}`;
          return block.type === "text-delta"
            ? { kind: "text", id, text: block.text }
            : {
                kind: "thinking",
                id,
                label: "Thinking",
                text: block.text,
                open: disclosures.has(id),
                phase: active ? "streaming" : "unknown",
              };
        }),
    });
  };
  for (const [index, message] of messages.entries()) {
    append(message, message.role === "assistant" ? `assistant-${message.id}` : `snapshot-${index}`);
  }
  for (const [id, message] of live.assistant) {
    const key = `assistant-${id}`;
    if (message.kind === "settled") append(message.message, key);
    else appendDraft(message, key);
  }
  for (const [id, activity] of live.tools) {
    if (!anchoredTools.has(id))
      tool(
        id,
        activity.kind === "running" ? activity.start.toolName : activity.end.toolName,
        `live-tool-${id}`,
      );
  }
  for (const [index, notice] of live.notices.entries()) {
    items.push({
      kind: "notice",
      id: `notice-${index}`,
      tone: notice.level,
      title: notice.level === "error" ? "Request failed" : "Pico",
      text: notice.message,
    });
  }
  if (items.length > 0)
    return {
      state: "ready",
      items,
      liveLabel: live.run.kind === "running" ? "Response in progress" : "Conversation",
    };
  if (snapshot._tag === "Failure")
    return {
      state: "error",
      title: "History unavailable",
      description: `${errorMessage(snapshot.cause)} ${connection.kind === "unavailable" ? "Reload to reconnect." : "Retry loading the conversation."}`,
      retryLabel: connection.kind === "unavailable" ? "Reload" : "Retry history",
    };
  if (snapshot.waiting || snapshot._tag === "Initial")
    return { state: "loading", label: "Loading conversation..." };
  return {
    state: "empty",
    title: "Start a conversation",
    description: "Ask pico to help with the code in this workspace.",
  };
}

function assistantState(message: AgentAssistantMessage): AssistantState {
  return message.status === "completed"
    ? { kind: "complete" }
    : {
        kind: "interrupted",
        label: message.stopReason === "aborted" ? "Stopped" : "Response failed",
      };
}
