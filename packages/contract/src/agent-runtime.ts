import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";
import type { AgentEventEnvelope } from "./agent-event.ts";
import type { AgentPrompt, AgentTranscript } from "./agent-message.ts";
import type { BotDescriptor } from "./bot-session.ts";
import type { ChatId } from "./chat-model.ts";
import type { AgentError } from "./errors.ts";
import type { ReplyTarget } from "./reply-target.ts";
import type { ScheduleRunId } from "./schedule.ts";

export interface ModelRef {
  readonly provider: string;
  readonly id: string;
}

export interface ModelInfo extends ModelRef {
  readonly name: string;
}

export interface ModelSwitchResult {
  readonly kind: "persisted" | "persistence-unconfirmed";
  readonly model: ModelInfo;
}

export type ModelTarget =
  | { readonly kind: "chat"; readonly chatId: ChatId }
  | { readonly kind: "bot"; readonly bot: BotDescriptor };

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

export type AgentTurnResult = Omit<CapturedAgentRun, "runId">;

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
    /** Application calls this for a side question without changing the main conversation. */
    readonly askBtw: (chatId: ChatId, question: string) => Effect.Effect<string, AgentError>;
    readonly sendCaptured: (
      chatId: ChatId,
      runId: ScheduleRunId,
      prompt: AgentPrompt,
      onEvent: (event: AgentEventEnvelope["event"]) => Effect.Effect<void, AgentError>,
      replyTarget?: ReplyTarget,
    ) => Effect.Effect<CapturedAgentRun, AgentError>;
    // Application captures a whole bot turn for its operation-local reply destination.
    readonly sendTurn: (
      chatId: ChatId,
      prompt: AgentPrompt,
      onEvent: (event: AgentEventEnvelope["event"]) => Effect.Effect<void, AgentError>,
      replyTarget?: ReplyTarget,
    ) => Effect.Effect<AgentTurnResult, AgentError>;
    // Application rotates only while the pool owns an idle, completed physical session.
    readonly rotate: (
      chatId: ChatId,
      commit: (handoff: string) => Effect.Effect<void, AgentError>,
    ) => Effect.Effect<void, AgentError>;
    readonly deliver: (chatId: ChatId, content: string) => Effect.Effect<void, AgentError>;

    readonly publish: (chatId: ChatId, content: string) => Effect.Effect<void, AgentError>;

    readonly close: (chatId: ChatId) => Effect.Effect<void, AgentError>;

    readonly abort: (chatId: ChatId) => Effect.Effect<void, AgentError>;

    readonly contextUsage: (chatId: ChatId) => Effect.Effect<ContextUsage, AgentError>;

    /** Application calls this for model discovery without opening a session. */
    readonly availableModels: (
      target: ModelTarget,
    ) => Effect.Effect<readonly ModelInfo[], AgentError>;

    /** Application calls this to switch one chat and report whether persistence was confirmed. */
    readonly switchModel: (
      chatId: ChatId,
      model: ModelRef,
    ) => Effect.Effect<ModelSwitchResult, AgentError>;

    readonly shake: (chatId: ChatId, mode: ShakeMode) => Effect.Effect<ShakeResult, AgentError>;
  }
>()("@pico/contract/agent/AgentRuntime") {}
