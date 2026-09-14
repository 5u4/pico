import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type { Chat, ChatId } from "./chat-model.ts";
import type { AgentError } from "./errors.ts";
import type { WorkspacePlatform } from "./workspace-model.ts";

export interface ResolvedChatSessionContext {
  readonly chat: Chat;
  readonly platform: WorkspacePlatform;
  readonly appendSystemPrompt: string;
}

export class ChatSessionContext extends Context.Service<
  ChatSessionContext,
  {
    // OMP calls this once when opening a live chat session.
    readonly resolve: (chatId: ChatId) => Effect.Effect<ResolvedChatSessionContext, AgentError>;
  }
>()("@pico/contract/chat-session-context/ChatSessionContext") {}
