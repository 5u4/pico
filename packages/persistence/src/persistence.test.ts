import { Database } from "bun:sqlite";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import * as BunPath from "@effect/platform-bun/BunPath";
import { assert, describe, it } from "@effect/vitest";
import * as Chat from "@pico/contract/chat";
import { AbsolutePath } from "@pico/contract/config/path";
import { PersistenceError } from "@pico/contract/persistence/error";
import * as Workspace from "@pico/contract/workspace";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { layer } from "./layer.ts";

const platformLayer = Layer.merge(BunFileSystem.layer, BunPath.layer);

const regularWorkspaceId = Workspace.WorkspaceId.make("018f47a0-0000-7000-8000-000000000001");
const secondWorkspaceId = Workspace.WorkspaceId.make("018f47a0-0000-7000-8000-000000000002");
const worktreeWorkspaceId = Workspace.WorkspaceId.make("018f47a0-0000-7000-8000-000000000003");
const missingWorkspaceId = Workspace.WorkspaceId.make("018f47a0-0000-7000-8000-000000000099");
const missingChatId = Chat.ChatId.make("018f47a0-0000-7000-8000-000000000199");

const chatId = (value: number) =>
  Chat.ChatId.make(`018f47a0-0000-7000-8000-${value.toString().padStart(12, "0")}`);

const cwdA = AbsolutePath.make("/tmp/pico/a");
const cwdB = AbsolutePath.make("/tmp/pico/b");
const worktreeCwd = AbsolutePath.make("/tmp/pico/worktrees/chat");

const regularWorkspace: Workspace.Workspace = {
  id: regularWorkspaceId,
  name: "regular",
  binding: null,
  defaultCwd: cwdA,
  worktree: null,
  createdAt: 1,
};

const secondWorkspace: Workspace.Workspace = {
  id: secondWorkspaceId,
  name: "second",
  binding: null,
  defaultCwd: cwdA,
  worktree: null,
  createdAt: 2,
};

const worktreeWorkspace: Workspace.Workspace = {
  id: worktreeWorkspaceId,
  name: "worktree",
  binding: { platform: "discord", externalId: "channel-1" },
  defaultCwd: cwdA,
  worktree: { branch: "main", prefix: "chat/" },
  createdAt: 3,
};

describe("Persistence.layer", () => {
  it.effect("persists workspace and chat metadata with enforced modes and identities", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const temporaryDirectory = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "pico-persistence-",
      });
      const storeFile = AbsolutePath.make(path.join(temporaryDirectory, "store.db"));

      yield* Effect.gen(function* () {
        const workspaces = yield* Workspace.WorkspaceRepository;
        const chats = yield* Chat.ChatRepository;

        assert.deepStrictEqual(yield* workspaces.create(regularWorkspace), regularWorkspace);
        assert.deepStrictEqual(yield* workspaces.create(secondWorkspace), secondWorkspace);
        assert.deepStrictEqual(yield* workspaces.create(worktreeWorkspace), worktreeWorkspace);
        assert.deepStrictEqual(
          Option.getOrThrow(yield* workspaces.findById(worktreeWorkspaceId)),
          worktreeWorkspace,
        );
        assert.isTrue(Option.isNone(yield* workspaces.findById(missingWorkspaceId)));
        assert.isTrue(Option.isNone(yield* chats.findById(missingChatId)));

        const duplicateBinding: Workspace.Workspace = {
          ...worktreeWorkspace,
          id: Workspace.WorkspaceId.make("018f47a0-0000-7000-8000-000000000004"),
          name: "duplicate binding",
        };
        assert.instanceOf(
          yield* Effect.flip(workspaces.create(duplicateBinding)),
          PersistenceError,
        );
        assert.instanceOf(
          yield* Effect.flip(workspaces.create(regularWorkspace)),
          PersistenceError,
        );
        assert.instanceOf(
          yield* Effect.flip(workspaces.changeDefaultCwd(missingWorkspaceId, cwdB)),
          PersistenceError,
        );

        const firstRegular = yield* chats.createRegular({
          id: chatId(1),
          workspaceId: regularWorkspaceId,
          externalId: null,
          createdAt: 10,
        });
        assert.strictEqual(firstRegular.cwd, cwdA);

        const changed = yield* workspaces.changeDefaultCwd(regularWorkspaceId, cwdB);
        assert.strictEqual(changed.defaultCwd, cwdB);

        const secondRegular = yield* chats.createRegular({
          id: chatId(2),
          workspaceId: regularWorkspaceId,
          externalId: null,
          createdAt: 11,
        });
        assert.strictEqual(secondRegular.cwd, cwdB);
        assert.strictEqual(Option.getOrThrow(yield* chats.findById(firstRegular.id)).cwd, cwdA);
        assert.strictEqual(Option.getOrThrow(yield* chats.findById(secondRegular.id)).cwd, cwdB);

        const explicit = yield* chats.createWorktree({
          id: chatId(3),
          workspaceId: worktreeWorkspaceId,
          cwd: worktreeCwd,
          externalId: null,
          createdAt: 12,
        });
        assert.strictEqual(explicit.cwd, worktreeCwd);
        assert.deepStrictEqual(Option.getOrThrow(yield* chats.findById(explicit.id)), explicit);

        assert.instanceOf(
          yield* Effect.flip(
            chats.createRegular({
              id: chatId(4),
              workspaceId: worktreeWorkspaceId,
              externalId: null,
              createdAt: 13,
            }),
          ),
          PersistenceError,
        );
        assert.instanceOf(
          yield* Effect.flip(
            chats.createWorktree({
              id: chatId(5),
              workspaceId: regularWorkspaceId,
              cwd: worktreeCwd,
              externalId: null,
              createdAt: 14,
            }),
          ),
          PersistenceError,
        );
        assert.instanceOf(
          yield* Effect.flip(
            chats.createWorktree({
              id: chatId(6),
              workspaceId: missingWorkspaceId,
              cwd: worktreeCwd,
              externalId: null,
              createdAt: 15,
            }),
          ),
          PersistenceError,
        );

        yield* chats.createRegular({
          id: chatId(7),
          workspaceId: regularWorkspaceId,
          externalId: "thread-1",
          createdAt: 16,
        });
        assert.instanceOf(
          yield* Effect.flip(
            chats.createRegular({
              id: chatId(8),
              workspaceId: regularWorkspaceId,
              externalId: "thread-1",
              createdAt: 17,
            }),
          ),
          PersistenceError,
        );
        yield* chats.createRegular({
          id: chatId(9),
          workspaceId: secondWorkspaceId,
          externalId: "thread-1",
          createdAt: 18,
        });
      }).pipe(Effect.provide(layer(storeFile)), Effect.scoped);

      yield* Effect.sync(() => {
        const database = new Database(storeFile);
        try {
          database.exec("PRAGMA foreign_keys = ON");
          assert.throws(() =>
            database.query("DELETE FROM workspaces WHERE id = ?").run(regularWorkspaceId),
          );
        } finally {
          database.close();
        }
      });

      yield* Effect.gen(function* () {
        const workspaces = yield* Workspace.WorkspaceRepository;
        const chats = yield* Chat.ChatRepository;
        assert.strictEqual(
          Option.getOrThrow(yield* workspaces.findById(regularWorkspaceId)).defaultCwd,
          cwdB,
        );
        assert.strictEqual(Option.getOrThrow(yield* chats.findById(chatId(1))).cwd, cwdA);
      }).pipe(Effect.provide(layer(storeFile)), Effect.scoped);
    }).pipe(Effect.provide(platformLayer)),
  );
});
