import { Schema } from "effect";

export const WireBadRequest = Schema.TaggedStruct("BadRequest", {
  message: Schema.String,
});

export const WireSpaceNotFound = Schema.TaggedStruct("SpaceNotFound", {
  message: Schema.String,
  spaceId: Schema.String,
});

export const WireChatNotFound = Schema.TaggedStruct("ChatNotFound", {
  message: Schema.String,
  chatId: Schema.String,
});

export const WireInvalidSpaceName = Schema.TaggedStruct("InvalidSpaceName", {
  message: Schema.String,
});

export const WireInvalidChatTitle = Schema.TaggedStruct("InvalidChatTitle", {
  message: Schema.String,
});

export const WireInvalidChatId = Schema.TaggedStruct("InvalidChatId", {
  message: Schema.String,
  chatId: Schema.String,
});

export const WireInvalidCwd = Schema.TaggedStruct("InvalidCwd", {
  message: Schema.String,
  path: Schema.String,
});

export const WireCwdNotFound = Schema.TaggedStruct("CwdNotFound", {
  message: Schema.String,
  path: Schema.String,
});

export const WireNotADirectory = Schema.TaggedStruct("NotADirectory", {
  message: Schema.String,
  path: Schema.String,
});

export const WireSpaceHasActiveChats = Schema.TaggedStruct(
  "SpaceHasActiveChats",
  {
    message: Schema.String,
    spaceId: Schema.String,
  },
);

export const WireChatBusy = Schema.TaggedStruct("ChatBusy", {
  message: Schema.String,
  chatId: Schema.String,
});

export const WireModelUnavailable = Schema.TaggedStruct("ModelUnavailable", {
  message: Schema.String,
  detail: Schema.String,
});

export const WireSessionInitFailed = Schema.TaggedStruct("SessionInitFailed", {
  message: Schema.String,
  chatId: Schema.String,
});

export const WireDbError = Schema.TaggedStruct("DbError", {
  message: Schema.String,
});

export const WireError = Schema.Union(
  WireBadRequest,
  WireSpaceNotFound,
  WireChatNotFound,
  WireInvalidSpaceName,
  WireInvalidChatTitle,
  WireInvalidChatId,
  WireInvalidCwd,
  WireCwdNotFound,
  WireNotADirectory,
  WireSpaceHasActiveChats,
  WireChatBusy,
  WireModelUnavailable,
  WireSessionInitFailed,
  WireDbError,
);
export type WireError = typeof WireError.Type;
