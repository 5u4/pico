import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";
import type { PersistenceError } from "./errors.ts";
import type {
  Workspace,
  WorkspaceBinding,
  WorkspaceConfiguration,
  WorkspaceId,
} from "./workspace-model.ts";

export class WorkspaceRepository extends Context.Service<
  WorkspaceRepository,
  {
    /** Application calls this when listing the root's workspaces. */
    readonly list: () => Effect.Effect<readonly Workspace[], PersistenceError>;

    readonly create: (workspace: Workspace) => Effect.Effect<Workspace, PersistenceError>;

    /** Application calls this to merge observed binding metadata while preserving existing configuration. */
    readonly getOrCreateByBinding: (
      workspace: Omit<Workspace, "binding"> & { readonly binding: WorkspaceBinding },
    ) => Effect.Effect<Workspace, PersistenceError>;

    readonly findById: (
      id: WorkspaceId,
    ) => Effect.Effect<Option.Option<Workspace>, PersistenceError>;

    readonly findByBinding: (
      binding: WorkspaceBinding,
    ) => Effect.Effect<Option.Option<Workspace>, PersistenceError>;

    readonly replaceConfiguration: (
      id: WorkspaceId,
      configuration: WorkspaceConfiguration,
    ) => Effect.Effect<Workspace, PersistenceError>;
  }
>()("@pico/contract/workspace/WorkspaceRepository") {}
