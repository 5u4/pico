import * as Schema from "effect/Schema";
import { Publication } from "./agent-event.ts";
import { ChatId } from "./chat-model.ts";

export const HistoryEntryId = Schema.NonEmptyString.pipe(Schema.brand("HistoryEntryId"));
export type HistoryEntryId = typeof HistoryEntryId.Type;

export const HistoryVersion = Schema.NonEmptyString.pipe(Schema.brand("HistoryVersion"));
export type HistoryVersion = typeof HistoryVersion.Type;

export const HistoryRevision = Schema.NonEmptyString.pipe(Schema.brand("HistoryRevision"));
export type HistoryRevision = typeof HistoryRevision.Type;

export const HistoryNode = Schema.Struct({
  entryId: HistoryEntryId,
  parentId: Schema.NullOr(HistoryEntryId),
  defaultTargetId: HistoryEntryId,
  kind: Schema.Literals(["user", "assistant", "tool", "summary", "metadata"]),
  timestamp: Schema.String,
  label: Schema.NullOr(Schema.String),
  excerpt: Schema.String,
  visibleByDefault: Schema.Boolean,
});
export type HistoryNode = typeof HistoryNode.Type;

export const HistorySnapshot = Schema.Struct({
  nodes: Schema.Array(HistoryNode),
  activeLeafId: Schema.NullOr(HistoryEntryId),
  revision: HistoryRevision,
  version: HistoryVersion,
  publication: Publication,
  matches: Schema.Array(HistoryEntryId),
  canContinue: Schema.Boolean,
});
export type HistorySnapshot = typeof HistorySnapshot.Type;

export const HistoryPreviewBlock = Schema.Struct({
  label: Schema.String,
  text: Schema.String,
});
export type HistoryPreviewBlock = typeof HistoryPreviewBlock.Type;

export const HistoryPreview = Schema.Struct({
  targetId: HistoryEntryId,
  version: HistoryVersion,
  destinationLeafId: Schema.NullOr(HistoryEntryId),
  blocks: Schema.Array(HistoryPreviewBlock),
});
export type HistoryPreview = typeof HistoryPreview.Type;

export const NavigateHistoryConflictReason = Schema.Literals([
  "version-mismatch",
  "busy",
  "target-missing",
]);
export type NavigateHistoryConflictReason = typeof NavigateHistoryConflictReason.Type;

export const ChatHistoryRequest = Schema.Struct({
  chatId: ChatId,
  query: Schema.String,
});
export type ChatHistoryRequest = typeof ChatHistoryRequest.Type;

export const PreviewChatHistoryRequest = Schema.Struct({
  chatId: ChatId,
  targetId: HistoryEntryId,
});
export type PreviewChatHistoryRequest = typeof PreviewChatHistoryRequest.Type;

export const NavigateChatHistoryRequest = Schema.Struct({
  chatId: ChatId,
  targetId: HistoryEntryId,
  expectedVersion: HistoryVersion,
});
export type NavigateChatHistoryRequest = typeof NavigateChatHistoryRequest.Type;
