import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as Stream from "effect/Stream";
import type { AgentEventEnvelope } from "./agent-event.ts";
import type { AgentAssistantMessage, AgentPrompt } from "./agent-message.ts";
import type { TranscriptSnapshot } from "./agent-snapshot.ts";
import type { ChatId } from "./chat-model.ts";
import type { AgentError } from "./errors.ts";
import type { AbsolutePath } from "./path.ts";
import type { ScheduleRunId } from "./schedule.ts";

export const ModelRef = Schema.Struct({
  provider: Schema.NonEmptyString,
  id: Schema.NonEmptyString,
});
export type ModelRef = typeof ModelRef.Type;

export interface ModelInfo extends ModelRef {
  readonly name: string;
}

export interface ModelSwitchResult {
  readonly kind: "persisted" | "persistence-unconfirmed";
  readonly model: ModelInfo;
}

export const ShakeMode = Schema.Literals(["elide", "images", "thinking"]);
export type ShakeMode = typeof ShakeMode.Type;

export const ShakeResult = Schema.Union([
  Schema.Struct({
    mode: Schema.Literal("elide"),
    toolResultsDropped: Schema.Number,
    blocksDropped: Schema.Number,
    tokensFreed: Schema.Number,
  }),
  Schema.Struct({
    mode: Schema.Literal("images"),
    imagesDropped: Schema.Number,
    tokensFreed: Schema.Number,
  }),
  Schema.Struct({
    mode: Schema.Literal("thinking"),
    thinkingBlocksDropped: Schema.Number,
    tokensFreed: Schema.Number,
  }),
]);
export type ShakeResult = typeof ShakeResult.Type;

export const ContextUsage = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("unavailable") }),
  Schema.Struct({
    kind: Schema.Literal("available"),
    contextWindow: Schema.Number,
    usedTokens: Schema.Number,
    systemPromptTokens: Schema.Number,
    systemToolsTokens: Schema.Number,
    systemContextTokens: Schema.Number,
    skillsTokens: Schema.Number,
    messagesTokens: Schema.Number,
  }),
]);
export type ContextUsage = typeof ContextUsage.Type;

export const TodoTask = Schema.Struct({
  content: Schema.String,
  status: Schema.Literals(["pending", "in_progress", "completed", "abandoned", "blocked"]),
  blocker: Schema.optional(Schema.String),
});
export type TodoTask = typeof TodoTask.Type;

export const TodoPhases = Schema.Array(
  Schema.Struct({ name: Schema.String, tasks: Schema.Array(TodoTask) }),
);
export type TodoPhases = typeof TodoPhases.Type;

export const TodoState = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("ready"), phases: TodoPhases }),
  Schema.Struct({ kind: Schema.Literal("unavailable") }),
]);
export type TodoState = typeof TodoState.Type;

export const TranscriptSnapshot = Schema.Struct({
  messages: AgentTranscript,
  todo: TodoState,
  contextUsage: Schema.Union([ContextUsage, Schema.Struct({ kind: Schema.Literal("error") })]),
});
export type TranscriptSnapshot = typeof TranscriptSnapshot.Type;
export interface CapturedAgentRun {
  readonly runId: ScheduleRunId;
  readonly outcome: "completed" | "failed" | "aborted";
  readonly events: ReadonlyArray<AgentEventEnvelope["event"]>;
  readonly finalAssistantText: string;
}

export type MessageDelivery<E = AgentError> =
  | { readonly kind: "started"; readonly completed: Effect.Effect<void, E> }
  | {
      readonly kind: "steered";
      readonly consumed: Effect.Effect<"consumed" | "discarded">;
      readonly completed: Effect.Effect<void, E>;
    }
  | { readonly kind: "handled" };

export class AgentRuntime extends Context.Service<
  AgentRuntime,
  {
    readonly events: Stream.Stream<AgentEventEnvelope>;
    readonly drain: () => Effect.Effect<void>;

    /** Application reads persisted chat snapshots without initializing an absent session. */
    readonly transcript: (chatId: ChatId) => Effect.Effect<TranscriptSnapshot, AgentError>;

    readonly send: (
      chatId: ChatId,
      prompt: AgentPrompt,
    ) => Effect.Effect<MessageDelivery, AgentError>;
    /** Application calls this for a side question without changing the main conversation. */
    readonly askBtw: (chatId: ChatId, question: string) => Effect.Effect<string, AgentError>;
    readonly sendCaptured: (
      chatId: ChatId,
      runId: ScheduleRunId,
      prompt: AgentPrompt,
      onEvent: (event: AgentEventEnvelope["event"]) => Effect.Effect<void, AgentError>,
    ) => Effect.Effect<CapturedAgentRun, AgentError>;
    readonly deliver: (
      chatId: ChatId,
      message: AgentAssistantMessage,
      localOnly?: true,
    ) => Effect.Effect<void, AgentError>;

    readonly publish: (
      chatId: ChatId,
      content: string,
      localOnly?: true,
    ) => Effect.Effect<void, AgentError>;

    readonly close: (chatId: ChatId) => Effect.Effect<void, AgentError>;

    readonly abort: (chatId: ChatId) => Effect.Effect<void, AgentError>;

    readonly contextUsage: (chatId: ChatId) => Effect.Effect<ContextUsage, AgentError>;

    /** Application calls this for model discovery without opening a session. */
    readonly availableModels: (
      cwd: AbsolutePath,
    ) => Effect.Effect<readonly ModelInfo[], AgentError>;

    /** Application calls this to switch one chat and report whether persistence was confirmed. */
    readonly switchModel: (
      chatId: ChatId,
      model: ModelRef,
    ) => Effect.Effect<ModelSwitchResult, AgentError>;

    readonly shake: (chatId: ChatId, mode: ShakeMode) => Effect.Effect<ShakeResult, AgentError>;
  }
>()("@pico/contract/agent/AgentRuntime") {}
