import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";
import type { ModelRef } from "./agent-runtime.ts";
import type { ChatId } from "./chat-model.ts";
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

    /** Application calls this when resolving a platform binding that may already exist. */
    readonly getOrCreateByBinding: (
      workspace: Extract<Workspace, { readonly externalId: string }>,
    ) => Effect.Effect<Option.Option<Workspace>, PersistenceError>;

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

    /** Application calls this when a workspace model override is selected or cleared. */
    readonly setModelOverride: (
      id: WorkspaceId,
      model: ModelRef | null,
    ) => Effect.Effect<Workspace, PersistenceError>;

    /** Application calls this after inspecting open chats and locking schedule targets. */
    readonly softDelete: (input: {
      readonly id: WorkspaceId;
      readonly deletedAt: number;
      readonly checkedChatIds: readonly ChatId[];
    }) => Effect.Effect<readonly ChatId[] | "not-found" | "conflict", PersistenceError>;
  }
>()("@pico/contract/workspace/WorkspaceRepository") {}
