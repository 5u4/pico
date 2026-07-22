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

export const ToolExecutionStart = Schema.TaggedStruct("tool_execution_start", {
  toolCallId: Schema.String,
  toolName: Schema.String,
  args: Schema.Unknown,
});

export const ToolExecutionEnd = Schema.TaggedStruct("tool_execution_end", {
  toolCallId: Schema.String,
  toolName: Schema.String,
  result: Schema.String,
  isError: Schema.Boolean,
});

export const AgentStart = Schema.TaggedStruct("agent_start", {});

export const AgentEnd = Schema.TaggedStruct("agent_end", {});

export const TurnStart = Schema.TaggedStruct("turn_start", {});

export const TurnEnd = Schema.TaggedStruct("turn_end", {});

export const TurnError = Schema.TaggedStruct("error", {
  reason: Schema.String,
  message: Schema.String,
});

export const ChatEvent = Schema.Union(
  AgentStart,
  AgentEnd,
  TurnStart,
  TurnEnd,
  TextDelta,
  ThinkingDelta,
  ToolExecutionStart,
  ToolExecutionEnd,
  TurnError,
);
export type ChatEvent = typeof ChatEvent.Type;
export const PromptOutcome = Schema.Union(Schema.TaggedStruct("Started", {}));
export type PromptOutcome = typeof PromptOutcome.Type;

export const started: PromptOutcome = { _tag: "Started" };
