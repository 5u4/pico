import { Schema } from "effect";

export const ChatRole = Schema.Literal("user", "assistant");
export type ChatRole = typeof ChatRole.Type;

export const ChatMessage = Schema.Struct({
  role: ChatRole,
  text: Schema.String,
});
export type ChatMessage = typeof ChatMessage.Type;

export const TextDelta = Schema.TaggedStruct("text_delta", {
  delta: Schema.String,
});

export const ThinkingDelta = Schema.TaggedStruct("thinking_delta", {
  delta: Schema.String,
});

export const ToolStart = Schema.TaggedStruct("tool_start", {
  toolCallId: Schema.String,
  name: Schema.String,
  args: Schema.Unknown,
});

export const ToolEnd = Schema.TaggedStruct("tool_end", {
  toolCallId: Schema.String,
  name: Schema.String,
  result: Schema.String,
  isError: Schema.Boolean,
});

export const TurnEnd = Schema.TaggedStruct("turn_end", {});

export const TurnError = Schema.TaggedStruct("error", {
  reason: Schema.String,
  message: Schema.String,
});

export const ChatEvent = Schema.Union(
  TextDelta,
  ThinkingDelta,
  ToolStart,
  ToolEnd,
  TurnEnd,
  TurnError,
);
export type ChatEvent = typeof ChatEvent.Type;

export const PromptOutcome = Schema.Union(Schema.TaggedStruct("Started", {}));
export type PromptOutcome = typeof PromptOutcome.Type;

export const started: PromptOutcome = { _tag: "Started" };
