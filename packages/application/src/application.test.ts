import * as BunCrypto from "@effect/platform-bun/BunCrypto";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import * as BunPath from "@effect/platform-bun/BunPath";
import { assert, describe, it } from "@effect/vitest";
import { AgentSessionStore, type CreateAgentSession } from "@pico/contract/agent-session-store";
import { Application } from "@pico/contract/application";
import { ChatRepository } from "@pico/contract/chat-repository";
import { ApplicationError } from "@pico/contract/errors";
import { AbsolutePath } from "@pico/contract/path";
import * as Workspace from "@pico/contract/workspace-model";
import type { CreateWorktree, CreateWorktreeOptions } from "@pico/contract/worktree";
import * as Persistence from "@pico/persistence/layer";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as TestClock from "effect/testing/TestClock";
import * as ApplicationLayer from "./layer.ts";

const platformLayer = Layer.merge(BunFileSystem.layer, BunPath.layer);
const uuidV7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const missingWorkspaceId = Workspace.WorkspaceId.make("018f47a0-0000-7000-8000-000000000099");

const assertApplicationError = (error: ApplicationError, message: string) => {
  assert.instanceOf(error, ApplicationError);
  assert.strictEqual(error.message, message);
};

describe("Application", () => {
  it.effect("creates regular and worktree chats after their sessions", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const temporaryDirectory = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "pico-application-",
      });
      const storeFile = AbsolutePath.make(path.join(temporaryDirectory, "store.db"));
      const defaultCwd = AbsolutePath.make(path.join(temporaryDirectory, "workspace"));
      const worktreeCwd = AbsolutePath.make(path.join(temporaryDirectory, "worktree"));
      const createdSessions: Array<CreateAgentSession> = [];
      const createdWorktrees: Array<CreateWorktreeOptions> = [];
      const persistenceLayer = Persistence.layer(storeFile);
      const sessionsLayer = Layer.effect(
        AgentSessionStore,
        Effect.gen(function* () {
          const chats = yield* ChatRepository;
          return AgentSessionStore.of({
            create: (input) =>
              Effect.gen(function* () {
                assert.isTrue(
                  Option.isNone(yield* chats.findById(input.chatId).pipe(Effect.orDie)),
                );
                createdSessions.push(input);
              }),
          });
        }),
      ).pipe(Layer.provide(persistenceLayer));
      const createWorktree: CreateWorktree = (options, use) =>
        Effect.sync(() => {
          createdWorktrees.push(options);
        }).pipe(Effect.andThen(use(worktreeCwd)));

      yield* Effect.gen(function* () {
        const application = yield* Application;

        yield* TestClock.setTime(1_000);
        const regularWorkspace = yield* application.createWorkspace({
          name: "regular",
          binding: null,
          defaultCwd,
          worktree: null,
        });

        yield* TestClock.setTime(2_000);
        const regularChat = yield* application.createChat({
          workspaceId: regularWorkspace.id,
          externalId: null,
        });
        assert.match(regularChat.id, uuidV7);
        assert.strictEqual(regularChat.cwd, defaultCwd);
        assert.strictEqual(regularChat.createdAt, 2_000);
        assert.strictEqual(regularChat.archivedAt, null);
        assert.deepStrictEqual(createdSessions[0], {
          chatId: regularChat.id,
          cwd: defaultCwd,
        });

        yield* TestClock.setTime(3_000);
        const worktreeWorkspace = yield* application.createWorkspace({
          name: "worktree",
          binding: null,
          defaultCwd,
          worktree: { branch: "main", prefix: "chat/" },
        });

        yield* TestClock.setTime(4_000);
        const worktreeChat = yield* application.createChat({
          workspaceId: worktreeWorkspace.id,
          externalId: null,
        });
        assert.match(worktreeChat.id, uuidV7);
        assert.strictEqual(worktreeChat.cwd, worktreeCwd);
        assert.strictEqual(worktreeChat.createdAt, 4_000);
        assert.deepStrictEqual(createdWorktrees, [
          {
            chatId: worktreeChat.id,
            repositoryCwd: defaultCwd,
            settings: { branch: "main", prefix: "chat/" },
          },
        ]);
        assert.deepStrictEqual(createdSessions[1], {
          chatId: worktreeChat.id,
          cwd: worktreeCwd,
        });

        assertApplicationError(
          yield* application
            .createChat({ workspaceId: missingWorkspaceId, externalId: null })
            .pipe(Effect.flip),
          "Failed to create chat",
        );
        assert.strictEqual(createdSessions.length, 2);
        assert.strictEqual(createdWorktrees.length, 1);
      }).pipe(
        Effect.provide(ApplicationLayer.layer(createWorktree)),
        Effect.provide(sessionsLayer),
        Effect.provide(persistenceLayer),
        Effect.provide(BunCrypto.layer),
        Effect.scoped,
      );
    }).pipe(Effect.provide(platformLayer)),
  );
});
