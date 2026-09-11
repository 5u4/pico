import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type { Chat, ChatId } from "./chat-model.ts";
import type { AgentError } from "./errors.ts";
import type { WorkspacePlatform } from "./workspace-model.ts";

export interface ResolvedChatPlatform {
  readonly chat: Chat;
  readonly platform: WorkspacePlatform | null;
}

export class ChatPlatformResolver extends Context.Service<
  ChatPlatformResolver,
  {
    // OMP calls this once when opening a live chat session.
    readonly resolve: (chatId: ChatId) => Effect.Effect<ResolvedChatPlatform, AgentError>;
  }
>()("@pico/contract/chat-platform/ChatPlatformResolver") {}
