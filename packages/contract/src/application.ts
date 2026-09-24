import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";
import type {
  ChatHistoryRequest,
  HistoryPreview,
  HistorySnapshot,
  NavigateChatHistoryRequest,
  PreviewChatHistoryRequest,
} from "./agent-history.ts";
import type { AgentPrompt } from "./agent-message.ts";
import type {
  ContextUsage,
  MessageDelivery,
  ModelInfo,
  ModelSwitchResult,
  ShakeMode,
  ShakeResult,
  SkillCommand,
} from "./agent-runtime.ts";
import { ModelRef } from "./agent-runtime.ts";
import type { NavigateHistoryResult, TranscriptSnapshot } from "./agent-snapshot.ts";
import type {
  Chat,
  ChatId,
  ChatListEntry,
  ChatResultsRequest,
  ChatResultsResponse,
} from "./chat-model.ts";
import type { ApplicationError, ChatClosed, GitError, WorkspaceBindingInvalid } from "./errors.ts";
import type { AbsolutePath } from "./path.ts";
import { Workspace, WorkspaceBinding, WorkspaceId, WorktreeSettings } from "./workspace-model.ts";

export const CreateWorkspace = Schema.Union([
  Workspace.members[0].mapFields(Struct.omit(["id", "createdAt", "modelOverride"])),
  Workspace.members[1].mapFields(Struct.omit(["id", "createdAt", "modelOverride"])),
]);
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

export const UpdateWorkspace = Schema.Struct({
  workspaceId: WorkspaceId,
  configuration: WorkspaceBindingConfiguration,
});
export type UpdateWorkspace = typeof UpdateWorkspace.Type;

export const BindWorkspace = Schema.Struct({
  binding: WorkspaceBinding,
  workspaceName: Schema.NonEmptyString,
  configuration: WorkspaceBindingConfiguration,
});
export type BindWorkspace = typeof BindWorkspace.Type;

export const CreateChat = Schema.Struct({
  workspaceId: WorkspaceId,
  externalId: Schema.NullOr(Schema.NonEmptyString),
  modelOverride: Schema.NullOr(ModelRef),
});
export type CreateChat = typeof CreateChat.Type;

export type ChatPlatformBinding = WorkspaceBinding;

export interface CloseChatOptions {
  readonly allowDirtyWorktree: boolean;
}

export const CloseChatResult = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("closed") }),
  Schema.Struct({ kind: Schema.Literal("worktree-confirmation-required") }),
]);
export type CloseChatResult = typeof CloseChatResult.Type;

export class Application extends Context.Service<
  Application,
  {
    /** Web clients call this when opening or refreshing the workspace picker. */
    readonly listWorkspaces: () => Effect.Effect<readonly Workspace[], ApplicationError>;

    readonly createWorkspace: (
      input: CreateWorkspace,
    ) => Effect.Effect<Workspace, ApplicationError>;

    /** Web clients call this when saving workspace settings. */
    readonly updateWorkspace: (
      input: UpdateWorkspace,
    ) => Effect.Effect<Workspace, ApplicationError | GitError | WorkspaceBindingInvalid>;

    /** Web clients call this after confirming workspace deletion. */
    readonly deleteWorkspace: (workspaceId: WorkspaceId) => Effect.Effect<void, ApplicationError>;

    /** Platform adapters call this when first resolving a channel's workspace. */
    readonly getOrCreateWorkspaceByBinding: (
      input: Extract<CreateWorkspace, { readonly externalId: string }>,
    ) => Effect.Effect<Workspace, ApplicationError>;

    readonly bindWorkspace: (
      input: BindWorkspace,
    ) => Effect.Effect<Workspace, ApplicationError | GitError | WorkspaceBindingInvalid>;

    /** Web and platform clients call this before showing a workspace or draft model picker. */
    readonly availableWorkspaceModels: (
      input:
        | {
            readonly kind: "binding";
            readonly binding: WorkspaceBinding;
            readonly defaultCwd: AbsolutePath;
          }
        | {
            readonly kind: "workspace";
            readonly workspaceId: WorkspaceId;
          },
    ) => Effect.Effect<readonly ModelInfo[], ApplicationError>;
    /** Web clients call this when opening draft skill completion before first send. */
    readonly availableWorkspaceSkills: (
      workspaceId: WorkspaceId,
    ) => Effect.Effect<readonly SkillCommand[], ApplicationError>;

    /** Platform adapters call this after resolving a workspace model selection. */
    readonly setWorkspaceModel: (
      workspaceId: WorkspaceId,
      model: ModelRef | null,
    ) => Effect.Effect<Workspace, ApplicationError>;

    /** Web clients call this when selecting or refreshing a workspace. */
    readonly listChats: (
      workspaceId: WorkspaceId,
    ) => Effect.Effect<readonly ChatListEntry[], ApplicationError>;

    /** Web clients call this to read durable unread summaries without hydrating transcripts. */
    readonly chatResults: (
      input: ChatResultsRequest,
    ) => Effect.Effect<ChatResultsResponse, ApplicationError>;
    readonly createChat: (input: CreateChat) => Effect.Effect<Chat, ApplicationError>;
    readonly findWorkspaceByPlatformId: (
      platform: WorkspaceBinding["platform"],
      workspaceExternalId: string,
    ) => Effect.Effect<Option.Option<Workspace>, ApplicationError>;

    readonly findChatByPlatformId: (
      platform: WorkspaceBinding["platform"],
      workspaceExternalId: string,
      chatExternalId: string,
    ) => Effect.Effect<Option.Option<Chat>, ApplicationError>;

    /** Platform adapters call this when delivering output for a persisted chat. */
    readonly findChatPlatformBinding: (
      chatId: ChatId,
    ) => Effect.Effect<Option.Option<ChatPlatformBinding>, ApplicationError>;

    /** Platform adapters read persisted chat snapshots and the retained session's context estimate. */
    readonly transcript: (chatId: ChatId) => Effect.Effect<TranscriptSnapshot, ApplicationError>;

    /** Web RPC handlers call this when the history panel opens or its search changes. */
    readonly history: (
      input: ChatHistoryRequest,
    ) => Effect.Effect<HistorySnapshot, ApplicationError | ChatClosed>;

    /** Web RPC handlers call this when a historical node is selected for preview. */
    readonly previewHistory: (
      input: PreviewChatHistoryRequest,
    ) => Effect.Effect<HistoryPreview, ApplicationError | ChatClosed>;

    /** Web RPC handlers call this after an explicit request to continue from a historical node. */
    readonly navigateHistory: (
      input: NavigateChatHistoryRequest,
    ) => Effect.Effect<NavigateHistoryResult, ApplicationError | ChatClosed>;
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

    /** Platform adapters call this while displaying the current chat's model picker. */
    readonly availableModels: (
      chatId: ChatId,
    ) => Effect.Effect<readonly ModelInfo[], ApplicationError | ChatClosed>;

    /** Platform adapters call this while displaying the current chat's skill command picker. */
    readonly availableSkills: (
      chatId: ChatId,
    ) => Effect.Effect<readonly SkillCommand[], ApplicationError | ChatClosed>;

    /** Platform adapters call this after selecting a model for the current open chat. */
    readonly switchModel: (
      chatId: ChatId,
      model: ModelRef,
    ) => Effect.Effect<ModelSwitchResult, ApplicationError | ChatClosed>;

    readonly shake: (
      chatId: ChatId,
      mode: ShakeMode,
    ) => Effect.Effect<ShakeResult, ApplicationError | ChatClosed>;
  }
>()("@pico/contract/application/Application") {}
