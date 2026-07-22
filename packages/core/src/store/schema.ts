import { Schema } from "effect";

export const Platform = Schema.Literal("web", "discord");
export type Platform = typeof Platform.Type;

export const Space = Schema.Struct({
  id: Schema.String,
  defaultCwd: Schema.String,
  platform: Platform,
  name: Schema.String,
  externalId: Schema.OptionFromNullOr(Schema.String),
  checkoutBranch: Schema.OptionFromNullOr(Schema.String),
  branchPrefix: Schema.OptionFromNullOr(Schema.String),
  createdAt: Schema.DateFromNumber,
});
export type Space = typeof Space.Type;

export const Chat = Schema.Struct({
  id: Schema.String,
  spaceId: Schema.String,
  cwd: Schema.String,
  title: Schema.String,
  externalId: Schema.OptionFromNullOr(Schema.String),
  createdAt: Schema.DateFromNumber,
  archivedAt: Schema.OptionFromNullOr(Schema.DateFromNumber),
});
export type Chat = typeof Chat.Type;
