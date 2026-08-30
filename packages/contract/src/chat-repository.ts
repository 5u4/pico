import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";
import type { Chat, ChatId, NewRegularChat, NewWorktreeChat } from "./chat-model.ts";
import type { PersistenceError } from "./errors.ts";

export class ChatRepository extends Context.Service<
  ChatRepository,
  {
    readonly createRegular: (chat: NewRegularChat) => Effect.Effect<Chat, PersistenceError>;

    readonly createWorktree: (chat: NewWorktreeChat) => Effect.Effect<Chat, PersistenceError>;

    readonly findById: (id: ChatId) => Effect.Effect<Option.Option<Chat>, PersistenceError>;
  }
>()("@pico/contract/chat/ChatRepository") {}
