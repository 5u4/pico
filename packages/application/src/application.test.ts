import * as BunCrypto from "@effect/platform-bun/BunCrypto";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import * as BunPath from "@effect/platform-bun/BunPath";
import { assert, describe, it } from "@effect/vitest";
import type * as AgentMessage from "@pico/contract/agent-message";
import { AgentRuntime } from "@pico/contract/agent-runtime";
import { AgentSessionStore, type CreateAgentSession } from "@pico/contract/agent-session-store";
import { Application } from "@pico/contract/application";
import * as Chat from "@pico/contract/chat-model";
import { ChatRepository } from "@pico/contract/chat-repository";
import { AgentError, ApplicationError, WorkspaceCwdInvalid } from "@pico/contract/errors";
import { AbsolutePath } from "@pico/contract/path";
import * as Workspace from "@pico/contract/workspace-model";
import { WorkspaceRepository } from "@pico/contract/workspace-repository";
import type { CreateWorktree, CreateWorktreeOptions } from "@pico/contract/worktree";
import * as Persistence from "@pico/persistence/layer";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as ApplicationLayer from "./application.ts";

const platformLayer = Layer.merge(BunFileSystem.layer, BunPath.layer);
const uuidV7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const missingWorkspaceId = Workspace.WorkspaceId.make("018f47a0-0000-7000-8000-000000000099");
const missingChatId = Chat.ChatId.make("018f47a0-0000-7000-8000-000000000098");
const runtimeTranscript: AgentMessage.AgentTranscript = [
  {
    role: "user",
    content: [{ type: "text", text: "hello" }],
    timestamp: 7,
  },
];

const assertApplicationError = (error: ApplicationError, message: string) => {
  assert.instanceOf(error, ApplicationError);
  assert.strictEqual(error.message, message);
};

describe("Application", () => {
  it.effect("creates chats, resolves platform identities, and delegates agent operations", () =>
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
      const sentMessages: Array<{ readonly chatId: string; readonly content: string }> = [];
      const transcriptChatIds: Array<Chat.ChatId> = [];
      const abortedChatIds: Array<Chat.ChatId> = [];
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
      const runtimeLayer = Layer.succeed(
        AgentRuntime,
        AgentRuntime.of({
          events: Stream.empty,
          transcript: (chatId) =>
            Effect.sync(() => {
              transcriptChatIds.push(chatId);
            }).pipe(
              Effect.andThen(
                chatId === missingChatId
                  ? Effect.fail(new AgentError({ message: "runtime failed" }))
                  : Effect.succeed(runtimeTranscript),
              ),
            ),
          send: (chatId, content) =>
            content === "fail"
              ? Effect.fail(new AgentError({ message: "runtime failed" }))
              : Effect.sync(() => {
                  sentMessages.push({ chatId, content });
                }),
          abort: (chatId) =>
            Effect.sync(() => {
              abortedChatIds.push(chatId);
            }).pipe(
              Effect.andThen(
                chatId === missingChatId
                  ? Effect.fail(new AgentError({ message: "runtime failed" }))
                  : Effect.void,
              ),
            ),
        }),
      );
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

        yield* TestClock.setTime(5_000);
        const discordWorkspace = yield* application.createWorkspace({
          name: "discord",
          binding: { platform: "discord", externalId: "channel-1" },
          defaultCwd,
          worktree: null,
        });
        yield* TestClock.setTime(6_000);
        const discordChat = yield* application.createChat({
          workspaceId: discordWorkspace.id,
          externalId: "thread-1",
        });

        assert.deepStrictEqual(
          Option.getOrThrow(yield* application.findWorkspaceByPlatformId("discord", "channel-1")),
          discordWorkspace,
        );
        assert.isTrue(
          Option.isNone(yield* application.findWorkspaceByPlatformId("discord", "missing")),
        );
        assert.deepStrictEqual(
          Option.getOrThrow(
            yield* application.findChatByPlatformId("discord", "channel-1", "thread-1"),
          ),
          discordChat,
        );
        assert.isTrue(
          Option.isNone(yield* application.findChatByPlatformId("discord", "channel-1", "missing")),
        );
        assert.isTrue(
          Option.isNone(yield* application.findChatByPlatformId("discord", "missing", "thread-1")),
        );

        assert.deepStrictEqual(yield* application.transcript(discordChat.id), runtimeTranscript);
        assert.deepStrictEqual(transcriptChatIds, [discordChat.id]);
        assertApplicationError(
          yield* application.transcript(missingChatId).pipe(Effect.flip),
          "Failed to read transcript",
        );
        assert.deepStrictEqual(transcriptChatIds, [discordChat.id, missingChatId]);

        yield* application.sendMessage(discordChat.id, "hello");
        yield* application.sendMessage(discordChat.id, "");
        assert.deepStrictEqual(sentMessages, [
          { chatId: discordChat.id, content: "hello" },
          { chatId: discordChat.id, content: "" },
        ]);
        assertApplicationError(
          yield* application.sendMessage(discordChat.id, "fail").pipe(Effect.flip),
          "Failed to send message",
        );
        yield* application.abort(discordChat.id);
        assert.deepStrictEqual(abortedChatIds, [discordChat.id]);
        assertApplicationError(
          yield* application.abort(missingChatId).pipe(Effect.flip),
          "Failed to abort chat",
        );
        assert.deepStrictEqual(abortedChatIds, [discordChat.id, missingChatId]);

        assertApplicationError(
          yield* application
            .createChat({ workspaceId: missingWorkspaceId, externalId: null })
            .pipe(Effect.flip),
          "Failed to create chat",
        );
        assert.strictEqual(createdSessions.length, 3);
        assert.strictEqual(createdWorktrees.length, 1);
      }).pipe(
        Effect.provide(ApplicationLayer.layer(createWorktree)),
        Effect.provide(sessionsLayer),
        Effect.provide(persistenceLayer),
        Effect.provide(runtimeLayer),
        Effect.provide(BunCrypto.layer),
        Effect.scoped,
      );
    }).pipe(Effect.provide(platformLayer)),
  );

  it.effect("validates and binds workspace cwd without rewriting existing chats", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const temporaryDirectory = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "pico-application-bind-",
      });
      const storeFile = AbsolutePath.make(path.join(temporaryDirectory, "store.db"));
      const firstCwd = path.join(temporaryDirectory, "first");
      const secondCwd = path.join(temporaryDirectory, "second");
      const unreadableCwd = path.join(temporaryDirectory, "unreadable");
      const file = path.join(temporaryDirectory, "file");
      yield* fileSystem.makeDirectory(firstCwd);
      yield* fileSystem.makeDirectory(secondCwd);
      yield* fileSystem.makeDirectory(unreadableCwd);
      yield* fileSystem.writeFileString(file, "fixture");
      const applicationFileSystem = FileSystem.FileSystem.of({
        ...fileSystem,
        access: (candidate, options) =>
          candidate === unreadableCwd
            ? Effect.fail(
                new PlatformError.PlatformError(
                  new PlatformError.SystemError({
                    _tag: "PermissionDenied",
                    module: "FileSystem",
                    method: "access",
                    pathOrDescriptor: candidate,
                  }),
                ),
              )
            : fileSystem.access(candidate, options),
      });
      const applicationFileSystemLayer = Layer.succeed(
        FileSystem.FileSystem,
        applicationFileSystem,
      );

      const persistenceLayer = Persistence.layer(storeFile);
      let cwdChanges = 0;
      const observedWorkspaces = Layer.effect(
        WorkspaceRepository,
        Effect.gen(function* () {
          const repository = yield* WorkspaceRepository;
          return WorkspaceRepository.of({
            ...repository,
            changeDefaultCwd: (workspaceId, cwd) =>
              Effect.sync(() => {
                cwdChanges += 1;
              }).pipe(Effect.andThen(repository.changeDefaultCwd(workspaceId, cwd))),
          });
        }),
      ).pipe(Layer.provide(persistenceLayer));
      const repositories = Layer.merge(persistenceLayer, observedWorkspaces);
      const createdSessions: Array<CreateAgentSession> = [];
      const sessionsLayer = Layer.succeed(
        AgentSessionStore,
        AgentSessionStore.of({
          create: (input) =>
            Effect.sync(() => {
              createdSessions.push(input);
            }),
        }),
      );
      const runtimeLayer = Layer.succeed(
        AgentRuntime,
        AgentRuntime.of({
          events: Stream.empty,
          transcript: () => Effect.die("unexpected transcript read"),
          send: () => Effect.die("unexpected runtime send"),
          abort: () => Effect.die("unexpected runtime abort"),
        }),
      );
      const createWorktree: CreateWorktree = () => Effect.die("unexpected worktree creation");

      yield* Effect.gen(function* () {
        const application = yield* Application;
        const chats = yield* ChatRepository;
        const binding = { platform: "discord", externalId: "channel-1" } as const;

        const created = yield* application.bindWorkspace({
          binding,
          workspaceName: "general",
          cwd: `${firstCwd}/.`,
        });
        assert.strictEqual(created.name, "general");
        assert.strictEqual(created.defaultCwd, firstCwd);
        assert.strictEqual(cwdChanges, 0);

        const oldChat = yield* application.createChat({
          workspaceId: created.id,
          externalId: "thread-old",
        });
        const repeated = yield* application.bindWorkspace({
          binding,
          workspaceName: "ignored rename",
          cwd: `${firstCwd}/.`,
        });
        assert.deepStrictEqual(repeated, created);
        assert.strictEqual(cwdChanges, 0);

        const rebound = yield* application.bindWorkspace({
          binding,
          workspaceName: "still ignored",
          cwd: `${temporaryDirectory}/first/../second`,
        });
        assert.strictEqual(rebound.name, "general");
        assert.strictEqual(rebound.defaultCwd, secondCwd);
        assert.strictEqual(cwdChanges, 1);

        const newChat = yield* application.createChat({
          workspaceId: created.id,
          externalId: "thread-new",
        });
        assert.strictEqual(oldChat.cwd, firstCwd);
        assert.strictEqual(
          Option.getOrThrow(yield* chats.findById(oldChat.id).pipe(Effect.orDie)).cwd,
          firstCwd,
        );
        assert.strictEqual(newChat.cwd, secondCwd);
        assert.deepStrictEqual(
          createdSessions.map(({ cwd }) => cwd),
          [firstCwd, secondCwd],
        );

        const invalidInputs = [
          { externalId: "whitespace", cwd: ` ${firstCwd}`, reason: "surrounding-whitespace" },
          { externalId: "relative", cwd: "relative/project", reason: "not-absolute" },
          { externalId: "home", cwd: "~/project", reason: "not-absolute" },
          {
            externalId: "missing",
            cwd: path.join(temporaryDirectory, "missing"),
            reason: "not-found",
          },
          { externalId: "file", cwd: file, reason: "not-directory" },
        ] as const;
        for (const input of invalidInputs) {
          const error = yield* application
            .bindWorkspace({
              binding: { platform: "discord", externalId: input.externalId },
              workspaceName: input.externalId,
              cwd: input.cwd,
            })
            .pipe(Effect.flip);
          if (!(error instanceof WorkspaceCwdInvalid)) {
            return yield* Effect.die(`Unexpected bind failure: ${error._tag}`);
          }
          assert.strictEqual(error.reason, input.reason);
          assert.isTrue(
            Option.isNone(
              yield* application.findWorkspaceByPlatformId("discord", input.externalId),
            ),
          );
        }

        const unreadable = yield* application
          .bindWorkspace({
            binding: { platform: "discord", externalId: "unreadable" },
            workspaceName: "unreadable",
            cwd: unreadableCwd,
          })
          .pipe(Effect.flip);
        if (!(unreadable instanceof WorkspaceCwdInvalid)) {
          return yield* Effect.die(`Unexpected bind failure: ${unreadable._tag}`);
        }
        assert.strictEqual(unreadable.reason, "unreadable");
        assert.isTrue(
          Option.isNone(yield* application.findWorkspaceByPlatformId("discord", "unreadable")),
        );
      }).pipe(
        Effect.provide(ApplicationLayer.layer(createWorktree)),
        Effect.provide(applicationFileSystemLayer),
        Effect.provide(repositories),
        Effect.provide(sessionsLayer),
        Effect.provide(runtimeLayer),
        Effect.provide(BunCrypto.layer),
        Effect.scoped,
      );
    }).pipe(Effect.provide(platformLayer)),
  );
});
