import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type { SessionJournal } from "./bot-session.ts";
import type { ChatId } from "./chat-model.ts";
import type { AgentError } from "./errors.ts";
import type { AbsolutePath } from "./path.ts";

export interface CreateAgentSession {
  readonly chatId: ChatId;
  readonly cwd: AbsolutePath;
}

export class AgentSessionStore extends Context.Service<
  AgentSessionStore,
  {
    readonly create: (input: CreateAgentSession) => Effect.Effect<void, AgentError>;
    // Application calls this when chat persistence fails after session creation.
    readonly remove: (chatId: ChatId) => Effect.Effect<void, AgentError>;
    // Application provisions a fresh bot journal before committing its active pointer.
    readonly createPhysical: (
      botRoot: AbsolutePath,
      cwd: AbsolutePath,
    ) => Effect.Effect<SessionJournal, AgentError>;
    // Application removes an unpublished journal when rotation fails.
    readonly removePhysical: (journal: SessionJournal) => Effect.Effect<void, AgentError>;
  }
>()("@pico/contract/agent/AgentSessionStore") {}
