import type * as AgentEvent from "@pico/contract/agent-event";
import type * as History from "@pico/contract/agent-history";
import type * as AgentMessage from "@pico/contract/agent-message";
import {
  AgentRuntime,
  type MessageDelivery,
  type ModelRef,
  type ShakeMode,
} from "@pico/contract/agent-runtime";
import { AgentSessionStore } from "@pico/contract/agent-session-store";
import {
  Application,
  type BindWorkspace,
  type ChatPlatformBinding,
  type CloseChatOptions,
  type CloseChatResult,
  type CreateChat,
  type CreateWorkspace,
  type UpdateWorkspace,
} from "@pico/contract/application";
import * as Chat from "@pico/contract/chat-model";
import { ChatRepository } from "@pico/contract/chat-repository";
import {
  AgentError,
  ApplicationError,
  ChatClosed,
  GitError,
  PersistenceError,
  WorkspaceBindingInvalid,
} from "@pico/contract/errors";
import { AbsolutePath } from "@pico/contract/path";
import * as Schedule from "@pico/contract/schedule";
import * as Workspace from "@pico/contract/workspace-model";
import { WorkspaceRepository } from "@pico/contract/workspace-repository";
import type { GitWorktree } from "@pico/contract/worktree";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Semaphore from "effect/Semaphore";

const failure =
  (message: string) =>
  (cause: unknown): ApplicationError => {
    if (cause instanceof ApplicationError) return cause;
    if (cause instanceof WorkspaceBindingInvalid) {
      return new ApplicationError({
        reason: "invalid-state",
        message: `${message}: ${cause.issue.field} ${cause.issue.reason}`,
      });
    }
    return new ApplicationError({
      reason: "operation",
      message:
        cause instanceof AgentError ||
        cause instanceof GitError ||
        cause instanceof PersistenceError ||
        cause instanceof Schedule.ScheduleError
          ? `${message}: ${cause.message}`
          : message,
    });
  };
const scheduleHostError = (cause: { readonly message?: string }) =>
  new Schedule.ScheduleHostError({
    message: cause.message ?? "Scheduled application operation failed",
  });

const make = Effect.fn("Application.make")(function* (gitWorktree: GitWorktree) {
  const workspaces = yield* WorkspaceRepository;
  const chats = yield* ChatRepository;
  const sessions = yield* AgentSessionStore;
  const runtime = yield* AgentRuntime;
  const schedules = yield* Schedule.Schedules;
  const crypto = yield* Crypto.Crypto;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const scope = yield* Effect.scope;
  type Operation =
    | { readonly kind: "ordinary" | "captured" }
    | { readonly kind: "btw"; readonly cancelled: Deferred.Deferred<void> };
  type ActiveOperation = Operation & { readonly finished: Deferred.Deferred<void> };
  const activeOperations = new Map<Chat.ChatId, Set<ActiveOperation>>();
  const trackOperation = <A, E, R>(
    chatId: Chat.ChatId,
    request: Operation,
    effect: Effect.Effect<A, E, R>,
  ) => {
    const finished = Deferred.makeUnsafe<void>();
    const operation: ActiveOperation = { ...request, finished };
    const operations = activeOperations.get(chatId) ?? new Set<ActiveOperation>();
    operations.add(operation);
    activeOperations.set(chatId, operations);
    return effect.pipe(
      Effect.ensuring(
        Effect.sync(() => {
          operations.delete(operation);
          if (operations.size === 0) activeOperations.delete(chatId);
          Deferred.doneUnsafe(finished, Effect.void);
        }),
      ),
    );
  };

  interface ChatLock {
    readonly semaphore: Semaphore.Semaphore;
    users: number;
  }

  const chatLocks = new Map<string, ChatLock>();
  const serialized = <A, E, R>(
    chatId: string,
    effect: Effect.Effect<A, E, R>,
    wait = true,
  ): Effect.Effect<A, E | ApplicationError, R> =>
    Effect.acquireUseRelease(
      Effect.sync(() => {
        const existing = chatLocks.get(chatId);
        if (existing !== undefined) {
          existing.users += 1;
          return existing;
        }
        const created: ChatLock = { semaphore: Semaphore.makeUnsafe(1), users: 1 };
        chatLocks.set(chatId, created);
        return created;
      }),
      (entry) =>
        wait
          ? entry.semaphore.withPermit(effect)
          : entry.semaphore
              .withPermitsIfAvailable(1)(effect)
              .pipe(
                Effect.flatMap((result) =>
                  Option.isSome(result)
                    ? Effect.succeed(result.value)
                    : Effect.fail(
                        new ApplicationError({
                          reason: "conflict",
                          message: "Workspace has active chat work. Try again when it finishes.",
                        }),
                      ),
                ),
              ),
      (entry) =>
        Effect.sync(() => {
          entry.users -= 1;
          if (entry.users === 0 && chatLocks.get(chatId) === entry) chatLocks.delete(chatId);
        }),
    );

  const findChat = Effect.fn("Application.findChat")(function* (chatId: Chat.ChatId) {
    const chat = yield* chats
      .findById(chatId)
      .pipe(Effect.mapError(failure("Failed to find chat")));
    if (Option.isNone(chat)) {
      return yield* new ApplicationError({ reason: "not-found", message: "Chat not found" });
    }
    const workspace = yield* workspaces
      .findById(chat.value.workspaceId)
      .pipe(Effect.mapError(failure("Failed to find chat workspace")));
    if (Option.isNone(workspace)) {
      return yield* new ApplicationError({ reason: "not-found", message: "Workspace not found" });
    }
    return chat.value;
  });

  const ensureChatOpen = Effect.fn("Application.ensureChatOpen")(function* (
    chatId: Chat.ChatId,
    errorMessage: string,
  ) {
    const chat = yield* findChat(chatId).pipe(Effect.mapError(failure(errorMessage)));
    if (chat.archivedAt !== null) return yield* new ChatClosed();
    return chat;
  });

  const listWorkspaces = Effect.fn("Application.listWorkspaces")(
    function* () {
      return yield* workspaces.list();
    },
    Effect.mapError(failure("Failed to list workspaces")),
  );

  const createWorkspace = Effect.fn("Application.createWorkspace")(
    function* (input: CreateWorkspace) {
      const configuration = yield* resolveConfiguration(
        input.worktree === null
          ? { kind: "direct", cwd: input.defaultCwd }
          : {
              kind: "worktree",
              repository: input.defaultCwd,
              settings: input.worktree,
            },
      );
      const id = Workspace.WorkspaceId.make(yield* crypto.randomUUIDv7);
      const createdAt = yield* Clock.currentTimeMillis;
      const workspace = yield* workspaces.create({
        ...input,
        ...configuration,
        modelOverride: null,
        id,
        createdAt,
      });
      yield* Effect.logInfo("Workspace created").pipe(
        Effect.annotateLogs({
          component: "application",
          operation: "create-workspace",
          workspaceId: id,
        }),
      );
      return workspace;
    },
    Effect.mapError(failure("Failed to create workspace")),
  );

  const updateWorkspace = Effect.fn("Application.updateWorkspace")(function* (
    input: UpdateWorkspace,
  ) {
    const existing = yield* workspaces
      .findById(input.workspaceId)
      .pipe(Effect.mapError(failure("Failed to find workspace")));
    if (Option.isNone(existing)) {
      return yield* new ApplicationError({ reason: "not-found", message: "Workspace not found" });
    }
    const configuration = yield* resolveConfiguration(input.configuration);
    return yield* workspaces
      .replaceConfiguration(existing.value.id, configuration)
      .pipe(Effect.mapError(failure("Failed to update workspace")));
  });

  const deleteWorkspace = Effect.fn("Application.deleteWorkspace")(
    function* (workspaceId: Workspace.WorkspaceId) {
      if (Option.isNone(yield* workspaces.findById(workspaceId))) {
        return yield* new ApplicationError({ reason: "not-found", message: "Workspace not found" });
      }
      const openChats = yield* chats.listOpenByWorkspace(workspaceId);
      const checkedChatIds = openChats.map((chat) => chat.id).sort();
      let deletion = Effect.gen(function* () {
        for (const chatId of checkedChatIds) {
          const chat = yield* findChat(chatId);
          if (chat.archivedAt !== null) continue;
          if ((activeOperations.get(chatId)?.size ?? 0) > 0) {
            return yield* new ApplicationError({
              reason: "conflict",
              message: "Workspace has active chat work. Try again when it finishes.",
            });
          }
          if ((yield* runtime.transcript(chatId)).messages.length > 0) {
            return yield* new ApplicationError({
              reason: "conflict",
              message: "Archive chats with messages before deleting this workspace.",
            });
          }
        }
        yield* schedules.withCurrentTargets((targets) =>
          Effect.gen(function* () {
            for (const target of targets) {
              let targetWorkspaceId: Workspace.WorkspaceId;
              if (target.kind === "workspace") {
                targetWorkspaceId = target.workspaceId;
              } else {
                const chat = yield* chats.findById(target.chatId);
                if (Option.isNone(chat)) {
                  return yield* new ApplicationError({
                    reason: "operation",
                    message:
                      "Cannot verify a schedule's chat target. Remove or repair that schedule first.",
                  });
                }
                targetWorkspaceId = chat.value.workspaceId;
              }
              if (targetWorkspaceId === workspaceId) {
                return yield* new ApplicationError({
                  reason: "conflict",
                  message:
                    "Remove schedules targeting this workspace or its chats before deleting it, including disabled schedules.",
                });
              }
            }
            const outcome = yield* workspaces.softDelete({
              id: workspaceId,
              deletedAt: yield* Clock.currentTimeMillis,
              checkedChatIds,
            });
            if (outcome === "not-found") {
              return yield* new ApplicationError({
                reason: "not-found",
                message: "Workspace not found",
              });
            }
            if (outcome === "conflict") {
              return yield* new ApplicationError({
                reason: "conflict",
                message: "Workspace chats changed while deleting. Try again.",
              });
            }
          }),
        );
      }).pipe(Effect.mapError(failure("Failed to delete workspace")));
      for (let index = checkedChatIds.length - 1; index >= 0; index -= 1) {
        const chatId = checkedChatIds[index];
        if (chatId !== undefined) deletion = serialized(chatId, deletion, false);
      }
      yield* deletion;
    },
    Effect.mapError(failure("Failed to delete workspace")),
  );

  const getOrCreateWorkspaceByBinding = Effect.fn("Application.getOrCreateWorkspaceByBinding")(
    function* (input: Extract<CreateWorkspace, { readonly externalId: string }>) {
      const id = Workspace.WorkspaceId.make(yield* crypto.randomUUIDv7);
      const createdAt = yield* Clock.currentTimeMillis;
      const workspace = yield* workspaces.getOrCreateByBinding({
        ...input,
        modelOverride: null,
        id,
        createdAt,
      });
      if (Option.isNone(workspace)) {
        return yield* new ApplicationError({
          reason: "conflict",
          message: "This platform binding belongs to a deleted workspace.",
        });
      }
      return workspace.value;
    },
    Effect.mapError(failure("Failed to get or create workspace")),
  );

  type WorkspacePathInvalidReason = Extract<
    WorkspaceBindingInvalid["issue"],
    { readonly field: "cwd" }
  >["reason"];

  const workspacePathInvalid = (field: "cwd" | "repository", reason: WorkspacePathInvalidReason) =>
    new WorkspaceBindingInvalid({
      issue: field === "cwd" ? { field: "cwd", reason } : { field: "repository", reason },
    });

  const resolveWorkspacePath = Effect.fn("Application.resolveWorkspacePath")(function* (
    field: "cwd" | "repository",
    input: string,
  ) {
    if (input.trim() !== input) {
      return yield* Effect.fail(workspacePathInvalid(field, "surrounding-whitespace"));
    }
    if (!path.isAbsolute(input)) {
      return yield* Effect.fail(workspacePathInvalid(field, "not-absolute"));
    }

    const normalized = path.normalize(input);
    const info = yield* fileSystem
      .stat(normalized)
      .pipe(
        Effect.mapError((error) =>
          workspacePathInvalid(
            field,
            error.reason._tag === "NotFound" ? "not-found" : "unreadable",
          ),
        ),
      );
    if (info.type !== "Directory") {
      return yield* Effect.fail(workspacePathInvalid(field, "not-directory"));
    }
    yield* fileSystem
      .access(normalized, { readable: true })
      .pipe(
        Effect.mapError((error) =>
          workspacePathInvalid(
            field,
            error.reason._tag === "NotFound" ? "not-found" : "unreadable",
          ),
        ),
      );
    return AbsolutePath.make(normalized);
  });

  const resolveConfiguration = Effect.fn("Application.resolveWorkspaceConfiguration")(function* (
    configuration: BindWorkspace["configuration"],
  ) {
    switch (configuration.kind) {
      case "direct":
        return {
          defaultCwd: yield* resolveWorkspacePath("cwd", configuration.cwd),
          worktree: null,
        } satisfies Workspace.WorkspaceConfiguration;
      case "worktree": {
        const repositoryCwd = yield* resolveWorkspacePath("repository", configuration.repository);
        yield* gitWorktree.validate({ repositoryCwd, settings: configuration.settings });
        return {
          defaultCwd: repositoryCwd,
          worktree: configuration.settings,
        } satisfies Workspace.WorkspaceConfiguration;
      }
      default: {
        const exhaustive: never = configuration;
        return exhaustive;
      }
    }
  });

  const bindWorkspace = Effect.fn("Application.bindWorkspace")(function* (input: BindWorkspace) {
    const configuration = yield* resolveConfiguration(input.configuration);
    const existing = yield* getOrCreateWorkspaceByBinding({
      name: input.workspaceName,
      ...input.binding,
      ...configuration,
    });
    if (
      existing.defaultCwd === configuration.defaultCwd &&
      ((existing.worktree === null && configuration.worktree === null) ||
        (existing.worktree !== null &&
          configuration.worktree !== null &&
          existing.worktree.branch === configuration.worktree.branch &&
          existing.worktree.prefix === configuration.worktree.prefix))
    ) {
      return existing;
    }
    const workspace = yield* workspaces
      .replaceConfiguration(existing.id, configuration)
      .pipe(Effect.mapError(failure("Failed to bind workspace")));
    yield* Effect.logInfo("Workspace binding updated").pipe(
      Effect.annotateLogs({
        component: "application",
        operation: "bind-workspace",
        workspaceId: workspace.id,
      }),
    );
    return workspace;
  });

  const availableWorkspaceModels = Effect.fn("Application.availableWorkspaceModels")(function* (
    input: Parameters<Application["Service"]["availableWorkspaceModels"]>[0],
  ) {
    if (input.kind === "binding") {
      const workspace = yield* workspaces
        .findByBinding(input.binding)
        .pipe(Effect.mapError(failure("Failed to find workspace")));
      return yield* runtime
        .availableModels(Option.isSome(workspace) ? workspace.value.defaultCwd : input.defaultCwd)
        .pipe(Effect.mapError(failure("Failed to list available models")));
    }
    const workspace = yield* workspaces
      .findById(input.workspaceId)
      .pipe(Effect.mapError(failure("Failed to find workspace")));
    if (Option.isNone(workspace)) {
      return yield* new ApplicationError({
        reason: "not-found",
        message: "Workspace not found",
      });
    }
    return yield* runtime
      .availableModels(workspace.value.defaultCwd)
      .pipe(Effect.mapError(failure("Failed to list available models")));
  });

  const availableWorkspaceSkills = Effect.fn("Application.availableWorkspaceSkills")(function* (
    workspaceId: Workspace.WorkspaceId,
  ) {
    const workspace = yield* workspaces
      .findById(workspaceId)
      .pipe(Effect.mapError(failure("Failed to find workspace")));
    if (Option.isNone(workspace)) {
      return yield* new ApplicationError({
        reason: "not-found",
        message: "Workspace not found",
      });
    }
    return yield* runtime
      .discoverSkills(workspace.value.defaultCwd)
      .pipe(Effect.mapError(failure("Failed to list workspace skill commands")));
  });

  const setWorkspaceModel = Effect.fn("Application.setWorkspaceModel")(function* (
    workspaceId: Workspace.WorkspaceId,
    model: ModelRef | null,
  ) {
    const workspace = yield* workspaces
      .findById(workspaceId)
      .pipe(Effect.mapError(failure("Failed to find workspace")));
    if (Option.isNone(workspace)) {
      return yield* new ApplicationError({ reason: "not-found", message: "Workspace not found" });
    }
    return yield* workspaces
      .setModelOverride(workspaceId, model)
      .pipe(Effect.mapError(failure("Failed to set workspace model")));
  });

  const resolveInitialModelOverride = Effect.fn("Application.resolveInitialModelOverride")(
    function* (
      cwd: AbsolutePath,
      workspaceModelOverride: ModelRef | null,
      requestedModelOverride: ModelRef | null,
    ) {
      if (requestedModelOverride === null) return workspaceModelOverride;
      const available = yield* runtime
        .availableModels(cwd)
        .pipe(Effect.mapError(failure("Failed to validate the selected draft model")));
      if (
        !available.some(
          (model) =>
            model.provider === requestedModelOverride.provider &&
            model.id === requestedModelOverride.id,
        )
      ) {
        return yield* new ApplicationError({
          reason: "invalid-state",
          message: "Selected model is no longer available for this workspace",
        });
      }
      return requestedModelOverride;
    },
  );

  const persistChat = Effect.fn("Application.persistChat")(function* (
    input: CreateChat,
    id: Chat.ChatId,
    cwd: AbsolutePath,
    createdAt: number,
    modelOverride: ModelRef | null,
  ) {
    return yield* Effect.acquireUseRelease(
      sessions.create({ chatId: id, cwd, modelOverride }),
      () =>
        chats.create({
          workspaceId: input.workspaceId,
          externalId: input.externalId,
          id,
          cwd,
          createdAt,
        }),
      (_, exit) =>
        Exit.isFailure(exit)
          ? sessions.remove(id).pipe(
              Effect.catchCause((cause) =>
                Cause.hasInterruptsOnly(cause)
                  ? Effect.void
                  : Effect.logError("Failed to roll back OMP session").pipe(
                      Effect.annotateLogs({
                        component: "application",
                        operation: "create-chat",
                        phase: "session-rollback",
                        chatId: id,
                        workspaceId: input.workspaceId,
                        reason: Cause.hasDies(cause) ? "defect" : "operation",
                      }),
                    ),
              ),
            )
          : Effect.void,
    );
  });

  const createChatWithId = Effect.fn("Application.createChatWithId")(
    function* (input: CreateChat, id: Chat.ChatId, createdAt: number) {
      const maybeWorkspace = yield* workspaces.findById(input.workspaceId);
      if (Option.isNone(maybeWorkspace)) {
        return yield* new ApplicationError({
          reason: "not-found",
          message: "Cannot create chat: workspace not found",
        });
      }

      const workspace = maybeWorkspace.value;
      if (workspace.worktree === null) {
        const cwd = yield* resolveWorkspacePath("cwd", workspace.defaultCwd);
        const modelOverride = yield* resolveInitialModelOverride(
          cwd,
          workspace.modelOverride,
          input.modelOverride,
        );
        return yield* persistChat(input, id, cwd, createdAt, modelOverride);
      }

      return yield* gitWorktree.create(
        {
          chatId: id,
          repositoryCwd: workspace.defaultCwd,
          settings: workspace.worktree,
        },
        (cwd) =>
          Effect.gen(function* () {
            const modelOverride = yield* resolveInitialModelOverride(
              cwd,
              workspace.modelOverride,
              input.modelOverride,
            );
            return yield* persistChat(input, id, cwd, createdAt, modelOverride);
          }),
      );
    },
    Effect.mapError(failure("Failed to create chat")),
    (effect, input, id) =>
      effect.pipe(
        Effect.tap(() =>
          Effect.logInfo("Chat created").pipe(
            Effect.annotateLogs({
              component: "application",
              operation: "create-chat",
              chatId: id,
              workspaceId: input.workspaceId,
            }),
          ),
        ),
      ),
  );

  const listChats = Effect.fn("Application.listChats")(
    function* (workspaceId: Workspace.WorkspaceId) {
      const workspace = yield* workspaces.findById(workspaceId);
      if (Option.isNone(workspace)) {
        return yield* new ApplicationError({
          reason: "not-found",
          message: "Workspace not found",
        });
      }
      const openChats = yield* chats.listOpenByWorkspace(workspaceId);
      return yield* Effect.forEach(openChats, (chat) =>
        sessions.readTitle(chat.id).pipe(Effect.map((title) => ({ ...chat, title }))),
      );
    },
    Effect.mapError(failure("Failed to list chats")),
  );

  const createChat = Effect.fn("Application.createChat")(function* (input: CreateChat) {
    return yield* createChatWithId(
      input,
      Chat.ChatId.make(
        yield* crypto.randomUUIDv7.pipe(Effect.mapError(failure("Failed to create chat"))),
      ),
      yield* Clock.currentTimeMillis,
    );
  });

  const createScheduledChat = Effect.fn("Application.createScheduledChat")(function* (
    workspaceId: Workspace.WorkspaceId,
    chatId: Chat.ChatId,
  ) {
    const existing = yield* chats
      .findById(chatId)
      .pipe(Effect.mapError(failure("Failed to create chat")));
    if (Option.isSome(existing)) {
      if (existing.value.workspaceId !== workspaceId) {
        return yield* new ApplicationError({
          reason: "conflict",
          message: "Scheduled chat identity belongs to another workspace",
        });
      }
      return yield* ensureChatOpen(chatId, "Failed to create scheduled chat");
    }
    return yield* createChatWithId(
      { workspaceId, externalId: null, modelOverride: null },
      chatId,
      yield* Clock.currentTimeMillis,
    );
  });

  const resolveScheduledChat = Effect.fn("Application.resolveScheduledChat")(function* (
    chatId: Chat.ChatId,
  ) {
    const chat = yield* findChat(chatId);
    if (chat.archivedAt !== null) return yield* new ChatClosed();
    return chat;
  });

  const findWorkspaceByPlatformId = Effect.fn("Application.findWorkspaceByPlatformId")(
    function* (platform: Workspace.WorkspaceBinding["platform"], workspaceExternalId: string) {
      return yield* workspaces.findByBinding({ platform, externalId: workspaceExternalId });
    },
    Effect.mapError(failure("Failed to find workspace")),
  );

  const findChatByPlatformId = Effect.fn("Application.findChatByPlatformId")(
    function* (
      platform: Workspace.WorkspaceBinding["platform"],
      workspaceExternalId: string,
      chatExternalId: string,
    ) {
      const workspace = yield* workspaces.findByBinding({
        platform,
        externalId: workspaceExternalId,
      });
      if (Option.isNone(workspace)) {
        return Option.none<Chat.Chat>();
      }
      return yield* chats.findByExternalId(workspace.value.id, chatExternalId);
    },
    Effect.mapError(failure("Failed to find chat")),
  );
  const findChatPlatformBinding = Effect.fn("Application.findChatPlatformBinding")(
    function* (chatId: Chat.ChatId) {
      const chat = yield* chats.findById(chatId);
      if (Option.isNone(chat) || chat.value.externalId === null) {
        return Option.none<ChatPlatformBinding>();
      }
      const workspace = yield* workspaces.findById(chat.value.workspaceId);
      if (Option.isNone(workspace)) {
        return yield* new ApplicationError({
          reason: "not-found",
          message: "Chat workspace not found",
        });
      }
      if (workspace.value.externalId === null) return Option.none<ChatPlatformBinding>();
      return Option.some({
        platform: workspace.value.platform,
        externalId: chat.value.externalId,
      });
    },
    Effect.mapError(failure("Failed to find chat platform binding")),
  );

  const transcript = Effect.fn("Application.transcript")(
    function* (chatId: Chat.ChatId) {
      yield* findChat(chatId);
      return yield* runtime.transcript(chatId);
    },
    Effect.mapError(failure("Failed to read transcript")),
  );

  const history = Effect.fn("Application.history")(function* (input: History.ChatHistoryRequest) {
    yield* ensureChatOpen(input.chatId, "Failed to read chat history");
    const snapshot = yield* runtime
      .history(input)
      .pipe(Effect.mapError(failure("Failed to read chat history")));
    return (activeOperations.get(input.chatId)?.size ?? 0) > 0
      ? { ...snapshot, canContinue: false }
      : snapshot;
  });

  const previewHistory = Effect.fn("Application.previewHistory")(function* (
    input: History.PreviewChatHistoryRequest,
  ) {
    yield* ensureChatOpen(input.chatId, "Failed to preview chat history");
    return yield* runtime
      .previewHistory(input)
      .pipe(Effect.mapError(failure("Failed to preview chat history")));
  });

  const navigateHistory = Effect.fn("Application.navigateHistory")(function* (
    input: History.NavigateChatHistoryRequest,
  ) {
    return yield* serialized(
      input.chatId,
      Effect.gen(function* () {
        yield* ensureChatOpen(input.chatId, "Failed to navigate chat history");
        if ((activeOperations.get(input.chatId)?.size ?? 0) > 0) {
          const snapshot = yield* history({ chatId: input.chatId, query: "" });
          return {
            kind: "conflict",
            reason: "busy",
            version: snapshot.version,
            history: snapshot,
          } as const;
        }
        return yield* runtime
          .navigateHistory(input)
          .pipe(Effect.mapError(failure("Failed to navigate chat history")));
      }),
    );
  });

  const closeChat = Effect.fn("Application.closeChat")(function* (
    chatId: Chat.ChatId,
    options: CloseChatOptions,
  ): Effect.fn.Return<CloseChatResult, ApplicationError> {
    return yield* serialized(
      chatId,
      Effect.gen(function* () {
        yield* Effect.forEach(
          activeOperations.get(chatId) ?? [],
          (operation) =>
            operation.kind === "ordinary" ? Deferred.await(operation.finished) : Effect.void,
          { discard: true },
        );
        const chat = yield* findChat(chatId);
        const inspection = yield* gitWorktree
          .inspectChat({ chatId, cwd: chat.cwd })
          .pipe(Effect.mapError(failure("Failed to inspect chat worktree")));
        if (
          inspection.kind === "managed" &&
          inspection.state === "dirty" &&
          !options.allowDirtyWorktree
        ) {
          return { kind: "worktree-confirmation-required" } satisfies CloseChatResult;
        }

        const archivedAt = yield* Clock.currentTimeMillis;
        const archived = yield* chats
          .archive(chatId, archivedAt)
          .pipe(Effect.mapError(failure("Failed to archive chat")));
        if (Option.isNone(archived)) {
          return yield* new ApplicationError({ reason: "not-found", message: "Chat not found" });
        }
        yield* Effect.logInfo("Chat archived").pipe(
          Effect.annotateLogs({
            component: "application",
            operation: "close-chat",
            phase: "archive",
            chatId,
            workspaceId: chat.workspaceId,
          }),
        );
        for (const operation of activeOperations.get(chatId) ?? []) {
          if (operation.kind !== "btw") continue;
          yield* Deferred.succeed(operation.cancelled, undefined);
        }
        for (const operation of activeOperations.get(chatId) ?? []) {
          if (operation.kind !== "btw") continue;
          yield* Deferred.await(operation.finished);
        }
        yield* runtime
          .close(chatId)
          .pipe(Effect.mapError(failure("Chat archived, but runtime close failed")));
        yield* Effect.forEach(
          activeOperations.get(chatId) ?? [],
          (operation) => Deferred.await(operation.finished),
          { discard: true },
        );
        yield* Effect.logDebug("Chat runtime closed").pipe(
          Effect.annotateLogs({
            component: "application",
            operation: "close-chat",
            phase: "runtime-close",
            chatId,
            workspaceId: chat.workspaceId,
          }),
        );

        if (inspection.kind === "managed" && inspection.state !== "absent") {
          const removal = yield* gitWorktree
            .removeChat({ chatId, cwd: chat.cwd, force: options.allowDirtyWorktree })
            .pipe(
              Effect.mapError(
                failure("Chat archived and runtime closed, but worktree removal failed"),
              ),
            );
          switch (removal.kind) {
            case "removed":
            case "already-absent":
              break;
            case "force-required":
              return { kind: "worktree-confirmation-required" } satisfies CloseChatResult;
            case "not-managed":
              return yield* new ApplicationError({
                reason: "invalid-state",
                message: "Chat archived and runtime closed, but worktree is no longer managed",
              });
            default: {
              const exhaustive: never = removal;
              return exhaustive;
            }
          }
        }
        yield* Effect.logInfo("Chat closed").pipe(
          Effect.annotateLogs({
            component: "application",
            operation: "close-chat",
            chatId,
            workspaceId: chat.workspaceId,
          }),
        );
        return { kind: "closed" } satisfies CloseChatResult;
      }),
    );
  });

  const sendMessage = Effect.fn("Application.sendMessage")(function* (
    chatId: Chat.ChatId,
    prompt: AgentMessage.AgentPrompt,
  ): Effect.fn.Return<MessageDelivery<ApplicationError>, ApplicationError | ChatClosed> {
    return yield* serialized(
      chatId,
      Effect.gen(function* () {
        yield* ensureChatOpen(chatId, "Failed to send message");
        const delivery = yield* runtime
          .send(chatId, prompt)
          .pipe(Effect.mapError(failure("Failed to send message")));
        if (delivery.kind === "handled") return delivery;
        const completed = delivery.completed.pipe(
          Effect.mapError(failure("Failed to send message")),
        );
        yield* Effect.uninterruptible(
          trackOperation(chatId, { kind: "ordinary" }, completed).pipe(
            Effect.exit,
            Effect.forkIn(scope),
          ),
        );
        return delivery.kind === "started"
          ? ({ kind: "started", completed } satisfies MessageDelivery<ApplicationError>)
          : ({
              kind: "steered",
              consumed: delivery.consumed,
              completed,
            } satisfies MessageDelivery<ApplicationError>);
      }),
    );
  });
  const askBtw = Effect.fn("Application.askBtw")(function* (
    chatId: Chat.ChatId,
    question: string,
  ): Effect.fn.Return<string, ApplicationError | ChatClosed> {
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const operationScope = yield* Effect.scope;
        const cancelled = yield* Deferred.make<void>();
        const operation = yield* serialized(
          chatId,
          Effect.gen(function* () {
            yield* ensureChatOpen(chatId, "Failed to ask side question");
            return yield* Effect.uninterruptible(
              trackOperation(
                chatId,
                { kind: "btw", cancelled },
                runtime
                  .askBtw(chatId, question)
                  .pipe(
                    Effect.mapError(failure("Failed to ask side question")),
                    Effect.raceFirst(
                      Deferred.await(cancelled).pipe(Effect.andThen(Effect.interrupt)),
                    ),
                  ),
              ).pipe(Effect.forkIn(operationScope)),
            );
          }),
        );
        return yield* Fiber.join(operation);
      }),
    );
  });

  const runScheduled = Effect.fn("Application.runScheduled")(function* (
    chatId: Chat.ChatId,
    runId: Schedule.ScheduleRunId,
    prompt: AgentMessage.AgentPrompt,
    onEvent: (event: AgentEvent.AgentEvent) => Effect.Effect<void, AgentError>,
  ) {
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const operationScope = yield* Effect.scope;
        const operation = yield* serialized(
          chatId,
          Effect.gen(function* () {
            yield* ensureChatOpen(chatId, "Failed to run scheduled prompt");
            return yield* Effect.uninterruptible(
              trackOperation(
                chatId,
                { kind: "captured" },
                runtime
                  .sendCaptured(chatId, runId, prompt, onEvent)
                  .pipe(Effect.mapError(failure("Failed to run scheduled prompt"))),
              ).pipe(Effect.forkIn(operationScope)),
            );
          }),
        );
        return yield* Fiber.join(operation);
      }),
    );
  });

  const deliverScheduled = Effect.fn("Application.deliverScheduled")(function* (
    chatId: Chat.ChatId,
    message: AgentMessage.AgentAssistantMessage,
    localOnly?: true,
  ) {
    yield* ensureChatOpen(chatId, "Failed to deliver scheduled result");
    yield* runtime
      .deliver(chatId, message, localOnly)
      .pipe(Effect.mapError(failure("Failed to deliver scheduled result")));
  });

  const publishScheduled = Effect.fn("Application.publishScheduled")(function* (
    chatId: Chat.ChatId,
    content: string,
    localOnly?: true,
  ) {
    yield* Effect.gen(function* () {
      yield* ensureChatOpen(chatId, "Failed to publish scheduled result");
      yield* runtime.publish(chatId, content, localOnly);
    }).pipe(
      Effect.mapError((cause) =>
        cause instanceof ChatClosed ? cause : failure("Failed to publish scheduled result")(cause),
      ),
    );
  });

  const abort = Effect.fn("Application.abort")(function* (chatId: Chat.ChatId) {
    const chat = yield* findChat(chatId);
    if (chat.archivedAt !== null) return;
    yield* runtime.abort(chatId).pipe(Effect.mapError(failure("Failed to abort chat")));
  });

  const contextUsage = Effect.fn("Application.contextUsage")(function* (chatId: Chat.ChatId) {
    return yield* serialized(
      chatId,
      Effect.gen(function* () {
        yield* ensureChatOpen(chatId, "Failed to read chat context");
        return yield* runtime
          .contextUsage(chatId)
          .pipe(Effect.mapError(failure("Failed to read chat context")));
      }),
    );
  });

  const availableModels = Effect.fn("Application.availableModels")(function* (chatId: Chat.ChatId) {
    const chat = yield* ensureChatOpen(chatId, "Failed to list chat models");
    return yield* runtime
      .availableModels(chat.cwd)
      .pipe(Effect.mapError(failure("Failed to list available models")));
  });

  const availableSkills = Effect.fn("Application.availableSkills")(function* (chatId: Chat.ChatId) {
    return yield* serialized(
      chatId,
      Effect.gen(function* () {
        yield* ensureChatOpen(chatId, "Failed to list chat skill commands");
        return yield* runtime
          .availableSkills(chatId)
          .pipe(Effect.mapError(failure("Failed to list chat skill commands")));
      }),
    );
  });
  const switchModel = Effect.fn("Application.switchModel")(function* (
    chatId: Chat.ChatId,
    model: ModelRef,
  ) {
    return yield* serialized(
      chatId,
      Effect.gen(function* () {
        yield* ensureChatOpen(chatId, "Failed to switch chat model");
        return yield* runtime
          .switchModel(chatId, model)
          .pipe(Effect.mapError(failure("Failed to switch chat model")));
      }),
    );
  });

  const shake = Effect.fn("Application.shake")(function* (chatId: Chat.ChatId, mode: ShakeMode) {
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const operationScope = yield* Effect.scope;
        const operation = yield* serialized(
          chatId,
          Effect.gen(function* () {
            yield* ensureChatOpen(chatId, "Failed to shake chat");
            return yield* Effect.uninterruptible(
              trackOperation(
                chatId,
                { kind: "ordinary" },
                runtime.shake(chatId, mode).pipe(Effect.mapError(failure("Failed to shake chat"))),
              ).pipe(Effect.forkIn(operationScope)),
            );
          }),
        );
        return yield* Fiber.join(operation);
      }),
    );
  });

  const application = Application.of({
    listWorkspaces,
    createWorkspace,
    updateWorkspace,
    deleteWorkspace,
    getOrCreateWorkspaceByBinding,
    bindWorkspace,
    availableWorkspaceModels,
    availableWorkspaceSkills,
    setWorkspaceModel,
    listChats,
    createChat,
    findWorkspaceByPlatformId,
    findChatByPlatformId,
    findChatPlatformBinding,
    transcript,
    history,
    previewHistory,
    navigateHistory,
    closeChat,
    sendMessage,
    askBtw,
    abort,
    contextUsage,
    availableModels,
    availableSkills,
    switchModel,
    shake,
  });
  const scheduleHostFactory = Schedule.ScheduleRunHostFactory.of((platform) => {
    const getWorkspace = Effect.fn("Application.scheduleWorkspace")(function* (
      workspaceId: Workspace.WorkspaceId,
    ) {
      const workspace = yield* workspaces.findById(workspaceId);
      if (Option.isNone(workspace)) {
        return yield* new Schedule.ScheduleHostError({ message: "Schedule workspace not found" });
      }
      return workspace.value;
    }, Effect.mapError(scheduleHostError));

    const validateWorkspace = Effect.fn("Application.validateScheduleWorkspace")(function* (
      workspace: Workspace.Workspace,
      chat?: Chat.Chat,
    ) {
      switch (workspace.platform) {
        case "web":
        case "desktop":
        case "mobile":
          return null;
        case "discord": {
          if (platform === null) {
            return yield* new Schedule.ScheduleHostError({
              message: "Discord schedule destinations are unavailable",
            });
          }
          if (chat !== undefined && chat.externalId === null) {
            return yield* new Schedule.ScheduleHostError({
              message: "Discord schedule chat has no external thread binding",
            });
          }
          yield* platform.validateTarget(
            chat === undefined || chat.externalId === null
              ? { kind: "workspace", workspaceExternalId: workspace.externalId }
              : {
                  kind: "chat",
                  workspaceExternalId: workspace.externalId,
                  chatExternalId: chat.externalId,
                },
          );
          return platform;
        }
        default:
          return yield* new Schedule.ScheduleHostError({
            message: `Unsupported schedule platform: ${workspace.platform}`,
          });
      }
    });

    const resolveTarget = Effect.fn("Application.resolveScheduleTarget")(function* (
      input: Schedule.ScheduleTargetInput,
    ) {
      if (input.kind === "external-chat" || input.kind === "external-workspace") {
        if (platform === null) {
          return yield* new Schedule.ScheduleHostError({
            message: "Discord schedule destinations are unavailable",
          });
        }
        return yield* platform.resolveTarget(input);
      }
      if (input.kind === "chat") {
        const chat = yield* resolveScheduledChat(input.chatId);
        yield* validateWorkspace(yield* getWorkspace(chat.workspaceId), chat);
      } else {
        yield* validateWorkspace(yield* getWorkspace(input.workspaceId));
      }
      return input;
    }, Effect.mapError(scheduleHostError));

    const scriptTarget = Effect.fn("Application.scriptScheduleTarget")(function* (
      destination: Schedule.ScheduleTarget,
    ) {
      if (destination.kind === "workspace") {
        return {
          kind: "workspace-chat",
          workspaceId: destination.workspaceId,
        } satisfies Schedule.ScheduleScriptTarget;
      }
      const chat = yield* findChat(destination.chatId);
      return {
        kind: "existing-chat",
        workspaceId: chat.workspaceId,
      } satisfies Schedule.ScheduleScriptTarget;
    }, Effect.mapError(scheduleHostError));

    const materialize = Effect.fn("Application.materializeScheduleTarget")(function* (
      input: Parameters<Schedule.ScheduleRunHost["materialize"]>[0],
    ) {
      const destination = input.destination;
      const scheduledChatId =
        destination.kind === "chat" ? destination.chatId : destination.newChatId;
      return yield* serialized(
        scheduledChatId,
        Effect.gen(function* () {
          let chat: Chat.Chat;
          let workspace: Workspace.Workspace;
          let adapter: Schedule.SchedulePlatform | null;
          if (destination.kind === "chat") {
            chat = yield* resolveScheduledChat(destination.chatId);
            workspace = yield* getWorkspace(chat.workspaceId);
            adapter = yield* validateWorkspace(workspace, chat);
            if (chat.id !== destination.chatId) {
              return yield* new Schedule.ScheduleHostError({
                message: "Scheduled chat identity does not match its destination",
              });
            }
          } else {
            workspace = yield* getWorkspace(destination.workspaceId);
            adapter = yield* validateWorkspace(workspace);
            chat = yield* createScheduledChat(destination.workspaceId, destination.newChatId);
            if (chat.id !== destination.newChatId || chat.workspaceId !== destination.workspaceId) {
              return yield* new Schedule.ScheduleHostError({
                message: "Scheduled chat identity does not match its destination",
              });
            }
            if (chat.externalId !== null) {
              yield* validateWorkspace(workspace, chat);
            }
          }
          if (workspace.platform === "discord" && adapter !== null && chat.externalId === null) {
            let bound = false;
            yield* Effect.acquireUseRelease(
              adapter.createThread({
                workspaceExternalId: workspace.externalId,
                title: input.title,
              }),
              (externalId) =>
                Effect.gen(function* () {
                  const binding = yield* chats.bindExternalId({
                    chatId: chat.id,
                    workspaceId: chat.workspaceId,
                    externalId,
                  });
                  if (Option.isNone(binding)) {
                    return yield* new Schedule.ScheduleHostError({
                      message: `Could not bind scheduled Discord thread ${externalId}`,
                    });
                  }
                  bound = true;
                }).pipe(Effect.uninterruptible),
              (externalId) =>
                bound
                  ? Effect.void
                  : adapter
                      .deleteThread(externalId)
                      .pipe(
                        Effect.catchCause((cause) =>
                          Effect.logError(
                            "Failed to roll back scheduled Discord thread",
                            cause,
                          ).pipe(Effect.annotateLogs({ chatId: chat.id, externalId })),
                        ),
                      ),
            );
          }
          return {
            chatId: chat.id,
            workspaceId: chat.workspaceId,
            cwd: chat.cwd,
          } satisfies Schedule.ResolvedScheduleRunTarget;
        }),
      );
    }, Effect.mapError(scheduleHostError));

    const sendScheduled = Effect.fn("Application.sendScheduled")(function* (
      chatId: Chat.ChatId,
      publication:
        | { readonly kind: "publish"; readonly content: string }
        | { readonly kind: "deliver"; readonly message: AgentMessage.AgentAssistantMessage },
    ) {
      yield* serialized(
        chatId,
        Effect.gen(function* () {
          const chat = yield* resolveScheduledChat(chatId);
          const adapter = yield* validateWorkspace(yield* getWorkspace(chat.workspaceId), chat);
          const localOnly = adapter === null ? undefined : true;
          if (publication.kind === "publish") {
            yield* publishScheduled(chatId, publication.content, localOnly);
          } else {
            yield* deliverScheduled(chatId, publication.message, localOnly);
          }
          if (adapter !== null && chat.externalId !== null) {
            const content =
              publication.kind === "publish"
                ? publication.content
                : publication.message.content
                    .filter((block) => block.type === "text")
                    .map((block) => block.text)
                    .join("");
            yield* adapter.send({ chatId, externalId: chat.externalId, content });
          }
        }),
      );
    }, Effect.mapError(scheduleHostError));

    return {
      resolveTarget,
      scriptTarget,
      materialize,
      deliver: (chatId, message) => sendScheduled(chatId, { kind: "deliver", message }),
      publish: (chatId, content) => sendScheduled(chatId, { kind: "publish", content }),
      runPrompt: (chatId, runId, prompt, onEvent) =>
        runScheduled(chatId, runId, prompt, (event) =>
          onEvent(event).pipe(
            Effect.mapError((error) => new AgentError({ message: error.message })),
          ),
        ).pipe(Effect.mapError(scheduleHostError)),
    };
  });
  return Context.make(Application, application).pipe(
    Context.add(Schedule.ScheduleRunHostFactory, scheduleHostFactory),
  );
});

export const layer = (gitWorktree: GitWorktree) => Layer.effectContext(make(gitWorktree));
