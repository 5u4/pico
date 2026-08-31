import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { Chat } from "./chat-model.ts";
import type { ApplicationError } from "./errors.ts";
import { AbsolutePath } from "./path.ts";
import {
  type Workspace,
  WorkspaceBinding,
  WorkspaceId,
  WorktreeSettings,
} from "./workspace-model.ts";

export const CreateWorkspace = Schema.Struct({
  name: Schema.NonEmptyString,
  binding: Schema.NullOr(WorkspaceBinding),
  defaultCwd: AbsolutePath,
  worktree: Schema.NullOr(WorktreeSettings),
});
export type CreateWorkspace = typeof CreateWorkspace.Type;

export const CreateRegularChat = Schema.Struct({
  workspaceId: WorkspaceId,
  externalId: Schema.NullOr(Schema.NonEmptyString),
});
export type CreateRegularChat = typeof CreateRegularChat.Type;

export class Application extends Context.Service<
  Application,
  {
    readonly createWorkspace: (
      input: CreateWorkspace,
    ) => Effect.Effect<Workspace, ApplicationError>;

    readonly createRegularChat: (input: CreateRegularChat) => Effect.Effect<Chat, ApplicationError>;
  }
>()("@pico/contract/application/Application") {}
