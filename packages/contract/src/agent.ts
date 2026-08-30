import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as Stream from "effect/Stream";
import { ChatId, type ChatId as ChatIdType } from "./chat.ts";

export const AgentPrompt = Schema.NonEmptyString;
export type AgentPrompt = typeof AgentPrompt.Type;

export const AgentText = Schema.Struct({
  type: Schema.Literal("text"),
  text: Schema.String,
});
export type AgentText = typeof AgentText.Type;

export const AgentThinking = Schema.Struct({
  type: Schema.Literal("thinking"),
  text: Schema.String,
});
export type AgentThinking = typeof AgentThinking.Type;

export const AgentImage = Schema.Struct({
  type: Schema.Literal("image"),
  data: Schema.String,
  mimeType: Schema.NonEmptyString,
});
export type AgentImage = typeof AgentImage.Type;

export const AgentToolCall = Schema.Struct({
  type: Schema.Literal("tool-call"),
  id: Schema.NonEmptyString,
  name: Schema.NonEmptyString,
  argumentsJson: Schema.String,
});
export type AgentToolCall = typeof AgentToolCall.Type;

export const AgentUserContent = Schema.Union([AgentText, AgentImage]);
export type AgentUserContent = typeof AgentUserContent.Type;

export const AgentAssistantContent = Schema.Union([
  AgentText,
  AgentThinking,
  AgentImage,
  AgentToolCall,
]);
export type AgentAssistantContent = typeof AgentAssistantContent.Type;

export const AgentToolResultContent = Schema.Union([AgentText, AgentImage]);
export type AgentToolResultContent = typeof AgentToolResultContent.Type;

export const AgentUserMessage = Schema.Struct({
  role: Schema.Literal("user"),
  content: Schema.Array(AgentUserContent),
  timestamp: Schema.Natural,
});
export type AgentUserMessage = typeof AgentUserMessage.Type;

const AgentCompletedAssistantMessage = Schema.Struct({
  role: Schema.Literal("assistant"),
  status: Schema.Literal("completed"),
  stopReason: Schema.Literals(["stop", "length", "tool-use"]),
  content: Schema.Array(AgentAssistantContent),
  model: Schema.NonEmptyString,
  timestamp: Schema.Natural,
});

const AgentFailedAssistantMessage = Schema.Struct({
  role: Schema.Literal("assistant"),
  status: Schema.Literal("failed"),
  stopReason: Schema.Literals(["error", "aborted"]),
  message: Schema.NullOr(Schema.String),
  content: Schema.Array(AgentAssistantContent),
  model: Schema.NonEmptyString,
  timestamp: Schema.Natural,
});

export const AgentAssistantMessage = Schema.Union([
  AgentCompletedAssistantMessage,
  AgentFailedAssistantMessage,
]);
export type AgentAssistantMessage = typeof AgentAssistantMessage.Type;

export const AgentToolResultMessage = Schema.Struct({
  role: Schema.Literal("tool-result"),
  toolCallId: Schema.NonEmptyString,
  toolName: Schema.NonEmptyString,
  content: Schema.Array(AgentToolResultContent),
  status: Schema.Literals(["succeeded", "failed"]),
  timestamp: Schema.Natural,
});
export type AgentToolResultMessage = typeof AgentToolResultMessage.Type;

export const AgentMessage = Schema.Union([
  AgentUserMessage,
  AgentAssistantMessage,
  AgentToolResultMessage,
]);
export type AgentMessage = typeof AgentMessage.Type;

export const AgentTranscript = Schema.Array(AgentMessage);
export type AgentTranscript = typeof AgentTranscript.Type;

export const AgentRunStarted = Schema.Struct({
  type: Schema.Literal("run-started"),
});

export const AgentTextDelta = Schema.Struct({
  type: Schema.Literal("text-delta"),
  contentIndex: Schema.Natural,
  text: Schema.String,
});

export const AgentThinkingDelta = Schema.Struct({
  type: Schema.Literal("thinking-delta"),
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

export const AgentEvent = Schema.Union([
  AgentRunStarted,
  AgentTextDelta,
  AgentThinkingDelta,
  AgentMessageSettled,
  AgentToolStarted,
  AgentToolFinished,
  AgentNotice,
  AgentRunFinished,
]);
export type AgentEvent = typeof AgentEvent.Type;

export const AgentEventEnvelope = Schema.Struct({
  chatId: ChatId,
  event: AgentEvent,
});
export type AgentEventEnvelope = typeof AgentEventEnvelope.Type;

export class AgentError extends Schema.TaggedError<AgentError>()("AgentError", {
  message: Schema.String,
}) {}

export class AgentRuntime extends Context.Service<
  AgentRuntime,
  {
    readonly events: Stream.Stream<AgentEventEnvelope>;

    readonly transcript: (chatId: ChatIdType) => Effect.Effect<AgentTranscript, AgentError>;

    readonly send: (chatId: ChatIdType, prompt: AgentPrompt) => Effect.Effect<void, AgentError>;

    readonly abort: (chatId: ChatIdType) => Effect.Effect<void, AgentError>;
  }
>()("@pico/contract/agent/AgentRuntime") {}
