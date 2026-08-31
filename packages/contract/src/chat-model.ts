import * as Schema from "effect/Schema";
import { AbsolutePath } from "./path.ts";
import { WorkspaceId } from "./workspace-model.ts";

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
  cwd: AbsolutePath,
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
