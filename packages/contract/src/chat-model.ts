import * as Schema from "effect/Schema";
import { AgentMessageId } from "./agent-message.ts";
import { AbsolutePath } from "./path.ts";
import { WorkspaceId } from "./workspace-model.ts";

export const ChatId = Schema.String.check(Schema.isUUID(7)).pipe(
  Schema.brand("@pico/contract/ChatId"),
);
export type ChatId = typeof ChatId.Type;

export const ResultCursor = Schema.Struct({
  sessionId: Schema.NonEmptyString,
  entryId: Schema.NonEmptyString,
});
export type ResultCursor = typeof ResultCursor.Type;

export const ChatResultHead = Schema.Struct({
  cursor: ResultCursor,
  messageId: AgentMessageId,
});
export type ChatResultHead = typeof ChatResultHead.Type;

export const ChatResultSummary = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("ready"),
    latest: Schema.NullOr(ChatResultHead),
    relation: Schema.Literals(["none", "covered", "behind"]),
  }),
  Schema.Struct({
    kind: Schema.Literal("reset"),
    latest: Schema.NullOr(ChatResultHead),
  }),
  Schema.Struct({
    kind: Schema.Literal("unavailable"),
  }),
]);
export type ChatResultSummary = typeof ChatResultSummary.Type;

export const ChatResultsRequestEntry = Schema.Struct({
  chatId: ChatId,
  seen: Schema.NullOr(ResultCursor),
  seenRevision: Schema.Natural,
});
export type ChatResultsRequestEntry = typeof ChatResultsRequestEntry.Type;

export const ChatResultsRequest = Schema.Struct({
  chats: Schema.Array(ChatResultsRequestEntry),
  includeAllOpenChats: Schema.optional(Schema.Boolean),
});
export type ChatResultsRequest = typeof ChatResultsRequest.Type;

export const ChatResultSummaryEntry = Schema.Struct({
  chatId: ChatId,
  seenRevision: Schema.Natural,
  summary: ChatResultSummary,
});
export type ChatResultSummaryEntry = typeof ChatResultSummaryEntry.Type;

export const ChatResultsResponse = Schema.Array(ChatResultSummaryEntry);
export type ChatResultsResponse = typeof ChatResultsResponse.Type;

export const Chat = Schema.Struct({
  id: ChatId,
  workspaceId: WorkspaceId,
  cwd: AbsolutePath,
  externalId: Schema.NullOr(Schema.NonEmptyString),
  createdAt: Schema.Natural,
  archivedAt: Schema.NullOr(Schema.Natural),
});
export type Chat = typeof Chat.Type;

export const ChatListEntry = Schema.Struct({
  ...Chat.fields,
  title: Schema.NullOr(Schema.NonEmptyString),
});
export type ChatListEntry = typeof ChatListEntry.Type;

export const NewChat = Schema.Struct({
  id: ChatId,
  workspaceId: WorkspaceId,
  cwd: AbsolutePath,
  externalId: Schema.NullOr(Schema.NonEmptyString),
  createdAt: Schema.Natural,
});
export type NewChat = typeof NewChat.Type;
