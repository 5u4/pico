import { Schema } from "effect";

export const WirePlatform = Schema.Literal("web", "discord");
export type WirePlatform = typeof WirePlatform.Type;

export const WireRole = Schema.Literal("user", "assistant");
export type WireRole = typeof WireRole.Type;

export const WireMessage = Schema.Struct({
  role: WireRole,
  text: Schema.String,
});
export type WireMessage = typeof WireMessage.Type;

export const WireSpace = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  platform: WirePlatform,
  defaultCwd: Schema.String,
  externalId: Schema.NullOr(Schema.String),
  checkoutBranch: Schema.NullOr(Schema.String),
  branchPrefix: Schema.NullOr(Schema.String),
  createdAt: Schema.Number,
});
export type WireSpace = typeof WireSpace.Type;

export const WireChat = Schema.Struct({
  id: Schema.String,
  spaceId: Schema.String,
  cwd: Schema.String,
  title: Schema.String,
  externalId: Schema.NullOr(Schema.String),
  createdAt: Schema.Number,
  archivedAt: Schema.NullOr(Schema.Number),
});
export type WireChat = typeof WireChat.Type;
