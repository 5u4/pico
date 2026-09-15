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
import * as Schema from "effect/Schema";
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
const decodeArguments = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);

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
  const anchoredTools = new Set<string>();
  const indexAnchors = (message: AgentAssistantMessage) => {
    for (const content of message.content) {
      if (content.type === "tool-call") anchoredTools.add(content.id);
    }
  };
  for (const message of messages) {
    if (message.role === "assistant") indexAnchors(message);
    if (message.role !== "tool-result") continue;
    const current = results.get(message.toolCallId);
    if (current) current.push(message);
    else results.set(message.toolCallId, [message]);
  }
  for (const assistant of live.assistant.values()) {
    if (assistant.kind === "settled") indexAnchors(assistant.message);
  }
  const emittedTools = new Set<string>();
  const items: TranscriptItem[] = [];
  let tools: [ToolCallPresentation, ...ToolCallPresentation[]] | undefined;
  const flushTools = () => {
    if (!tools) return;
    items.push({
      kind: "tool-group",
      id: tools[0].id,
      title: toolGroupTitle(tools),
      calls: tools,
      open: tools.some((call) => disclosures.has(call.id)),
    });
    tools = undefined;
  };
  const tool = (id: string, name: string, argumentsJson?: string) => {
    if (emittedTools.has(id)) return;
    emittedTools.add(id);
    const key = `tool-${id}`;
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
    const argumentsText = argumentsJson ?? activity?.start?.argumentsJson;
    const call: ToolCallPresentation = {
      id: key,
      label: name,
      summary: toolSummary(argumentsText),
      arguments: argumentsText,
      open: disclosures.has(`details-${key}`),
      state,
      output: output
        ?.flatMap((message) =>
          message.content.map((content) =>
            content.type === "text" ? content.text : "[Image result]",
          ),
        )
        .join("\n"),
    };
    if (tools) tools.push(call);
    else tools = [call];
  };
  const append = (message: AgentMessage, key: string) => {
    if (message.role === "user") {
      flushTools();
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
      if (!anchoredTools.has(message.toolCallId)) tool(message.toolCallId, message.toolName);
      return;
    }
    flushTools();
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
          flushTools();
          blocks.push({ kind: "text", id, text: content.text });
          break;
        case "thinking":
          flushTools();
          blocks.push({
            kind: "thinking",
            id,
            label: message.status === "failed" ? "Thinking interrupted" : "Thought",
            text: content.text,
            open: disclosures.has(id),
          });
          break;
        case "image":
          flushTools();
          blocks.push({ kind: "text", id, text: "[Image response]" });
          break;
        case "tool-call":
          flush();
          tool(content.id, content.name, content.argumentsJson);
          break;
        default: {
          const exhaustive: never = content;
          return exhaustive;
        }
      }
    }
    flushTools();
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
    flushTools();
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
                label: active ? "Thinking" : "Thinking status unknown",
                text: block.text,
                open: disclosures.has(id),
              };
        }),
    });
  };
  for (const [index, message] of messages.entries()) {
    append(message, message.role === "assistant" ? `assistant-${message.id}` : `snapshot-${index}`);
  }
  flushTools();
  for (const [id, message] of live.assistant) {
    const key = `assistant-${id}`;
    if (message.kind === "settled") append(message.message, key);
    else appendDraft(message, key);
  }
  flushTools();
  for (const [id, activity] of live.tools) {
    if (!anchoredTools.has(id))
      tool(id, activity.kind === "running" ? activity.start.toolName : activity.end.toolName);
  }
  flushTools();
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

function toolSummary(argumentsText: string | undefined): string {
  if (argumentsText === undefined || argumentsText.trim() === "") return "Arguments unavailable";
  const parsed = decodeArguments(argumentsText);
  if (Option.isSome(parsed)) {
    for (const field of ["i", "path", "command", "query", "pattern"]) {
      const value = parsed.value[field];
      if (typeof value === "string" && value.trim() !== "") return value.trim();
    }
  }
  return argumentsText;
}

function toolGroupTitle(calls: readonly ToolCallPresentation[]): string {
  const counts: Record<ToolState["kind"], number> = {
    failed: 0,
    running: 0,
    unknown: 0,
    succeeded: 0,
  };
  for (const call of calls) counts[call.state.kind]++;
  if (counts.succeeded === calls.length) return "Complete";
  const labels: string[] = [];
  if (counts.failed > 0) labels.push(`${counts.failed} failed`);
  if (counts.running > 0) labels.push(`${counts.running} running`);
  if (counts.unknown > 0) labels.push(`${counts.unknown} status unknown`);
  if (counts.succeeded > 0) labels.push(`${counts.succeeded} complete`);
  return labels.join(" · ");
}
