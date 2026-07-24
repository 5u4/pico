import { Schema } from "effect";
import { WireMessage } from "./entities.ts";

export const CreateSpaceRequest = Schema.Struct({
  name: Schema.String,
  cwd: Schema.optional(Schema.String),
});
export type CreateSpaceRequest = typeof CreateSpaceRequest.Type;

export const UpdateSpaceCwdRequest = Schema.Struct({
  cwd: Schema.String,
});
export type UpdateSpaceCwdRequest = typeof UpdateSpaceCwdRequest.Type;

export const CreateChatRequest = Schema.Struct({
  title: Schema.String,
});
export type CreateChatRequest = typeof CreateChatRequest.Type;

export const PromptRequest = Schema.Struct({
  text: Schema.String,
});
export type PromptRequest = typeof PromptRequest.Type;

export const PromptAccepted = Schema.TaggedStruct("Started", {});
export type PromptAccepted = typeof PromptAccepted.Type;

export const HistoryQuery = Schema.Struct({
  before: Schema.optional(Schema.NumberFromString),
  limit: Schema.optional(Schema.NumberFromString),
});
export type HistoryQuery = typeof HistoryQuery.Type;

export const HistoryPage = Schema.Struct({
  messages: Schema.Array(WireMessage),
  hasMore: Schema.Boolean,
  nextCursor: Schema.NullOr(Schema.Number),
});
export type HistoryPage = typeof HistoryPage.Type;
