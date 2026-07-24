import { Schema } from "effect";
import { WireMessage } from "./entities.ts";

export const WireInFlight = Schema.Struct({
  index: Schema.Number,
  message: WireMessage,
});
export type WireInFlight = typeof WireInFlight.Type;

export const SnapshotFrame = Schema.TaggedStruct("snapshot", {
  messages: Schema.Array(WireMessage),
  hasMore: Schema.Boolean,
  nextCursor: Schema.NullOr(Schema.Number),
  inFlight: Schema.NullOr(WireInFlight),
});
export type SnapshotFrame = typeof SnapshotFrame.Type;

export const TextDeltaFrame = Schema.TaggedStruct("text_delta", {
  index: Schema.Number,
  delta: Schema.String,
});

export const ThinkingDeltaFrame = Schema.TaggedStruct("thinking_delta", {
  index: Schema.Number,
  delta: Schema.String,
});

export const ToolExecutionStartFrame = Schema.TaggedStruct(
  "tool_execution_start",
  {
    toolCallId: Schema.String,
    toolName: Schema.String,
    args: Schema.Unknown,
  },
);

export const ToolExecutionEndFrame = Schema.TaggedStruct("tool_execution_end", {
  toolCallId: Schema.String,
  toolName: Schema.String,
  result: Schema.String,
  isError: Schema.Boolean,
});

export const AgentStartFrame = Schema.TaggedStruct("agent_start", {});
export const AgentEndFrame = Schema.TaggedStruct("agent_end", {});
export const TurnStartFrame = Schema.TaggedStruct("turn_start", {});
export const TurnEndFrame = Schema.TaggedStruct("turn_end", {});

export const ErrorFrame = Schema.TaggedStruct("error", {
  reason: Schema.String,
  message: Schema.String,
});

export const StreamFrame = Schema.Union(
  SnapshotFrame,
  TextDeltaFrame,
  ThinkingDeltaFrame,
  ToolExecutionStartFrame,
  ToolExecutionEndFrame,
  AgentStartFrame,
  AgentEndFrame,
  TurnStartFrame,
  TurnEndFrame,
  ErrorFrame,
);
export type StreamFrame = typeof StreamFrame.Type;
