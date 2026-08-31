import {
  Application,
  type CreateRegularChat,
  type CreateWorkspace,
} from "@pico/contract/application";
import * as Chat from "@pico/contract/chat-model";
import { ChatRepository } from "@pico/contract/chat-repository";
import { ApplicationError } from "@pico/contract/errors";
import * as Workspace from "@pico/contract/workspace-model";
import { WorkspaceRepository } from "@pico/contract/workspace-repository";
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

const failure = (message: string) => () => new ApplicationError({ message });

const make = Effect.fn("Application.make")(function* () {
  const workspaces = yield* WorkspaceRepository;
  const chats = yield* ChatRepository;
  const crypto = yield* Crypto.Crypto;

  const createWorkspace = Effect.fn("Application.createWorkspace")(
    function* (input: CreateWorkspace) {
      const id = Workspace.WorkspaceId.make(yield* crypto.randomUUIDv7);
      const createdAt = yield* Clock.currentTimeMillis;
      return yield* workspaces.create({ ...input, id, createdAt });
    },
    Effect.mapError(failure("Failed to create workspace")),
  );

  const createRegularChat = Effect.fn("Application.createRegularChat")(
    function* (input: CreateRegularChat) {
      const workspace = yield* workspaces.findById(input.workspaceId);
      if (Option.isNone(workspace) || workspace.value.worktree !== null) {
        return yield* Effect.fail(
          new ApplicationError({ message: "Failed to create regular chat" }),
        );
      }

      const id = Chat.ChatId.make(yield* crypto.randomUUIDv7);
      const createdAt = yield* Clock.currentTimeMillis;
      return yield* chats.createRegular({
        ...input,
        id,
        cwd: workspace.value.defaultCwd,
        createdAt,
      });
    },
    Effect.mapError(failure("Failed to create regular chat")),
  );

  return Application.of({ createWorkspace, createRegularChat });
});

export const layer = Layer.effect(Application, make());
