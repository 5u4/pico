import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
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
  }
>()("@pico/contract/agent/AgentSessionStore") {}
