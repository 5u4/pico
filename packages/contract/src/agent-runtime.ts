import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";
import type { AgentEventEnvelope } from "./agent-event.ts";
import type { AgentPrompt, AgentTranscript } from "./agent-message.ts";
import type { ChatId } from "./chat-model.ts";
import type { AgentError } from "./errors.ts";

export class AgentRuntime extends Context.Service<
  AgentRuntime,
  {
    readonly events: Stream.Stream<AgentEventEnvelope>;

    readonly transcript: (chatId: ChatId) => Effect.Effect<AgentTranscript, AgentError>;

    readonly send: (chatId: ChatId, prompt: AgentPrompt) => Effect.Effect<void, AgentError>;

    readonly abort: (chatId: ChatId) => Effect.Effect<void, AgentError>;
  }
>()("@pico/contract/agent/AgentRuntime") {}
