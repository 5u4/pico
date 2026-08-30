import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { AbsolutePath } from "./config/path.ts";
import type { PersistenceError } from "./persistence/error.ts";
import { WorkspaceId } from "./workspace.ts";

export const ChatId = Schema.String.check(Schema.isUUID(7)).pipe(
  Schema.brand("@pico/contract/ChatId"),
);
export type ChatId = typeof ChatId.Type;

export const Chat = Schema.Struct({
  id: ChatId,
  workspaceId: WorkspaceId,
  cwd: AbsolutePath,
  externalId: Schema.NullOr(Schema.NonEmptyString),
  createdAt: Schema.Natural,
  archivedAt: Schema.NullOr(Schema.Natural),
});
export type Chat = typeof Chat.Type;

export const NewRegularChat = Schema.Struct({
  id: ChatId,
  workspaceId: WorkspaceId,
  externalId: Schema.NullOr(Schema.NonEmptyString),
  createdAt: Schema.Natural,
});
export type NewRegularChat = typeof NewRegularChat.Type;

export const NewWorktreeChat = Schema.Struct({
  id: ChatId,
  workspaceId: WorkspaceId,
  cwd: AbsolutePath,
  externalId: Schema.NullOr(Schema.NonEmptyString),
  createdAt: Schema.Natural,
});
export type NewWorktreeChat = typeof NewWorktreeChat.Type;

export class ChatRepository extends Context.Service<
  ChatRepository,
  {
    readonly createRegular: (chat: NewRegularChat) => Effect.Effect<Chat, PersistenceError>;

    readonly createWorktree: (chat: NewWorktreeChat) => Effect.Effect<Chat, PersistenceError>;

    readonly findById: (id: ChatId) => Effect.Effect<Option.Option<Chat>, PersistenceError>;
  }
>()("@pico/contract/chat/ChatRepository") {}
