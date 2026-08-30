import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { AbsolutePath, type AbsolutePath as AbsolutePathType } from "./config/path.ts";
import type { PersistenceError } from "./persistence/error.ts";

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

export class WorkspaceRepository extends Context.Service<
  WorkspaceRepository,
  {
    readonly create: (workspace: Workspace) => Effect.Effect<Workspace, PersistenceError>;

    readonly findById: (
      id: WorkspaceId,
    ) => Effect.Effect<Option.Option<Workspace>, PersistenceError>;

    readonly changeDefaultCwd: (
      id: WorkspaceId,
      cwd: AbsolutePathType,
    ) => Effect.Effect<Workspace, PersistenceError>;
  }
>()("@pico/contract/workspace/WorkspaceRepository") {}
