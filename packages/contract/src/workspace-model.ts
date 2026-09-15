import * as Schema from "effect/Schema";
import { ModelRef } from "./agent-runtime.ts";
import { AbsolutePath } from "./path.ts";

export const WorkspaceId = Schema.String.check(Schema.isUUID(7)).pipe(
  Schema.brand("@pico/contract/WorkspaceId"),
);
export type WorkspaceId = typeof WorkspaceId.Type;

export const WorkspacePlatform = Schema.Literals([
  "web",
  "desktop",
  "mobile",
  "discord",
  "telegram",
  "slack",
  "teams",
]);
export type WorkspacePlatform = typeof WorkspacePlatform.Type;

const DiscordSnowflake = Schema.String.check(Schema.isPattern(/^[0-9]+$/), Schema.isTrimmed());

export const DiscordWorkspaceExternalId = Schema.TemplateLiteralParser([
  DiscordSnowflake,
  ".",
  DiscordSnowflake,
]);

export const WorkspaceBinding = Schema.Struct({
  platform: WorkspacePlatform.pick(["discord", "telegram", "slack", "teams"]),
  externalId: Schema.NonEmptyString,
});
export type WorkspaceBinding = typeof WorkspaceBinding.Type;

export const WorktreeSettings = Schema.Struct({
  branch: Schema.NonEmptyString,
  prefix: Schema.NonEmptyString,
});
export type WorktreeSettings = typeof WorktreeSettings.Type;

export const WorkspaceConfiguration = Schema.Struct({
  defaultCwd: AbsolutePath,
  worktree: Schema.NullOr(WorktreeSettings),
});
export type WorkspaceConfiguration = typeof WorkspaceConfiguration.Type;

const workspaceFields = {
  id: WorkspaceId,
  name: Schema.NonEmptyString,
  ...WorkspaceConfiguration.fields,
  modelOverride: Schema.NullOr(ModelRef),
  createdAt: Schema.Natural,
};

export const Workspace = Schema.Union([
  Schema.Struct({
    ...workspaceFields,
    platform: WorkspacePlatform.pick(["web", "desktop", "mobile"]),
    externalId: Schema.Null,
  }),
  Schema.Struct({
    ...workspaceFields,
    ...WorkspaceBinding.fields,
  }),
]);
export type Workspace = typeof Workspace.Type;
