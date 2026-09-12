import type * as AgentEvent from "@pico/contract/agent-event";
import type * as AgentMessage from "@pico/contract/agent-message";
import { AgentRuntime, type ShakeMode } from "@pico/contract/agent-runtime";
import { AgentSessionStore } from "@pico/contract/agent-session-store";
import {
  Application,
  type BindWorkspace,
  type ChatPlatformBinding,
  type CloseChatOptions,
  type CloseChatResult,
  type CreateChat,
  type CreateWorkspace,
} from "@pico/contract/application";
import {
  BranchNaming,
  type BranchNamingHandler,
  type BranchNamingRequest,
} from "@pico/contract/branch-naming";
import * as Chat from "@pico/contract/chat-model";
import { ChatRepository } from "@pico/contract/chat-repository";
import {
  AgentError,
  ApplicationError,
  ChatClosed,
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
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FiberSet from "effect/FiberSet";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

const failure = (message: string) => () => new ApplicationError({ message });
const runtimeFailure = (message: string) => (cause: AgentError) =>
  new ApplicationError({ message: `${message}: ${cause.message}` });
const scheduleHostError = (cause: { readonly message?: string }) =>
  new Schedule.ScheduleHostError({
    message: cause.message ?? "Scheduled application operation failed",
  });

const BranchTopic = Schema.String.check(
  Schema.isMaxLength(48),
  Schema.isPattern(/^[a-z][a-z0-9]*(?:-[a-z0-9]+){1,5}$/),
);
const parseBranchTopic = (value: string) => {
  const topic = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return Schema.is(BranchTopic)(topic) ? topic : undefined;
};

interface BranchNamingContext {
  readonly workspaceId: Workspace.WorkspaceId;
  readonly cwd: AbsolutePath;
  readonly branch: string;
  readonly prefix: string;
}

const findBranchNamingContext = Effect.fn("Application.findBranchNamingContext")(function* (
  chats: ChatRepository["Service"],
  workspaces: WorkspaceRepository["Service"],
  chatId: Chat.ChatId,
) {
  const maybeChat = yield* chats.findById(chatId);
  if (Option.isNone(maybeChat) || maybeChat.value.archivedAt !== null) return null;

  const chat = maybeChat.value;
  const maybeWorkspace = yield* workspaces.findById(chat.workspaceId);
  if (Option.isNone(maybeWorkspace) || maybeWorkspace.value.worktree === null) return null;

  return {
    workspaceId: chat.workspaceId,
    cwd: chat.cwd,
    branch: maybeWorkspace.value.worktree.branch,
    prefix: maybeWorkspace.value.worktree.prefix,
  } satisfies BranchNamingContext;
});

const sameBranchNamingContext = (left: BranchNamingContext, right: BranchNamingContext) =>
  left.workspaceId === right.workspaceId &&
  left.cwd === right.cwd &&
  left.branch === right.branch &&
  left.prefix === right.prefix;

const runBranchNaming = Effect.fn("Application.runBranchNaming")(function* (
  gitWorktree: GitWorktree,
  chats: ChatRepository["Service"],
  workspaces: WorkspaceRepository["Service"],
  request: BranchNamingRequest,
) {
  const before = yield* findBranchNamingContext(chats, workspaces, request.chatId);
  if (before === null) return;

  const generated = yield* Effect.tryPromise({
    try: request.generateTopic,
    catch: (cause) => cause,
  });
  if (generated === null) return;
  const topic = parseBranchTopic(generated);
  if (topic === undefined) return;

  const after = yield* findBranchNamingContext(chats, workspaces, request.chatId);
  if (after === null || !sameBranchNamingContext(before, after)) return;

  const result = yield* gitWorktree.renameChatBranch({
    chatId: request.chatId,
    cwd: after.cwd,
    prefix: after.prefix,
    topic,
  });
  const detail = result.kind === "skipped" ? ` reason=${result.reason}` : "";
  yield* Effect.logDebug(
    `pico.branch-naming chatId=${request.chatId} result=${result.kind}${detail}`,
  );
});

export const makeBranchNaming = Effect.fn("BranchNaming.make")(function* (
  gitWorktree: GitWorktree,
) {
  const chats = yield* ChatRepository;
  const workspaces = yield* WorkspaceRepository;
  const run = yield* FiberSet.makeRuntime<never, void, never>();

  const handle: BranchNamingHandler = (request) => {
    run(
      runBranchNaming(gitWorktree, chats, workspaces, request).pipe(
        Effect.catchCause((cause) =>
          Effect.logError(
            `pico.branch-naming chatId=${request.chatId} failed=${Cause.pretty(cause)}`,
          ),
        ),
      ),
    );
  };
  return BranchNaming.of({ handle });
});

export const branchNamingLayer = (gitWorktree: GitWorktree) =>
  Layer.effect(BranchNaming, makeBranchNaming(gitWorktree));

const make = Effect.fn("Application.make")(function* (gitWorktree: GitWorktree) {
  const workspaces = yield* WorkspaceRepository;
  const chats = yield* ChatRepository;
  const sessions = yield* AgentSessionStore;
  const runtime = yield* AgentRuntime;
  const crypto = yield* Crypto.Crypto;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  interface ChatLock {
    readonly semaphore: Semaphore.Semaphore;
    users: number;
  }

  const chatLocks = new Map<Chat.ChatId, ChatLock>();
  const serialized = <A, E, R>(
    chatId: Chat.ChatId,
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E, R> =>
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
      (entry) => entry.semaphore.withPermit(effect),
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
      return yield* new ApplicationError({ message: "Chat not found" });
    }
    return chat.value;
  });

  const ensureChatOpen = Effect.fn("Application.ensureChatOpen")(function* (
    chatId: Chat.ChatId,
    errorMessage: string,
  ) {
    const chat = yield* chats.findById(chatId).pipe(Effect.mapError(failure(errorMessage)));
    if (Option.isNone(chat)) return yield* new ApplicationError({ message: "Chat not found" });
    if (chat.value.archivedAt !== null) return yield* new ChatClosed();
  });

  const createWorkspace = Effect.fn("Application.createWorkspace")(
    function* (input: CreateWorkspace) {
      const id = Workspace.WorkspaceId.make(yield* crypto.randomUUIDv7);
      const createdAt = yield* Clock.currentTimeMillis;
      return yield* workspaces.create({ ...input, id, createdAt });
    },
    Effect.mapError(failure("Failed to create workspace")),
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
    const existing = yield* workspaces
      .findByBinding(input.binding)
      .pipe(Effect.mapError(failure("Failed to bind workspace")));

    if (Option.isNone(existing)) {
      return yield* createWorkspace({
        name: input.workspaceName,
        binding: input.binding,
        ...configuration,
      });
    }
    if (
      existing.value.defaultCwd === configuration.defaultCwd &&
      ((existing.value.worktree === null && configuration.worktree === null) ||
        (existing.value.worktree !== null &&
          configuration.worktree !== null &&
          existing.value.worktree.branch === configuration.worktree.branch &&
          existing.value.worktree.prefix === configuration.worktree.prefix))
    ) {
      return existing.value;
    }
    return yield* workspaces
      .replaceConfiguration(existing.value.id, configuration)
      .pipe(Effect.mapError(failure("Failed to bind workspace")));
  });

  const persistChat = Effect.fn("Application.persistChat")(function* (
    input: CreateChat,
    id: Chat.ChatId,
    cwd: AbsolutePath,
    createdAt: number,
  ) {
    return yield* Effect.acquireUseRelease(
      sessions.create({ chatId: id, cwd }),
      () => chats.create({ ...input, id, cwd, createdAt }),
      (_, exit) =>
        Exit.isFailure(exit)
          ? sessions
              .remove(id)
              .pipe(
                Effect.catchCause((cause) =>
                  Effect.logError("Failed to roll back OMP session", Cause.pretty(cause)),
                ),
              )
          : Effect.void,
    );
  });

  const createChatWithId = Effect.fn("Application.createChatWithId")(
    function* (input: CreateChat, id: Chat.ChatId, createdAt: number) {
      const maybeWorkspace = yield* workspaces.findById(input.workspaceId);
      if (Option.isNone(maybeWorkspace)) {
        return yield* Effect.fail(new ApplicationError({ message: "Failed to create chat" }));
      }

      const workspace = maybeWorkspace.value;
      if (workspace.worktree === null) {
        const cwd = yield* resolveWorkspacePath("cwd", workspace.defaultCwd);
        return yield* persistChat(input, id, cwd, createdAt);
      }

      return yield* gitWorktree.create(
        {
          chatId: id,
          repositoryCwd: workspace.defaultCwd,
          settings: workspace.worktree,
        },
        (cwd) => persistChat(input, id, cwd, createdAt),
      );
    },
    Effect.mapError(failure("Failed to create chat")),
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
        return yield* new ApplicationError({ message: "Failed to create chat" });
      }
      return existing.value;
    }
    return yield* createChatWithId(
      { workspaceId, externalId: null },
      chatId,
      yield* Clock.currentTimeMillis,
    );
  });

  const resolveScheduledChat = Effect.fn("Application.resolveScheduledChat")(function* (
    ownerWorkspaceId: Workspace.WorkspaceId,
    chatId: Chat.ChatId,
  ) {
    const chat = yield* findChat(chatId);
    if (chat.workspaceId !== ownerWorkspaceId) {
      return yield* new ApplicationError({
        message: "Scheduled chat does not belong to its owner workspace",
      });
    }
    if (chat.archivedAt !== null) return yield* new ChatClosed();
    return chat;
  });

  const findWorkspaceByPlatformId = Effect.fn("Application.findWorkspaceByPlatformId")(
    function* (platform: Workspace.WorkspacePlatform, workspaceExternalId: string) {
      return yield* workspaces.findByBinding({ platform, externalId: workspaceExternalId });
    },
    Effect.mapError(failure("Failed to find workspace")),
  );

  const findChatByPlatformId = Effect.fn("Application.findChatByPlatformId")(
    function* (
      platform: Workspace.WorkspacePlatform,
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
        return yield* new ApplicationError({ message: "Chat workspace not found" });
      }
      if (workspace.value.binding === null) return Option.none<ChatPlatformBinding>();
      return Option.some({
        platform: workspace.value.binding.platform,
        externalId: chat.value.externalId,
      });
    },
    Effect.mapError(failure("Failed to find chat platform binding")),
  );

  const transcript = Effect.fn("Application.transcript")(
    function* (chatId: Chat.ChatId) {
      return yield* runtime.transcript(chatId);
    },
    Effect.mapError(failure("Failed to read transcript")),
  );

  const closeChat = Effect.fn("Application.closeChat")(function* (
    chatId: Chat.ChatId,
    options: CloseChatOptions,
  ): Effect.fn.Return<CloseChatResult, ApplicationError> {
    return yield* serialized(
      chatId,
      Effect.gen(function* () {
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
          return yield* new ApplicationError({ message: "Chat not found" });
        }
        yield* runtime.close(chatId).pipe(Effect.mapError(failure("Failed to close chat runtime")));

        if (inspection.kind === "managed" && inspection.state !== "absent") {
          const removal = yield* gitWorktree
            .removeChat({ chatId, cwd: chat.cwd, force: options.allowDirtyWorktree })
            .pipe(Effect.mapError(failure("Failed to remove chat worktree")));
          switch (removal.kind) {
            case "removed":
            case "already-absent":
              break;
            case "force-required":
              return { kind: "worktree-confirmation-required" } satisfies CloseChatResult;
            case "not-managed":
              return yield* new ApplicationError({
                message: "Failed to remove chat worktree",
              });
            default: {
              const exhaustive: never = removal;
              return exhaustive;
            }
          }
        }
        return { kind: "closed" } satisfies CloseChatResult;
      }),
    );
  });

  const sendMessage = Effect.fn("Application.sendMessage")(function* (
    chatId: Chat.ChatId,
    prompt: AgentMessage.AgentPrompt,
  ) {
    yield* serialized(
      chatId,
      Effect.gen(function* () {
        yield* ensureChatOpen(chatId, "Failed to send message");
        yield* runtime
          .send(chatId, prompt)
          .pipe(Effect.mapError(runtimeFailure("Failed to send message")));
      }),
    );
  });
  const runScheduled = Effect.fn("Application.runScheduled")(function* (
    chatId: Chat.ChatId,
    runId: Schedule.ScheduleRunId,
    prompt: AgentMessage.AgentPrompt,
    onEvent: (event: AgentEvent.AgentEvent) => Effect.Effect<void, AgentError>,
  ) {
    return yield* serialized(
      chatId,
      Effect.gen(function* () {
        yield* ensureChatOpen(chatId, "Failed to run scheduled prompt");
        return yield* runtime
          .sendCaptured(chatId, runId, prompt, onEvent)
          .pipe(Effect.mapError(runtimeFailure("Failed to run scheduled prompt")));
      }),
    );
  });

  const deliverScheduled = Effect.fn("Application.deliverScheduled")(function* (
    chatId: Chat.ChatId,
    content: string,
  ) {
    yield* serialized(
      chatId,
      Effect.gen(function* () {
        yield* ensureChatOpen(chatId, "Failed to deliver scheduled result");
        yield* runtime
          .deliver(chatId, content)
          .pipe(Effect.mapError(failure("Failed to deliver scheduled result")));
      }),
    );
  });

  const publishScheduled = Effect.fn("Application.publishScheduled")(function* (
    chatId: Chat.ChatId,
    content: string,
  ) {
    yield* serialized(
      chatId,
      Effect.gen(function* () {
        yield* ensureChatOpen(chatId, "Failed to publish scheduled result");
        yield* runtime
          .publish(chatId, content)
          .pipe(Effect.mapError(runtimeFailure("Failed to publish scheduled result")));
      }),
    );
  });

  const abort = Effect.fn("Application.abort")(function* (chatId: Chat.ChatId) {
    const chat = yield* chats
      .findById(chatId)
      .pipe(Effect.mapError(failure("Failed to abort chat")));
    if (Option.isNone(chat)) return yield* new ApplicationError({ message: "Chat not found" });
    if (chat.value.archivedAt !== null) return;
    yield* runtime.abort(chatId).pipe(Effect.mapError(failure("Failed to abort chat")));
  });

  const contextUsage = Effect.fn("Application.contextUsage")(function* (chatId: Chat.ChatId) {
    return yield* serialized(
      chatId,
      Effect.gen(function* () {
        yield* ensureChatOpen(chatId, "Failed to read chat context");
        return yield* runtime
          .contextUsage(chatId)
          .pipe(Effect.mapError(runtimeFailure("Failed to read chat context")));
      }),
    );
  });

  const shake = Effect.fn("Application.shake")(function* (chatId: Chat.ChatId, mode: ShakeMode) {
    return yield* serialized(
      chatId,
      Effect.gen(function* () {
        yield* ensureChatOpen(chatId, "Failed to shake chat");
        return yield* runtime
          .shake(chatId, mode)
          .pipe(Effect.mapError(runtimeFailure("Failed to shake chat")));
      }),
    );
  });

  const application = Application.of({
    createWorkspace,
    bindWorkspace,
    createChat,
    findWorkspaceByPlatformId,
    findChatByPlatformId,
    findChatPlatformBinding,
    transcript,
    closeChat,
    sendMessage,
    abort,
    contextUsage,
    shake,
  });
  const scheduleHost = Schedule.ScheduleRunHostService.of({
    prepare: (target) => {
      switch (target.kind) {
        case "existing-chat":
          return resolveScheduledChat(target.ownerWorkspaceId, target.chatId).pipe(
            Effect.map((chat) => ({
              chatId: chat.id,
              workspaceId: chat.workspaceId,
              cwd: chat.cwd,
            })),
            Effect.mapError(scheduleHostError),
          );
        case "workspace-chat":
          return createScheduledChat(target.ownerWorkspaceId, target.chatId).pipe(
            Effect.map((chat) => ({
              chatId: chat.id,
              workspaceId: chat.workspaceId,
              cwd: chat.cwd,
            })),
            Effect.mapError(scheduleHostError),
          );
        default: {
          const exhaustive: never = target;
          return exhaustive;
        }
      }
    },
    deliver: (chatId, content) =>
      deliverScheduled(chatId, content).pipe(Effect.mapError(scheduleHostError)),
    publish: (chatId, content) =>
      publishScheduled(chatId, content).pipe(Effect.mapError(scheduleHostError)),
    runPrompt: (chatId, runId, prompt, onEvent) =>
      runScheduled(chatId, runId, prompt, (event) =>
        onEvent(event).pipe(Effect.mapError((error) => new AgentError({ message: error.message }))),
      ).pipe(Effect.mapError(scheduleHostError)),
  });
  return Context.make(Application, application).pipe(
    Context.add(Schedule.ScheduleRunHostService, scheduleHost),
  );
});

export const layer = (gitWorktree: GitWorktree) => Layer.effectContext(make(gitWorktree));
