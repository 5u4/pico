import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { AgentPrompt, AgentTranscript } from "./agent-message.ts";
import type { Chat, ChatId } from "./chat-model.ts";
import type { ApplicationError, WorkspaceCwdInvalid } from "./errors.ts";
import { AbsolutePath } from "./path.ts";
import {
  type Workspace,
  WorkspaceBinding,
  WorkspaceId,
  type WorkspacePlatform,
  WorktreeSettings,
} from "./workspace-model.ts";

export const CreateWorkspace = Schema.Struct({
  name: Schema.NonEmptyString,
  binding: Schema.NullOr(WorkspaceBinding),
  defaultCwd: AbsolutePath,
  worktree: Schema.NullOr(WorktreeSettings),
});
export type CreateWorkspace = typeof CreateWorkspace.Type;

export const BindWorkspace = Schema.Struct({
  binding: WorkspaceBinding,
  workspaceName: Schema.NonEmptyString,
  cwd: Schema.String,
});
export type BindWorkspace = typeof BindWorkspace.Type;

export const CreateChat = Schema.Struct({
  workspaceId: WorkspaceId,
  externalId: Schema.NullOr(Schema.NonEmptyString),
});
export type CreateChat = typeof CreateChat.Type;

export class Application extends Context.Service<
  Application,
  {
    readonly createWorkspace: (
      input: CreateWorkspace,
    ) => Effect.Effect<Workspace, ApplicationError>;

    readonly bindWorkspace: (
      input: BindWorkspace,
    ) => Effect.Effect<Workspace, ApplicationError | WorkspaceCwdInvalid>;

    readonly createChat: (input: CreateChat) => Effect.Effect<Chat, ApplicationError>;

    readonly findWorkspaceByPlatformId: (
      platform: WorkspacePlatform,
      workspaceExternalId: string,
    ) => Effect.Effect<Option.Option<Workspace>, ApplicationError>;

    readonly findChatByPlatformId: (
      platform: WorkspacePlatform,
      workspaceExternalId: string,
      chatExternalId: string,
    ) => Effect.Effect<Option.Option<Chat>, ApplicationError>;

    readonly transcript: (chatId: ChatId) => Effect.Effect<AgentTranscript, ApplicationError>;

    readonly sendMessage: (
      chatId: ChatId,
      prompt: AgentPrompt,
    ) => Effect.Effect<void, ApplicationError>;

    readonly abort: (chatId: ChatId) => Effect.Effect<void, ApplicationError>;
  }
>()("@pico/contract/application/Application") {}
