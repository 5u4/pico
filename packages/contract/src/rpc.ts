import * as Schema from "effect/Schema";
import * as Rpc from "effect/unstable/rpc/Rpc";
import * as RpcGroup from "effect/unstable/rpc/RpcGroup";
import * as AgentEvent from "./agent-event.ts";
import * as AgentMessage from "./agent-message.ts";
import {
  ContextUsage,
  ModelInfo,
  ModelRef,
  ModelSwitchResult,
  ShakeMode,
  ShakeResult,
} from "./agent-runtime.ts";
import { TranscriptSnapshot } from "./agent-snapshot.ts";
import * as Application from "./application.ts";
import * as Chat from "./chat-model.ts";
import * as Errors from "./errors.ts";
import * as Schedule from "./schedule.ts";
import * as Workspace from "./workspace-model.ts";

export const ScheduleOverviewResponse = Schema.Struct({
  observedAt: Schema.Natural,
  entries: Schema.Array(
    Schema.Struct({
      ...Schedule.ScheduleOverviewEntry.fields,
      owner: Schema.NullOr(
        Schema.Struct({
          id: Workspace.WorkspaceId,
          name: Workspace.Workspace.members[0].fields.name,
          platform: Workspace.WorkspacePlatform,
        }),
      ),
    }),
  ),
});
export type ScheduleOverviewResponse = typeof ScheduleOverviewResponse.Type;

export const PicoRpcs = RpcGroup.make(
  Rpc.make("ListWorkspaces", {
    payload: Schema.Void,
    success: Schema.Array(Workspace.Workspace),
    error: Errors.ApplicationError,
  }),
  Rpc.make("ListChats", {
    payload: { workspaceId: Workspace.WorkspaceId },
    success: Schema.Array(Chat.ChatListEntry),
    error: Errors.ApplicationError,
  }),
  Rpc.make("ListSchedules", {
    payload: Schema.Void,
    success: ScheduleOverviewResponse,
    error: Schema.Union([Errors.ApplicationError, Schedule.ScheduleError]),
  }),
  Rpc.make("CreateWorkspace", {
    payload: Application.CreateWorkspace,
    success: Workspace.Workspace,
    error: Errors.ApplicationError,
  }),
  Rpc.make("UpdateWorkspace", {
    payload: Application.UpdateWorkspace,
    success: Workspace.Workspace,
    error: Schema.Union([Errors.ApplicationError, Errors.GitError, Errors.WorkspaceBindingInvalid]),
  }),
  Rpc.make("DeleteWorkspace", {
    payload: { workspaceId: Workspace.WorkspaceId },
    success: Schema.Void,
    error: Errors.ApplicationError,
  }),
  Rpc.make("CreateChat", {
    payload: Application.CreateChat,
    success: Chat.Chat,
    error: Errors.ApplicationError,
  }),
  Rpc.make("CloseChat", {
    payload: { chatId: Chat.ChatId, allowDirtyWorktree: Schema.Boolean },
    success: Application.CloseChatResult,
    error: Errors.ApplicationError,
  }),
  Rpc.make("Transcript", {
    payload: { chatId: Chat.ChatId },
    success: TranscriptSnapshot,
    error: Errors.ApplicationError,
  }),
  Rpc.make("ContextUsage", {
    payload: { chatId: Chat.ChatId },
    success: ContextUsage,
    error: Schema.Union([Errors.ApplicationError, Errors.ChatClosed]),
  }),
  Rpc.make("AvailableModels", {
    payload: { chatId: Chat.ChatId },
    success: Schema.Array(ModelInfo),
    error: Schema.Union([Errors.ApplicationError, Errors.ChatClosed]),
  }),
  Rpc.make("SwitchModel", {
    payload: { chatId: Chat.ChatId, model: ModelRef },
    success: ModelSwitchResult,
    error: Schema.Union([Errors.ApplicationError, Errors.ChatClosed]),
  }),
  Rpc.make("SendMessage", {
    payload: { chatId: Chat.ChatId, prompt: AgentMessage.AgentPrompt },
    success: Schema.Void,
    error: Schema.Union([Errors.ApplicationError, Errors.ChatClosed]),
  }),
  Rpc.make("Abort", {
    payload: { chatId: Chat.ChatId },
    success: Schema.Void,
    error: Errors.ApplicationError,
  }),
  Rpc.make("Shake", {
    payload: { chatId: Chat.ChatId, mode: ShakeMode },
    success: ShakeResult,
    error: Schema.Union([Errors.ApplicationError, Errors.ChatClosed]),
  }),
  Rpc.make("Events", {
    payload: Schema.Void,
    success: AgentEvent.EventsFrame,
    error: Errors.ApplicationError,
    stream: true,
  }),
);
