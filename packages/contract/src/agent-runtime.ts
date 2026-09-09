import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";
import type { AgentEventEnvelope } from "./agent-event.ts";
import type { AgentPrompt, AgentTranscript } from "./agent-message.ts";
import type { ChatId } from "./chat-model.ts";
import type { AgentError } from "./errors.ts";

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

export class AgentRuntime extends Context.Service<
  AgentRuntime,
  {
    readonly events: Stream.Stream<AgentEventEnvelope>;

    readonly transcript: (chatId: ChatId) => Effect.Effect<AgentTranscript, AgentError>;

    readonly send: (chatId: ChatId, prompt: AgentPrompt) => Effect.Effect<void, AgentError>;

    readonly abort: (chatId: ChatId) => Effect.Effect<void, AgentError>;

    readonly contextUsage: (chatId: ChatId) => Effect.Effect<ContextUsage, AgentError>;

    readonly shake: (chatId: ChatId, mode: ShakeMode) => Effect.Effect<ShakeResult, AgentError>;
  }
>()("@pico/contract/agent/AgentRuntime") {}
