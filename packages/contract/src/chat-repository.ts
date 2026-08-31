import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";
import type { Chat, ChatId, NewChat } from "./chat-model.ts";
import type { PersistenceError } from "./errors.ts";

export class ChatRepository extends Context.Service<
  ChatRepository,
  {
    // Application calls this after it provisions the chat's external resources.
    readonly create: (chat: NewChat) => Effect.Effect<Chat, PersistenceError>;

    readonly findById: (id: ChatId) => Effect.Effect<Option.Option<Chat>, PersistenceError>;
  }
>()("@pico/contract/chat/ChatRepository") {}
