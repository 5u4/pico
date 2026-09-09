import type * as AgentMessage from "@pico/contract/agent-message";
import { AgentRuntime, type ShakeMode } from "@pico/contract/agent-runtime";
import { AgentSessionStore } from "@pico/contract/agent-session-store";
import {
  Application,
  type BindWorkspace,
  type CreateChat,
  type CreateWorkspace,
} from "@pico/contract/application";
import * as Chat from "@pico/contract/chat-model";
import { ChatRepository } from "@pico/contract/chat-repository";
import { ApplicationError, WorkspaceCwdInvalid } from "@pico/contract/errors";
import { AbsolutePath } from "@pico/contract/path";
import * as Workspace from "@pico/contract/workspace-model";
import { WorkspaceRepository } from "@pico/contract/workspace-repository";
import type { CreateWorktree } from "@pico/contract/worktree";
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

const failure = (message: string) => () => new ApplicationError({ message });

const make = Effect.fn("Application.make")(function* (createWorktree: CreateWorktree) {
  const workspaces = yield* WorkspaceRepository;
  const chats = yield* ChatRepository;
  const sessions = yield* AgentSessionStore;
  const runtime = yield* AgentRuntime;
  const crypto = yield* Crypto.Crypto;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const createWorkspace = Effect.fn("Application.createWorkspace")(
    function* (input: CreateWorkspace) {
      const id = Workspace.WorkspaceId.make(yield* crypto.randomUUIDv7);
      const createdAt = yield* Clock.currentTimeMillis;
      return yield* workspaces.create({ ...input, id, createdAt });
    },
    Effect.mapError(failure("Failed to create workspace")),
  );

  const resolveWorkspaceCwd = Effect.fn("Application.resolveWorkspaceCwd")(function* (cwd: string) {
    if (cwd.trim() !== cwd) {
      return yield* Effect.fail(new WorkspaceCwdInvalid({ cwd, reason: "surrounding-whitespace" }));
    }
    if (!path.isAbsolute(cwd)) {
      return yield* Effect.fail(new WorkspaceCwdInvalid({ cwd, reason: "not-absolute" }));
    }

    const normalized = path.normalize(cwd);
    const info = yield* fileSystem.stat(normalized).pipe(
      Effect.mapError(
        (error) =>
          new WorkspaceCwdInvalid({
            cwd,
            reason: error.reason._tag === "NotFound" ? "not-found" : "unreadable",
          }),
      ),
    );
    if (info.type !== "Directory") {
      return yield* Effect.fail(new WorkspaceCwdInvalid({ cwd, reason: "not-directory" }));
    }
    yield* fileSystem.access(normalized, { readable: true }).pipe(
      Effect.mapError(
        (error) =>
          new WorkspaceCwdInvalid({
            cwd,
            reason: error.reason._tag === "NotFound" ? "not-found" : "unreadable",
          }),
      ),
    );
    return AbsolutePath.make(normalized);
  });

  const bindWorkspace = Effect.fn("Application.bindWorkspace")(function* (input: BindWorkspace) {
    const cwd = yield* resolveWorkspaceCwd(input.cwd);
    const existing = yield* workspaces
      .findByBinding(input.binding)
      .pipe(Effect.mapError(failure("Failed to bind workspace")));

    if (Option.isNone(existing)) {
      return yield* createWorkspace({
        name: input.workspaceName,
        binding: input.binding,
        defaultCwd: cwd,
        worktree: null,
      });
    }
    if (existing.value.defaultCwd === cwd) return existing.value;
    return yield* workspaces
      .changeDefaultCwd(existing.value.id, cwd)
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

      const cwd = yield* createWorktree(
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

  const sendMessage = Effect.fn("Application.sendMessage")(
    function* (chatId: Chat.ChatId, prompt: AgentMessage.AgentPrompt) {
      yield* runtime.send(chatId, prompt);
    },
    Effect.mapError(failure("Failed to send message")),
  );

  const abort = Effect.fn("Application.abort")(
    function* (chatId: Chat.ChatId) {
      yield* runtime.abort(chatId);
    },
    Effect.mapError(failure("Failed to abort chat")),
  );

  const contextUsage = Effect.fn("Application.contextUsage")(
    function* (chatId: Chat.ChatId) {
      return yield* runtime.contextUsage(chatId);
    },
    Effect.mapError(failure("Failed to read chat context")),
  );

  const shake = Effect.fn("Application.shake")(
    function* (chatId: Chat.ChatId, mode: ShakeMode) {
      return yield* runtime.shake(chatId, mode);
    },
    Effect.mapError(failure("Failed to shake chat")),
  );

  return Application.of({
    createWorkspace,
    bindWorkspace,
    createChat,
    findWorkspaceByPlatformId,
    findChatByPlatformId,
    transcript,
    sendMessage,
    abort,
    contextUsage,
    shake,
  });
});

export const layer = (createWorktree: CreateWorktree) =>
  Layer.effect(Application, make(createWorktree));
