import * as Schema from "effect/Schema";
import { AbsolutePath } from "./path.ts";

export const WorkspaceId = Schema.String.check(Schema.isUUID(7)).pipe(
  Schema.brand("@pico/contract/WorkspaceId"),
);
export type WorkspaceId = typeof WorkspaceId.Type;

export const WorkspacePlatform = Schema.Literals(["discord"]);
export type WorkspacePlatform = typeof WorkspacePlatform.Type;

export const WorkspaceBinding = Schema.Struct({
  platform: WorkspacePlatform,
  externalId: Schema.NonEmptyString,
});
export type WorkspaceBinding = typeof WorkspaceBinding.Type;

export const WorktreeSettings = Schema.Struct({
  branch: Schema.NonEmptyString,
  prefix: Schema.NonEmptyString,
});
export type WorktreeSettings = typeof WorktreeSettings.Type;

export const Workspace = Schema.Struct({
  id: WorkspaceId,
  name: Schema.NonEmptyString,
  binding: Schema.NullOr(WorkspaceBinding),
  defaultCwd: AbsolutePath,
  worktree: Schema.NullOr(WorktreeSettings),
  createdAt: Schema.Natural,
});
export type Workspace = typeof Workspace.Type;
