import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { AgentEvent } from "./agent-event.ts";
import type { AgentPrompt, AgentTranscript } from "./agent-message.ts";
import type {
  ContextUsage,
  MessageDelivery,
  ModelInfo,
  ModelRef,
  ModelTarget,
  ShakeMode,
  ShakeResult,
} from "./agent-runtime.ts";
import type { BotDescriptor } from "./bot-session.ts";
import type { Chat, ChatId } from "./chat-model.ts";
import type {
  AgentError,
  ApplicationError,
  ChatClosed,
  GitError,
  WorkspaceBindingInvalid,
} from "./errors.ts";
import { AbsolutePath } from "./path.ts";
import type { ReplyTarget } from "./reply-target.ts";
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

export const WorkspaceBindingConfiguration = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("direct"), cwd: Schema.String }),
  Schema.Struct({
    kind: Schema.Literal("worktree"),
    repository: Schema.String,
    settings: WorktreeSettings,
  }),
]);
export type WorkspaceBindingConfiguration = typeof WorkspaceBindingConfiguration.Type;

export const BindWorkspace = Schema.Struct({
  binding: WorkspaceBinding,
  workspaceName: Schema.NonEmptyString,
  configuration: WorkspaceBindingConfiguration,
});
export type BindWorkspace = typeof BindWorkspace.Type;

export const CreateChat = Schema.Struct({
  workspaceId: WorkspaceId,
  externalId: Schema.NullOr(Schema.NonEmptyString),
});
export type CreateChat = typeof CreateChat.Type;

export type ChatPlatformBinding = Pick<typeof WorkspaceBinding.Type, "platform" | "externalId">;

export interface CloseChatOptions {
  readonly allowDirtyWorktree: boolean;
}

export type CloseChatResult =
  | { readonly kind: "closed" }
  | { readonly kind: "worktree-confirmation-required" };

export class Application extends Context.Service<
  Application,
  {
    /** Web clients call this when opening or refreshing the workspace picker. */
    readonly listWorkspaces: () => Effect.Effect<readonly Workspace[], ApplicationError>;

    readonly createWorkspace: (
      input: CreateWorkspace,
    ) => Effect.Effect<Workspace, ApplicationError>;

    /** Platform adapters call this to observe binding metadata without replacing existing configuration. */
    readonly getOrCreateWorkspaceByBinding: (
      input: Omit<CreateWorkspace, "binding"> & { readonly binding: WorkspaceBinding },
    ) => Effect.Effect<Workspace, ApplicationError>;

    readonly bindWorkspace: (
      input: BindWorkspace,
    ) => Effect.Effect<Workspace, ApplicationError | GitError | WorkspaceBindingInvalid>;

    /** Web clients call this when selecting or refreshing a workspace. */
    readonly listChats: (
      workspaceId: WorkspaceId,
    ) => Effect.Effect<readonly Chat[], ApplicationError>;

    readonly createChat: (input: CreateChat) => Effect.Effect<Chat, ApplicationError>;
    // Platform adapters resolve the single shared conversation before accepting bot input.
    readonly getOrCreateBotChat: (bot: BotDescriptor) => Effect.Effect<Chat, ApplicationError>;

    // Platform adapters capture output for the triggering message, never a chat-wide destination.
    readonly sendBotMessage: (
      chatId: ChatId,
      prompt: AgentPrompt,
      onEvent: (event: AgentEvent) => Effect.Effect<void, AgentError>,
      replyTarget?: ReplyTarget,
    ) => Effect.Effect<void, ApplicationError | ChatClosed>;

    readonly findWorkspaceByPlatformId: (
      platform: WorkspacePlatform,
      workspaceExternalId: string,
    ) => Effect.Effect<Option.Option<Workspace>, ApplicationError>;

    readonly findChatByPlatformId: (
      platform: WorkspacePlatform,
      workspaceExternalId: string,
      chatExternalId: string,
    ) => Effect.Effect<Option.Option<Chat>, ApplicationError>;

    /** Platform adapters call this when delivering output for a persisted chat. */
    readonly findChatPlatformBinding: (
      chatId: ChatId,
    ) => Effect.Effect<Option.Option<ChatPlatformBinding>, ApplicationError>;

    readonly transcript: (chatId: ChatId) => Effect.Effect<AgentTranscript, ApplicationError>;

    readonly closeChat: (
      chatId: ChatId,
      options: CloseChatOptions,
    ) => Effect.Effect<CloseChatResult, ApplicationError>;

    readonly sendMessage: (
      chatId: ChatId,
      prompt: AgentPrompt,
    ) => Effect.Effect<MessageDelivery<ApplicationError>, ApplicationError | ChatClosed>;

    /** Platform adapters call this for a side question in an existing open chat. */
    readonly askBtw: (
      chatId: ChatId,
      question: string,
    ) => Effect.Effect<string, ApplicationError | ChatClosed>;

    readonly abort: (chatId: ChatId) => Effect.Effect<void, ApplicationError>;

    readonly contextUsage: (
      chatId: ChatId,
    ) => Effect.Effect<ContextUsage, ApplicationError | ChatClosed>;

    /** Platform adapters call this while displaying the model picker, before a chat may exist. */
    readonly availableModels: (
      target: ModelTarget,
    ) => Effect.Effect<readonly ModelInfo[], ApplicationError | ChatClosed>;

    /** Platform adapters call this after selecting a model for the current open chat. */
    readonly switchModel: (
      chatId: ChatId,
      model: ModelRef,
    ) => Effect.Effect<ModelInfo, ApplicationError | ChatClosed>;

    readonly shake: (
      chatId: ChatId,
      mode: ShakeMode,
    ) => Effect.Effect<ShakeResult, ApplicationError | ChatClosed>;
  }
>()("@pico/contract/application/Application") {}
