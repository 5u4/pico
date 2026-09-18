import * as Schema from "effect/Schema";
import {
  AgentRunFinished,
  AgentTextDelta,
  AgentThinkingDelta,
  AgentToolFinished,
  AgentToolStarted,
  Publication,
} from "./agent-event.ts";
import {
  HistoryDraft,
  HistoryRevision,
  HistorySnapshot,
  HistoryVersion,
  NavigateHistoryConflictReason,
} from "./agent-history.ts";
import { AgentAssistantMessage, AgentMessageId, AgentTranscript } from "./agent-message.ts";
import { ContextUsage, ModelInfo, TodoState } from "./agent-runtime.ts";

const ObservedRun = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("idle") }),
  Schema.Struct({ kind: Schema.Literal("running") }),
  Schema.Struct({
    kind: Schema.Literal("finished"),
    outcome: AgentRunFinished.fields.outcome,
  }),
]);
const ObservedAssistant = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("draft"),
    messageId: AgentMessageId,
    blocks: Schema.Array(Schema.Union([AgentTextDelta, AgentThinkingDelta])),
  }),
  Schema.Struct({ kind: Schema.Literal("settled"), message: AgentAssistantMessage }),
]);
const ObservedTool = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("running"), start: AgentToolStarted }),
  Schema.Struct({
    kind: Schema.Literal("finished"),
    start: Schema.NullOr(AgentToolStarted),
    end: AgentToolFinished,
  }),
]);
export const RuntimeSnapshot = Schema.Struct({
  publication: Publication,
  run: ObservedRun,
  assistant: Schema.Array(ObservedAssistant),
  tools: Schema.Array(ObservedTool),
});
export type RuntimeSnapshot = typeof RuntimeSnapshot.Type;

export const TranscriptSnapshot = Schema.Struct({
  messages: AgentTranscript,
  todo: TodoState,
  contextUsage: Schema.Union([ContextUsage, Schema.Struct({ kind: Schema.Literal("error") })]),
  currentModel: Schema.NullOr(ModelInfo),
  historyRevision: HistoryRevision,
  runtime: RuntimeSnapshot,
});
export type TranscriptSnapshot = typeof TranscriptSnapshot.Type;

export const NavigateHistoryResult = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("cancelled") }),
  Schema.Struct({
    kind: Schema.Literal("applied"),
    snapshot: TranscriptSnapshot,
    draft: Schema.NullOr(HistoryDraft),
  }),
  Schema.Struct({
    kind: Schema.Literal("conflict"),
    reason: NavigateHistoryConflictReason,
    version: HistoryVersion,
    history: HistorySnapshot,
  }),
]);
export type NavigateHistoryResult = typeof NavigateHistoryResult.Type;
