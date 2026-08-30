import * as Schema from "effect/Schema";

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
