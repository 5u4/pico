import { AgentSessionStore } from "@pico/contract/agent-session-store";
import { Application, type CreateChat, type CreateWorkspace } from "@pico/contract/application";
import * as Chat from "@pico/contract/chat-model";
import { ChatRepository } from "@pico/contract/chat-repository";
import { ApplicationError } from "@pico/contract/errors";
import * as Workspace from "@pico/contract/workspace-model";
import { WorkspaceRepository } from "@pico/contract/workspace-repository";
import type { CreateWorktree } from "@pico/contract/worktree";
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

const failure = (message: string) => () => new ApplicationError({ message });

const make = Effect.fn("Application.make")(function* (createWorktree: CreateWorktree) {
  const workspaces = yield* WorkspaceRepository;
  const chats = yield* ChatRepository;
  const sessions = yield* AgentSessionStore;
  const crypto = yield* Crypto.Crypto;

  const createWorkspace = Effect.fn("Application.createWorkspace")(
    function* (input: CreateWorkspace) {
      const id = Workspace.WorkspaceId.make(yield* crypto.randomUUIDv7);
      const createdAt = yield* Clock.currentTimeMillis;
      return yield* workspaces.create({ ...input, id, createdAt });
    },
    Effect.mapError(failure("Failed to create workspace")),
  );

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

  return Application.of({ createWorkspace, createChat });
});

export const layer = (createWorktree: CreateWorktree) =>
  Layer.effect(Application, make(createWorktree));
