import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type { ModelRef } from "./agent-runtime.ts";
import type { ChatId } from "./chat-model.ts";
import type { AgentError } from "./errors.ts";
import type { AbsolutePath } from "./path.ts";

export interface CreateAgentSession {
  readonly chatId: ChatId;
  readonly cwd: AbsolutePath;
  readonly modelOverride: ModelRef | null;
}

export class AgentSessionStore extends Context.Service<
  AgentSessionStore,
  {
    // Application calls this before inserting a new chat.
    readonly create: (input: CreateAgentSession) => Effect.Effect<void, AgentError>;
    // Application calls this when listing chats without opening live sessions.
    readonly readTitle: (chatId: ChatId) => Effect.Effect<string | null, AgentError>;
    // Application calls this when chat persistence fails after session creation.
    readonly remove: (chatId: ChatId) => Effect.Effect<void, AgentError>;
  }
>()("@pico/contract/agent/AgentSessionStore") {}
