import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";
import type { AgentEventEnvelope } from "./agent-event.ts";
import type { AgentPrompt, AgentTranscript } from "./agent-message.ts";
import type { ChatId } from "./chat-model.ts";
import type { AgentError } from "./errors.ts";
import type { ScheduleRunId } from "./schedule.ts";

export type ShakeMode = "elide" | "images" | "thinking";

export type ShakeResult =
  | {
      readonly mode: "elide";
      readonly toolResultsDropped: number;
      readonly blocksDropped: number;
      readonly tokensFreed: number;
    }
  | {
      readonly mode: "images";
      readonly imagesDropped: number;
      readonly tokensFreed: number;
    }
  | {
      readonly mode: "thinking";
      readonly thinkingBlocksDropped: number;
      readonly tokensFreed: number;
    };

export type ContextUsage =
  | { readonly kind: "unavailable" }
  | {
      readonly kind: "available";
      readonly contextWindow: number;
      readonly usedTokens: number;
      readonly systemPromptTokens: number;
      readonly systemToolsTokens: number;
      readonly systemContextTokens: number;
      readonly skillsTokens: number;
      readonly messagesTokens: number;
    };
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

    readonly transcript: (chatId: ChatId) => Effect.Effect<AgentTranscript, AgentError>;

    readonly send: (
      chatId: ChatId,
      prompt: AgentPrompt,
    ) => Effect.Effect<MessageDelivery, AgentError>;
    readonly sendCaptured: (
      chatId: ChatId,
      runId: ScheduleRunId,
      prompt: AgentPrompt,
      onEvent: (event: AgentEventEnvelope["event"]) => Effect.Effect<void, AgentError>,
    ) => Effect.Effect<CapturedAgentRun, AgentError>;
    readonly deliver: (chatId: ChatId, content: string) => Effect.Effect<void, AgentError>;

    readonly publish: (chatId: ChatId, content: string) => Effect.Effect<void, AgentError>;

    readonly close: (chatId: ChatId) => Effect.Effect<void, AgentError>;

    readonly abort: (chatId: ChatId) => Effect.Effect<void, AgentError>;

    readonly contextUsage: (chatId: ChatId) => Effect.Effect<ContextUsage, AgentError>;

    readonly shake: (chatId: ChatId, mode: ShakeMode) => Effect.Effect<ShakeResult, AgentError>;
  }
>()("@pico/contract/agent/AgentRuntime") {}
