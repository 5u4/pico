import * as Schema from "effect/Schema";
import * as Rpc from "effect/unstable/rpc/Rpc";
import * as RpcGroup from "effect/unstable/rpc/RpcGroup";
import * as AgentEvent from "./agent-event.ts";
import * as AgentMessage from "./agent-message.ts";
import { TranscriptSnapshot } from "./agent-runtime.ts";
import * as Application from "./application.ts";
import * as Chat from "./chat-model.ts";
import * as Errors from "./errors.ts";
import * as Schedule from "./schedule.ts";
import * as Workspace from "./workspace-model.ts";

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
    payload: { workspaceId: Workspace.WorkspaceId },
    success: Schema.Array(Schedule.ScheduleView),
    error: Schema.Union([Errors.ApplicationError, Schedule.ScheduleError]),
  }),
  Rpc.make("UpdateSchedule", {
    payload: {
      workspaceId: Workspace.WorkspaceId,
      id: Schedule.ScheduleId,
      input: Schedule.UpdateSchedule,
    },
    success: Schedule.ScheduleView,
    error: Schema.Union([Errors.ApplicationError, Schedule.ScheduleError]),
  }),
  Rpc.make("DeleteSchedule", {
    payload: { workspaceId: Workspace.WorkspaceId, id: Schedule.ScheduleId },
    success: Schema.Void,
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
  Rpc.make("Events", {
    payload: Schema.Void,
    success: AgentEvent.AgentEventEnvelope,
    error: Errors.ApplicationError,
    stream: true,
  }),
);
