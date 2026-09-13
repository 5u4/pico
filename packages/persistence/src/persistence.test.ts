import { Database } from "bun:sqlite";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import * as BunPath from "@effect/platform-bun/BunPath";
import { assert, describe, it } from "@effect/vitest";
import * as Chat from "@pico/contract/chat-model";
import { ChatRepository } from "@pico/contract/chat-repository";
import { PersistenceError } from "@pico/contract/errors";
import { AbsolutePath } from "@pico/contract/path";
import * as Workspace from "@pico/contract/workspace-model";
import { WorkspaceRepository } from "@pico/contract/workspace-repository";
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
  it.effect("lists root-scoped workspaces and only their open chats in stable creation order", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const temporaryDirectory = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "pico-persistence-lists-",
      });
      const storeFile = AbsolutePath.make(path.join(temporaryDirectory, "store.db"));
      const otherStoreFile = AbsolutePath.make(path.join(temporaryDirectory, "other.db"));
      const tiedWorkspace = { ...secondWorkspace, createdAt: worktreeWorkspace.createdAt };

      yield* Effect.gen(function* () {
        const workspaces = yield* WorkspaceRepository;
        const chats = yield* ChatRepository;
        yield* workspaces.create(tiedWorkspace);
        yield* workspaces.create(regularWorkspace);
        yield* workspaces.create(worktreeWorkspace);
        assert.deepStrictEqual(yield* workspaces.list(), [
          worktreeWorkspace,
          tiedWorkspace,
          regularWorkspace,
        ]);

        const older = yield* chats.create({
          id: chatId(1),
          workspaceId: regularWorkspaceId,
          cwd: cwdA,
          externalId: null,
          createdAt: 10,
        });
        const tied = yield* chats.create({
          id: chatId(2),
          workspaceId: regularWorkspaceId,
          cwd: cwdA,
          externalId: null,
          createdAt: 10,
        });
        const archived = yield* chats.create({
          id: chatId(3),
          workspaceId: regularWorkspaceId,
          cwd: cwdA,
          externalId: null,
          createdAt: 20,
        });
        const foreign = yield* chats.create({
          id: chatId(4),
          workspaceId: worktreeWorkspaceId,
          cwd: worktreeCwd,
          externalId: "thread-1",
          createdAt: 30,
        });
        const newest = yield* chats.create({
          id: chatId(5),
          workspaceId: regularWorkspaceId,
          cwd: cwdB,
          externalId: null,
          createdAt: 11,
        });
        yield* chats.archive(archived.id, 40);
        assert.deepStrictEqual(yield* chats.listOpenByWorkspace(regularWorkspaceId), [
          newest,
          tied,
          older,
        ]);
        assert.deepStrictEqual(yield* chats.listOpenByWorkspace(worktreeWorkspaceId), [foreign]);
        assert.deepStrictEqual(yield* chats.listOpenByWorkspace(secondWorkspaceId), []);
      }).pipe(Effect.provide(layer(storeFile)), Effect.scoped);

      yield* Effect.gen(function* () {
        const workspaces = yield* WorkspaceRepository;
        const chats = yield* ChatRepository;
        const otherWorkspace = { ...regularWorkspace, name: "other root" };
        yield* workspaces.create(otherWorkspace);
        assert.deepStrictEqual(yield* workspaces.list(), [otherWorkspace]);
        assert.deepStrictEqual(yield* chats.listOpenByWorkspace(regularWorkspaceId), []);
      }).pipe(Effect.provide(layer(otherStoreFile)), Effect.scoped);

      yield* Effect.gen(function* () {
        const workspaces = yield* WorkspaceRepository;
        assert.deepStrictEqual(yield* workspaces.list(), [
          worktreeWorkspace,
          tiedWorkspace,
          regularWorkspace,
        ]);
      }).pipe(Effect.provide(layer(storeFile)), Effect.scoped);
    }).pipe(Effect.provide(platformLayer)),
  );

  it.effect(
    "concurrent binding creation keeps one identity and never overwrites its configuration",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const temporaryDirectory = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "pico-persistence-binding-",
        });
        const storeFile = AbsolutePath.make(path.join(temporaryDirectory, "store.db"));
        const binding = Workspace.WorkspaceBinding.make({
          platform: "discord",
          externalId: "concurrent-channel",
        });
        const firstCandidate = { ...regularWorkspace, binding };
        const secondCandidate = {
          ...worktreeWorkspace,
          binding,
          defaultCwd: cwdB,
        };

        const configured = yield* Effect.gen(function* () {
          const workspaces = yield* WorkspaceRepository;
          const [first, second] = yield* Effect.all(
            [
              workspaces.getOrCreateByBinding(firstCandidate),
              workspaces.getOrCreateByBinding(secondCandidate),
            ],
            { concurrency: "unbounded" },
          );
          assert.deepStrictEqual(first, second);
          const winner = first.id === firstCandidate.id ? firstCandidate : secondCandidate;
          const loser = first.id === firstCandidate.id ? secondCandidate : firstCandidate;
          assert.deepStrictEqual(first, winner);
          assert.deepStrictEqual(
            Option.getOrThrow(yield* workspaces.findByBinding(binding)),
            winner,
          );
          assert.isTrue(Option.isNone(yield* workspaces.findById(loser.id)));

          const changed = yield* workspaces.replaceConfiguration(first.id, {
            defaultCwd: cwdB,
            worktree: { branch: "release", prefix: "bound/" },
          });
          assert.deepStrictEqual(
            yield* workspaces.getOrCreateByBinding({
              ...loser,
              name: "must not rename",
              createdAt: 999,
              defaultCwd: cwdA,
              worktree: null,
            }),
            changed,
          );
          assert.instanceOf(
            yield* Effect.flip(
              workspaces.getOrCreateByBinding({
                ...winner,
                binding: { platform: "discord", externalId: "different-channel" },
              }),
            ),
            PersistenceError,
          );
          return changed;
        }).pipe(Effect.provide(layer(storeFile)), Effect.scoped);

        yield* Effect.gen(function* () {
          const workspaces = yield* WorkspaceRepository;
          assert.deepStrictEqual(
            Option.getOrThrow(yield* workspaces.findByBinding(binding)),
            configured,
          );
        }).pipe(Effect.provide(layer(storeFile)), Effect.scoped);
      }).pipe(Effect.provide(platformLayer)),
  );

  it.effect("persists workspace and chat metadata with foreign keys and identities", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const temporaryDirectory = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "pico-persistence-",
      });
      const storeFile = AbsolutePath.make(path.join(temporaryDirectory, "store.db"));

      yield* Effect.gen(function* () {
        const workspaces = yield* WorkspaceRepository;
        const chats = yield* ChatRepository;

        assert.deepStrictEqual(yield* workspaces.create(regularWorkspace), regularWorkspace);
        assert.deepStrictEqual(yield* workspaces.create(secondWorkspace), secondWorkspace);
        assert.deepStrictEqual(yield* workspaces.create(worktreeWorkspace), worktreeWorkspace);
        assert.deepStrictEqual(
          Option.getOrThrow(yield* workspaces.findById(worktreeWorkspaceId)),
          worktreeWorkspace,
        );
        assert.deepStrictEqual(
          Option.getOrThrow(
            yield* workspaces.findByBinding({ platform: "discord", externalId: "channel-1" }),
          ),
          worktreeWorkspace,
        );
        assert.isTrue(
          Option.isNone(
            yield* workspaces.findByBinding({ platform: "discord", externalId: "missing" }),
          ),
        );
        assert.isTrue(Option.isNone(yield* workspaces.findById(missingWorkspaceId)));
        assert.isTrue(Option.isNone(yield* chats.findById(missingChatId)));

        const duplicateBinding: Workspace.Workspace = {
          ...worktreeWorkspace,
          id: Workspace.WorkspaceId.make("018f47a0-0000-7000-8000-000000000004"),
          name: "duplicate binding",
        };
        const duplicate = yield* Effect.flip(workspaces.create(duplicateBinding));
        assert.instanceOf(duplicate, PersistenceError);
        assert.include(duplicate.message, "workspace.create");
        assert.include(duplicate.message, "UniqueViolation");
        assert.match(duplicate.message, /SQLite code \d+/);
        assert.notInclude(duplicate.message, "channel-1");
        assert.notInclude(duplicate.message, duplicateBinding.name);
        assert.instanceOf(
          yield* Effect.flip(workspaces.create(regularWorkspace)),
          PersistenceError,
        );
        const missing = yield* Effect.flip(
          workspaces.replaceConfiguration(missingWorkspaceId, {
            defaultCwd: cwdB,
            worktree: null,
          }),
        );
        assert.instanceOf(missing, PersistenceError);
        assert.include(missing.message, "workspace.replaceConfiguration");
        assert.include(missing.message, "required row missing");

        const firstRegular = yield* chats.create({
          id: chatId(1),
          workspaceId: regularWorkspaceId,
          cwd: cwdA,
          externalId: null,
          createdAt: 10,
        });
        assert.strictEqual(firstRegular.cwd, cwdA);

        const changed = yield* workspaces.replaceConfiguration(regularWorkspaceId, {
          defaultCwd: cwdB,
          worktree: { branch: "release", prefix: "bound/" },
        });
        assert.deepStrictEqual(changed, {
          ...regularWorkspace,
          defaultCwd: cwdB,
          worktree: { branch: "release", prefix: "bound/" },
        });
        assert.deepStrictEqual(
          Option.getOrThrow(yield* workspaces.findById(regularWorkspaceId)),
          changed,
        );

        const direct = yield* workspaces.replaceConfiguration(regularWorkspaceId, {
          defaultCwd: cwdB,
          worktree: null,
        });
        assert.deepStrictEqual(direct, { ...regularWorkspace, defaultCwd: cwdB });

        const staleDefaultCwd = yield* chats.create({
          id: chatId(10),
          workspaceId: regularWorkspaceId,
          cwd: cwdA,
          externalId: null,
          createdAt: 11,
        });
        assert.strictEqual(staleDefaultCwd.cwd, cwdA);

        const secondRegular = yield* chats.create({
          id: chatId(2),
          workspaceId: regularWorkspaceId,
          cwd: cwdB,
          externalId: null,
          createdAt: 11,
        });
        assert.strictEqual(secondRegular.cwd, cwdB);
        assert.strictEqual(Option.getOrThrow(yield* chats.findById(firstRegular.id)).cwd, cwdA);
        assert.strictEqual(Option.getOrThrow(yield* chats.findById(secondRegular.id)).cwd, cwdB);

        const explicit = yield* chats.create({
          id: chatId(3),
          workspaceId: worktreeWorkspaceId,
          cwd: worktreeCwd,
          externalId: null,
          createdAt: 12,
        });
        assert.strictEqual(explicit.cwd, worktreeCwd);
        assert.deepStrictEqual(Option.getOrThrow(yield* chats.findById(explicit.id)), explicit);
        const archived = Option.getOrThrow(yield* chats.archive(explicit.id, 100));
        assert.strictEqual(archived.archivedAt, 100);
        const archivedAgain = Option.getOrThrow(yield* chats.archive(explicit.id, 200));
        assert.strictEqual(archivedAgain.archivedAt, 100);
        assert.strictEqual(Option.getOrThrow(yield* chats.findById(explicit.id)).archivedAt, 100);
        assert.isTrue(Option.isNone(yield* chats.archive(missingChatId, 100)));

        const regularCwdInWorktreeWorkspace = yield* chats.create({
          id: chatId(4),
          workspaceId: worktreeWorkspaceId,
          cwd: cwdA,
          externalId: null,
          createdAt: 13,
        });
        assert.strictEqual(regularCwdInWorktreeWorkspace.cwd, cwdA);

        const worktreeCwdInRegularWorkspace = yield* chats.create({
          id: chatId(5),
          workspaceId: regularWorkspaceId,
          cwd: worktreeCwd,
          externalId: null,
          createdAt: 14,
        });
        assert.strictEqual(worktreeCwdInRegularWorkspace.cwd, worktreeCwd);
        const foreignKey = yield* Effect.flip(
          chats.create({
            id: chatId(6),
            workspaceId: missingWorkspaceId,
            cwd: worktreeCwd,
            externalId: null,
            createdAt: 15,
          }),
        );
        assert.instanceOf(foreignKey, PersistenceError);
        assert.include(foreignKey.message, "chat.create");
        assert.include(foreignKey.message, "ConstraintError");
        assert.match(foreignKey.message, /SQLite code \d+/);
        assert.notInclude(foreignKey.message, worktreeCwd);

        const externalChat = yield* chats.create({
          id: chatId(7),
          workspaceId: regularWorkspaceId,
          cwd: cwdB,
          externalId: "thread-1",
          createdAt: 16,
        });
        assert.deepStrictEqual(
          Option.getOrThrow(yield* chats.findByExternalId(regularWorkspaceId, "thread-1")),
          externalChat,
        );
        assert.isTrue(Option.isNone(yield* chats.findByExternalId(regularWorkspaceId, "missing")));
        assert.instanceOf(
          yield* Effect.flip(
            chats.create({
              id: chatId(8),
              workspaceId: regularWorkspaceId,
              cwd: cwdB,
              externalId: "thread-1",
              createdAt: 17,
            }),
          ),
          PersistenceError,
        );
        const secondExternalChat = yield* chats.create({
          id: chatId(9),
          workspaceId: secondWorkspaceId,
          cwd: cwdA,
          externalId: "thread-1",
          createdAt: 18,
        });
        assert.deepStrictEqual(
          Option.getOrThrow(yield* chats.findByExternalId(secondWorkspaceId, "thread-1")),
          secondExternalChat,
        );
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
        const workspaces = yield* WorkspaceRepository;
        const chats = yield* ChatRepository;
        assert.strictEqual(
          Option.getOrThrow(yield* workspaces.findById(regularWorkspaceId)).defaultCwd,
          cwdB,
        );
        assert.strictEqual(Option.getOrThrow(yield* chats.findById(chatId(1))).cwd, cwdA);
        assert.strictEqual(Option.getOrThrow(yield* chats.findById(chatId(3))).archivedAt, 100);
        assert.deepStrictEqual(
          Option.getOrThrow(
            yield* workspaces.findByBinding({ platform: "discord", externalId: "channel-1" }),
          ),
          worktreeWorkspace,
        );
        assert.deepStrictEqual(
          Option.getOrThrow(yield* chats.findByExternalId(regularWorkspaceId, "thread-1")),
          {
            id: chatId(7),
            workspaceId: regularWorkspaceId,
            cwd: cwdB,
            externalId: "thread-1",
            createdAt: 16,
            archivedAt: null,
          },
        );
      }).pipe(Effect.provide(layer(storeFile)), Effect.scoped);
    }).pipe(Effect.provide(platformLayer)),
  );

  it.effect("reports a safe connection failure when the store path is a directory", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const directory = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "pico-persistence-open-",
      });
      const error = yield* Effect.void.pipe(
        Effect.provide(layer(AbsolutePath.make(directory))),
        Effect.scoped,
        Effect.flip,
      );
      assert.instanceOf(error, PersistenceError);
      assert.include(error.message, "persistence.open");
      assert.include(error.message, "ConnectionError");
      assert.notInclude(error.message, directory);
    }).pipe(Effect.provide(platformLayer)),
  );

  it.effect("preserves safe migration failure context from a migration defect", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "pico-persistence-migrate-",
      });
      const storeFile = AbsolutePath.make(path.join(directory, "store.db"));
      yield* Effect.sync(() => {
        const database = new Database(storeFile);
        try {
          database.exec("CREATE TABLE workspaces (private_column TEXT)");
        } finally {
          database.close();
        }
      });
      const error = yield* Effect.void.pipe(
        Effect.provide(layer(storeFile)),
        Effect.scoped,
        Effect.flip,
      );
      assert.instanceOf(error, PersistenceError);
      assert.include(error.message, "persistence.migrate");
      assert.include(error.message, "migration Failed");
      assert.match(error.message, /SQLite code \d+/);
      assert.notInclude(error.message, storeFile);
      assert.notInclude(error.message, "CREATE TABLE");
      assert.notInclude(error.message, "private_column");
    }).pipe(Effect.provide(platformLayer)),
  );

  it.effect("distinguishes invalid stored data without exposing the rejected row", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "pico-persistence-row-",
      });
      const storeFile = AbsolutePath.make(path.join(directory, "store.db"));
      yield* Effect.gen(function* () {
        const workspaces = yield* WorkspaceRepository;
        const chats = yield* ChatRepository;
        yield* workspaces.create(regularWorkspace);
        yield* chats.create({
          id: chatId(1),
          workspaceId: regularWorkspaceId,
          cwd: cwdA,
          externalId: null,
          createdAt: 1,
        });
      }).pipe(Effect.provide(layer(storeFile)), Effect.scoped);
      yield* Effect.sync(() => {
        const database = new Database(storeFile);
        try {
          database.exec("PRAGMA ignore_check_constraints = ON");
          database
            .query("UPDATE chats SET created_at = -1, cwd = ? WHERE id = ?")
            .run("private-relative-path", chatId(1));
          database
            .query("UPDATE workspaces SET external_id = ? WHERE id = ?")
            .run("private-external-id", regularWorkspaceId);
        } finally {
          database.close();
        }
      });
      yield* Effect.gen(function* () {
        const workspaces = yield* WorkspaceRepository;
        const chats = yield* ChatRepository;
        const chat = yield* chats.findById(chatId(1)).pipe(Effect.flip);
        assert.include(chat.message, "chat.findById");
        assert.include(chat.message, "invalid stored row");
        assert.notInclude(chat.message, "private-relative-path");
        const workspace = yield* workspaces.findById(regularWorkspaceId).pipe(Effect.flip);
        assert.include(workspace.message, "workspace.findById");
        assert.include(workspace.message, "binding column pair");
        assert.notInclude(workspace.message, "private-external-id");
      }).pipe(Effect.provide(layer(storeFile)), Effect.scoped);
    }).pipe(Effect.provide(platformLayer)),
  );
});
