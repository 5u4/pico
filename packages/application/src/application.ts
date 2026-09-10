import type * as AgentMessage from "@pico/contract/agent-message";
import { AgentRuntime, type ShakeMode } from "@pico/contract/agent-runtime";
import { AgentSessionStore } from "@pico/contract/agent-session-store";
import {
  Application,
  type BindWorkspace,
  type CloseChatOptions,
  type CloseChatResult,
  type CreateChat,
  type CreateWorkspace,
} from "@pico/contract/application";
import * as Chat from "@pico/contract/chat-model";
import { ChatRepository } from "@pico/contract/chat-repository";
import { ApplicationError, ChatClosed, WorkspaceBindingInvalid } from "@pico/contract/errors";
import { AbsolutePath } from "@pico/contract/path";
import * as Workspace from "@pico/contract/workspace-model";
import { WorkspaceRepository } from "@pico/contract/workspace-repository";
import type { GitWorktree } from "@pico/contract/worktree";
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Semaphore from "effect/Semaphore";

const failure = (message: string) => () => new ApplicationError({ message });

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

  const createChat = Effect.fn("Application.createChat")(
    function* (input: CreateChat) {
      const maybeWorkspace = yield* workspaces.findById(input.workspaceId);
      if (Option.isNone(maybeWorkspace)) {
        return yield* Effect.fail(new ApplicationError({ message: "Failed to create chat" }));
      }

      const workspace = maybeWorkspace.value;
      const id = Chat.ChatId.make(yield* crypto.randomUUIDv7);
      const createdAt = yield* Clock.currentTimeMillis;

      if (workspace.worktree === null) {
        yield* sessions.create({ chatId: id, cwd: workspace.defaultCwd });
        return yield* chats.create({
          ...input,
          id,
          cwd: workspace.defaultCwd,
          createdAt,
        });
      }

      const cwd = yield* gitWorktree.create(
        {
          chatId: id,
          repositoryCwd: workspace.defaultCwd,
          settings: workspace.worktree,
        },
        (createdCwd) =>
          sessions.create({ chatId: id, cwd: createdCwd }).pipe(Effect.as(createdCwd)),
      );
      return yield* chats.create({ ...input, id, cwd, createdAt });
    },
    Effect.mapError(failure("Failed to create chat")),
  );

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
          return { kind: "worktree-confirmation-required" };
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
              return { kind: "worktree-confirmation-required" };
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
        return { kind: "closed" };
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
          .pipe(Effect.mapError(failure("Failed to send message")));
      }),
    );
  });

  const abort = Effect.fn("Application.abort")(function* (chatId: Chat.ChatId) {
    yield* serialized(
      chatId,
      Effect.gen(function* () {
        const chat = yield* chats
          .findById(chatId)
          .pipe(Effect.mapError(failure("Failed to abort chat")));
        if (Option.isNone(chat)) return yield* new ApplicationError({ message: "Chat not found" });
        if (chat.value.archivedAt !== null) return;
        yield* runtime.abort(chatId).pipe(Effect.mapError(failure("Failed to abort chat")));
      }),
    );
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

  const shake = Effect.fn("Application.shake")(function* (chatId: Chat.ChatId, mode: ShakeMode) {
    return yield* serialized(
      chatId,
      Effect.gen(function* () {
        yield* ensureChatOpen(chatId, "Failed to shake chat");
        return yield* runtime
          .shake(chatId, mode)
          .pipe(Effect.mapError(failure("Failed to shake chat")));
      }),
    );
  });

  return Application.of({
    createWorkspace,
    bindWorkspace,
    createChat,
    findWorkspaceByPlatformId,
    findChatByPlatformId,
    transcript,
    closeChat,
    sendMessage,
    abort,
    contextUsage,
    shake,
  });
});

export const layer = (gitWorktree: GitWorktree) => Layer.effect(Application, make(gitWorktree));
