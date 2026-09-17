import { Application } from "@pico/contract/application";
import type { ChatId } from "@pico/contract/chat-model";
import { ChatRepository } from "@pico/contract/chat-repository";
import { ApplicationError, ChatClosed, WorkspaceBindingInvalid } from "@pico/contract/errors";
import { EventRouter } from "@pico/contract/event-router";
import { PicoRpcs } from "@pico/contract/rpc";
import { ScheduleError, Schedules } from "@pico/contract/schedule";
import type { WorkspaceId, WorkspacePlatform } from "@pico/contract/workspace-model";
import { WorkspaceRepository } from "@pico/contract/workspace-repository";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization";
import * as RpcServer from "effect/unstable/rpc/RpcServer";

const handlers = PicoRpcs.toLayer(
  Effect.gen(function* () {
    const application = yield* Application;
    const eventRouter = yield* EventRouter;
    const workspaces = yield* WorkspaceRepository;
    const chats = yield* ChatRepository;
    const schedules = yield* Schedules;

    return PicoRpcs.of({
      ListWorkspaces: (_, { requestId }) =>
        application.listWorkspaces().pipe(
          Effect.map((items) => items.filter((workspace) => workspace.platform === "web")),
          Effect.tapCause(reportFailure),
          Effect.annotateLogs({
            component: "rpc",
            procedure: "ListWorkspaces",
            requestId: String(requestId),
          }),
        ),
      ListChats: ({ workspaceId }, { requestId }) =>
        requireWebWorkspace(workspaces, workspaceId).pipe(
          Effect.andThen(() => application.listChats(workspaceId)),
          Effect.tapCause(reportFailure),
          Effect.annotateLogs({
            component: "rpc",
            procedure: "ListChats",
            workspaceId,
            requestId: String(requestId),
          }),
        ),
      ListSchedules: (_, { requestId }) =>
        Effect.gen(function* () {
          const snapshot = yield* schedules.overview();
          const owners = yield* workspaces.list().pipe(
            Effect.mapError(
              () =>
                new ApplicationError({
                  reason: "operation",
                  message: "Failed to read schedule owners",
                }),
            ),
          );
          const byId = new Map(
            owners.map(({ id, name, platform }) => [id, { id, name, platform }]),
          );
          return {
            observedAt: snapshot.observedAt,
            entries: snapshot.entries.map((entry) => ({
              ...entry,
              owner:
                entry.ownerWorkspaceId === null ? null : (byId.get(entry.ownerWorkspaceId) ?? null),
            })),
          };
        }).pipe(
          Effect.tapCause(reportFailure),
          Effect.annotateLogs({
            component: "rpc",
            procedure: "ListSchedules",
            requestId: String(requestId),
          }),
        ),
      CreateWorkspace: (input, { requestId }) =>
        (input.platform === "web"
          ? application.createWorkspace(input)
          : Effect.fail(
              new ApplicationError({
                reason: "invalid-state",
                message: "Only web workspaces can be created through RPC",
              }),
            )
        ).pipe(
          Effect.tapCause(reportFailure),
          Effect.annotateLogs({
            component: "rpc",
            procedure: "CreateWorkspace",
            requestId: String(requestId),
          }),
        ),
      UpdateWorkspace: (input, { requestId }) =>
        requireWebWorkspace(workspaces, input.workspaceId).pipe(
          Effect.andThen(() => application.updateWorkspace(input)),
          Effect.tapCause(reportFailure),
          Effect.annotateLogs({
            component: "rpc",
            procedure: "UpdateWorkspace",
            workspaceId: input.workspaceId,
            requestId: String(requestId),
          }),
        ),
      CreateChat: (input, { requestId }) =>
        requireWebWorkspace(workspaces, input.workspaceId).pipe(
          Effect.andThen(() => application.createChat(input)),
          Effect.tapCause(reportFailure),
          Effect.annotateLogs({
            component: "rpc",
            procedure: "CreateChat",
            workspaceId: input.workspaceId,
            requestId: String(requestId),
          }),
        ),
      CloseChat: ({ chatId, allowDirtyWorktree }, { requestId }) =>
        requireWebChat(workspaces, chats, chatId).pipe(
          Effect.andThen(() => application.closeChat(chatId, { allowDirtyWorktree })),
          Effect.tapCause(reportFailure),
          Effect.annotateLogs({
            component: "rpc",
            procedure: "CloseChat",
            chatId,
            requestId: String(requestId),
          }),
        ),
      Transcript: ({ chatId }, { requestId }) =>
        requireWebChat(workspaces, chats, chatId).pipe(
          Effect.andThen(() => application.transcript(chatId)),
          Effect.tapCause(reportFailure),
          Effect.annotateLogs({
            component: "rpc",
            procedure: "Transcript",
            chatId,
            requestId: String(requestId),
          }),
        ),
      SendMessage: ({ chatId, prompt }, { requestId }) =>
        requireWebChat(workspaces, chats, chatId).pipe(
          Effect.andThen(() => application.sendMessage(chatId, prompt)),
          Effect.flatMap((delivery) =>
            delivery.kind === "handled" ? Effect.void : delivery.completed,
          ),
          Effect.tapCause(reportFailure),
          Effect.annotateLogs({
            component: "rpc",
            procedure: "SendMessage",
            chatId,
            requestId: String(requestId),
          }),
        ),
      Abort: ({ chatId }, { requestId }) =>
        requireWebChat(workspaces, chats, chatId).pipe(
          Effect.andThen(() => application.abort(chatId)),
          Effect.tapCause(reportFailure),
          Effect.annotateLogs({
            component: "rpc",
            procedure: "Abort",
            chatId,
            requestId: String(requestId),
          }),
        ),
      Events: (_, { requestId }) =>
        Stream.unwrap(openWebEvents(eventRouter, workspaces, chats)).pipe(
          Stream.tapCause((cause) =>
            reportFailure(cause).pipe(
              Effect.annotateLogs({
                component: "rpc",
                procedure: "Events",
                requestId: String(requestId),
              }),
            ),
          ),
        ),
    });
  }),
);

/** Daemon composition installs web chat routes and the root-local read-only schedule overview. */
export const routes = RpcServer.layerHttp({ group: PicoRpcs, path: "/rpc" }).pipe(
  Layer.provide(handlers),
  Layer.provide(RpcSerialization.layerJson),
);

const requireWebWorkspace = Effect.fn("Rpc.requireWebWorkspace")(function* (
  workspaces: WorkspaceRepository["Service"],
  workspaceId: WorkspaceId,
) {
  const workspace = yield* workspaces.findById(workspaceId).pipe(
    Effect.mapError(
      () =>
        new ApplicationError({
          reason: "operation",
          message: "Failed to resolve workspace ownership",
        }),
    ),
  );
  if (Option.isNone(workspace) || workspace.value.platform !== "web") {
    return yield* new ApplicationError({ reason: "not-found", message: "Workspace not found" });
  }
});

const readChatPlatform = Effect.fn("Rpc.readChatPlatform")(
  function* (
    workspaces: WorkspaceRepository["Service"],
    chats: ChatRepository["Service"],
    chatId: ChatId,
  ) {
    const chat = yield* chats.findById(chatId);
    if (Option.isNone(chat)) return Option.none<WorkspacePlatform>();
    const workspace = yield* workspaces.findById(chat.value.workspaceId);
    return Option.map(workspace, (value) => value.platform);
  },
  Effect.mapError(
    () =>
      new ApplicationError({
        reason: "operation",
        message: "Failed to resolve chat ownership",
      }),
  ),
);

const requireWebChat = Effect.fn("Rpc.requireWebChat")(function* (
  workspaces: WorkspaceRepository["Service"],
  chats: ChatRepository["Service"],
  chatId: ChatId,
) {
  const platform = yield* readChatPlatform(workspaces, chats, chatId);
  if (Option.isNone(platform) || platform.value !== "web") {
    return yield* new ApplicationError({ reason: "not-found", message: "Chat not found" });
  }
});

const openWebEvents = Effect.fn("Rpc.openWebEvents")(function* (
  eventRouter: EventRouter["Service"],
  workspaces: WorkspaceRepository["Service"],
  chats: ChatRepository["Service"],
) {
  const platforms = new Map<ChatId, WorkspacePlatform>();
  const canReadChat = Effect.fn("Rpc.canReadChat")(function* (chatId: ChatId) {
    const cached = platforms.get(chatId);
    if (cached !== undefined) return cached === "web";
    const platform = yield* readChatPlatform(workspaces, chats, chatId);
    if (Option.isNone(platform)) return false;
    if (platforms.size === 256) {
      const oldest = platforms.keys().next();
      if (!oldest.done) platforms.delete(oldest.value);
    }
    platforms.set(chatId, platform.value);
    return platform.value === "web";
  });
  const route = yield* eventRouter.open(() => true);
  return route.events.pipe(Stream.filterEffect(({ chatId }) => canReadChat(chatId)));
});

const reportFailure = (cause: Cause.Cause<unknown>) => {
  const operational = cause.reasons.some((reason) => {
    if (reason._tag === "Interrupt") return false;
    if (reason._tag === "Die") return true;
    const error = reason.error;
    if (error instanceof ApplicationError) return error.reason === "operation";
    if (error instanceof ScheduleError) return error.kind === "io" || error.kind === "corrupt";
    return !(error instanceof ChatClosed || error instanceof WorkspaceBindingInvalid);
  });
  if (!operational) return Effect.void;
  const safeCause = Cause.fromReasons(
    cause.reasons.map((reason) => {
      if (reason._tag === "Interrupt") return reason;
      if (
        reason._tag === "Fail" &&
        (reason.error instanceof ApplicationError ||
          reason.error instanceof ChatClosed ||
          reason.error instanceof WorkspaceBindingInvalid)
      )
        return reason;
      const error = new Error(
        reason._tag === "Die" ? "Unexpected RPC defect" : "RPC operation failed",
      );
      return reason._tag === "Die" ? Cause.makeDieReason(error) : Cause.makeFailReason(error);
    }),
  );
  return Effect.logError("pico.rpc.failed", safeCause).pipe(
    Effect.annotateLogs({ operation: "request", outcome: "failure" }),
  );
};
