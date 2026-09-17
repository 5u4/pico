import * as Schema from "effect/Schema";
import { AgentMessage, AgentMessageId } from "./agent-message.ts";
import { ChatId } from "./chat-model.ts";

export const AgentRunStarted = Schema.Struct({
  type: Schema.Literal("run-started"),
});

export const AgentTextDelta = Schema.Struct({
  type: Schema.Literal("text-delta"),
  messageId: AgentMessageId,
  contentIndex: Schema.Natural,
  text: Schema.String,
});

export const AgentThinkingDelta = Schema.Struct({
  type: Schema.Literal("thinking-delta"),
  messageId: AgentMessageId,
  contentIndex: Schema.Natural,
  text: Schema.String,
});

export const AgentMessageSettled = Schema.Struct({
  type: Schema.Literal("message-settled"),
  message: AgentMessage,
});

export const AgentToolStarted = Schema.Struct({
  type: Schema.Literal("tool-started"),
  toolCallId: Schema.NonEmptyString,
  toolName: Schema.NonEmptyString,
  argumentsJson: Schema.String,
});

export const AgentToolFinished = Schema.Struct({
  type: Schema.Literal("tool-finished"),
  toolCallId: Schema.NonEmptyString,
  toolName: Schema.NonEmptyString,
  status: Schema.Literals(["succeeded", "failed"]),
});

export const AgentNotice = Schema.Struct({
  type: Schema.Literal("notice"),
  level: Schema.Literals(["info", "warning", "error"]),
  message: Schema.String,
});

export const AgentRunFinished = Schema.Struct({
  type: Schema.Literal("run-finished"),
  outcome: Schema.Literals(["completed", "failed", "aborted"]),
});

export const AgentTitleChanged = Schema.Struct({
  type: Schema.Literal("title-changed"),
  title: Schema.NonEmptyString,
});

export const AgentContextInvalidated = Schema.Struct({
  type: Schema.Literal("context-invalidated"),
});

export const AgentEvent = Schema.Union([
  AgentRunStarted,
  AgentTextDelta,
  AgentThinkingDelta,
  AgentMessageSettled,
  AgentToolStarted,
  AgentToolFinished,
  AgentNotice,
  AgentRunFinished,
  AgentTitleChanged,
  AgentContextInvalidated,
]);
export type AgentEvent = typeof AgentEvent.Type;

export const Publication = Schema.Natural.pipe(Schema.brand("Publication"));
export type Publication = typeof Publication.Type;

export const AgentEventEnvelope = Schema.Struct({
  chatId: ChatId,
  event: AgentEvent,
  publication: Publication,
  origin: Schema.Literals(["session", "delivery"]),
  localOnly: Schema.optional(Schema.Literal(true)),
});
export type AgentEventEnvelope = typeof AgentEventEnvelope.Type;

export const EventsFrame = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("ready") }),
  Schema.Struct({ kind: Schema.Literal("event"), envelope: AgentEventEnvelope }),
]);
export type EventsFrame = typeof EventsFrame.Type;
