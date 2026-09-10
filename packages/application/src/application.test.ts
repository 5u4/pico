import * as BunCrypto from "@effect/platform-bun/BunCrypto";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import * as BunPath from "@effect/platform-bun/BunPath";
import { assert, describe, it } from "@effect/vitest";
import type * as AgentMessage from "@pico/contract/agent-message";
import {
  AgentRuntime,
  type ContextUsage,
  type ShakeMode,
  type ShakeResult,
} from "@pico/contract/agent-runtime";
import { AgentSessionStore, type CreateAgentSession } from "@pico/contract/agent-session-store";
import { Application } from "@pico/contract/application";
import * as Chat from "@pico/contract/chat-model";
import { ChatRepository } from "@pico/contract/chat-repository";
import { AgentError, ApplicationError, WorkspaceBindingInvalid } from "@pico/contract/errors";
import { AbsolutePath } from "@pico/contract/path";
import * as Workspace from "@pico/contract/workspace-model";
import { WorkspaceRepository } from "@pico/contract/workspace-repository";
import type { CreateWorktreeOptions, GitWorktree } from "@pico/contract/worktree";
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
      yield* fileSystem.makeDirectory(defaultCwd);
      const createdSessions: Array<CreateAgentSession> = [];
      const createdWorktrees: Array<CreateWorktreeOptions> = [];
      const sentMessages: Array<{ readonly chatId: string; readonly content: string }> = [];
      const transcriptChatIds: Array<Chat.ChatId> = [];
      const abortedChatIds: Array<Chat.ChatId> = [];
      const shakeInputs: Array<{ readonly chatId: Chat.ChatId; readonly mode: ShakeMode }> = [];
      const contextChatIds: Array<Chat.ChatId> = [];
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
          contextUsage: (chatId) =>
            Effect.sync(() => {
              contextChatIds.push(chatId);
            }).pipe(
              Effect.andThen(
                chatId === missingChatId
                  ? Effect.fail(new AgentError({ message: "runtime failed" }))
                  : Effect.succeed<ContextUsage>({
                      kind: "available",
                      contextWindow: 200_000,
                      usedTokens: 12_345,
                      systemPromptTokens: 1_000,
                      systemToolsTokens: 2_000,
                      systemContextTokens: 3_000,
                      skillsTokens: 4_000,
                      messagesTokens: 2_345,
                    }),
              ),
            ),
          shake: (chatId, mode) =>
            Effect.sync(() => {
              shakeInputs.push({ chatId, mode });
            }).pipe(
              Effect.andThen(
                chatId === missingChatId
                  ? Effect.fail(new AgentError({ message: "runtime failed" }))
                  : Effect.succeed<ShakeResult>({
                      mode: "images",
                      imagesDropped: 2,
                      tokensFreed: 512,
                    }),
              ),
            ),
        }),
      );
      const gitWorktree: GitWorktree = {
        validate: () => Effect.void,
        create: (options, use) =>
          Effect.sync(() => {
            createdWorktrees.push(options);
          }).pipe(Effect.andThen(use(worktreeCwd))),
      };

      yield* Effect.gen(function* () {
        const application = yield* Application;
        const chats = yield* ChatRepository;

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
        assert.deepStrictEqual(yield* application.contextUsage(discordChat.id), {
          kind: "available",
          contextWindow: 200_000,
          usedTokens: 12_345,
          systemPromptTokens: 1_000,
          systemToolsTokens: 2_000,
          systemContextTokens: 3_000,
          skillsTokens: 4_000,
          messagesTokens: 2_345,
        });
        assert.deepStrictEqual(contextChatIds, [discordChat.id]);
        assertApplicationError(
          yield* application.contextUsage(missingChatId).pipe(Effect.flip),
          "Failed to read chat context",
        );
        assert.deepStrictEqual(contextChatIds, [discordChat.id, missingChatId]);
        assert.deepStrictEqual(yield* application.shake(discordChat.id, "images"), {
          mode: "images",
          imagesDropped: 2,
          tokensFreed: 512,
        });
        assert.deepStrictEqual(shakeInputs, [{ chatId: discordChat.id, mode: "images" }]);
        assertApplicationError(
          yield* application.shake(missingChatId, "elide").pipe(Effect.flip),
          "Failed to shake chat",
        );
        assert.deepStrictEqual(shakeInputs, [
          { chatId: discordChat.id, mode: "images" },
          { chatId: missingChatId, mode: "elide" },
        ]);

        assertApplicationError(
          yield* application
            .createChat({ workspaceId: missingWorkspaceId, externalId: null })
            .pipe(Effect.flip),
          "Failed to create chat",
        );
        yield* fileSystem.remove(defaultCwd, { recursive: true });
        assertApplicationError(
          yield* application
            .createChat({ workspaceId: regularWorkspace.id, externalId: "missing-cwd" })
            .pipe(Effect.flip),
          "Failed to create chat",
        );
        assert.isTrue(
          Option.isNone(yield* chats.findByExternalId(regularWorkspace.id, "missing-cwd")),
        );
        assert.strictEqual(createdSessions.length, 3);
        assert.strictEqual(createdWorktrees.length, 1);
      }).pipe(
        Effect.provide(ApplicationLayer.layer(gitWorktree)),
        Effect.provide(sessionsLayer),
        Effect.provide(persistenceLayer),
        Effect.provide(runtimeLayer),
        Effect.provide(BunCrypto.layer),
        Effect.scoped,
      );
    }).pipe(Effect.provide(platformLayer)),
  );

  it.effect("validates and replaces workspace configuration without rewriting existing chats", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const temporaryDirectory = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "pico-application-bind-",
      });
      const storeFile = AbsolutePath.make(path.join(temporaryDirectory, "store.db"));
      const firstCwd = AbsolutePath.make(path.join(temporaryDirectory, "first"));
      const secondCwd = AbsolutePath.make(path.join(temporaryDirectory, "second"));
      const worktreeCwd = AbsolutePath.make(path.join(temporaryDirectory, "generated-worktree"));
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
      let configurationChanges = 0;
      const observedWorkspaces = Layer.effect(
        WorkspaceRepository,
        Effect.gen(function* () {
          const repository = yield* WorkspaceRepository;
          return WorkspaceRepository.of({
            ...repository,
            replaceConfiguration: (workspaceId, configuration) =>
              Effect.sync(() => {
                configurationChanges += 1;
              }).pipe(Effect.andThen(repository.replaceConfiguration(workspaceId, configuration))),
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
          contextUsage: () => Effect.die("unexpected runtime context read"),
          shake: () => Effect.die("unexpected runtime shake"),
        }),
      );
      const validations: Array<Workspace.WorkspaceConfiguration> = [];
      const gitWorktree: GitWorktree = {
        validate: ({ repositoryCwd, settings }) =>
          Effect.sync(() => {
            validations.push({ defaultCwd: repositoryCwd, worktree: settings });
          }).pipe(
            Effect.andThen(
              settings.branch === "missing"
                ? Effect.fail(
                    new WorkspaceBindingInvalid({
                      issue: { field: "branch", reason: "not-commit" },
                    }),
                  )
                : Effect.void,
            ),
          ),
        create: (_options, use) => use(worktreeCwd),
      };

      yield* Effect.gen(function* () {
        const application = yield* Application;
        const chats = yield* ChatRepository;
        const binding = { platform: "discord", externalId: "channel-1" } as const;

        const created = yield* application.bindWorkspace({
          binding,
          workspaceName: "general",
          configuration: { kind: "direct", cwd: `${firstCwd}/.` },
        });
        assert.strictEqual(created.name, "general");
        assert.strictEqual(created.defaultCwd, firstCwd);
        assert.strictEqual(configurationChanges, 0);

        const freshWorktree = yield* application.bindWorkspace({
          binding: { platform: "discord", externalId: "channel-worktree" },
          workspaceName: "worktree channel",
          configuration: {
            kind: "worktree",
            repository: `${secondCwd}/.`,
            settings: { branch: "main", prefix: "fresh/" },
          },
        });
        assert.strictEqual(freshWorktree.name, "worktree channel");
        assert.deepStrictEqual(freshWorktree.binding, {
          platform: "discord",
          externalId: "channel-worktree",
        });
        assert.strictEqual(freshWorktree.defaultCwd, secondCwd);
        assert.deepStrictEqual(freshWorktree.worktree, { branch: "main", prefix: "fresh/" });
        assert.strictEqual(configurationChanges, 0);

        const oldChat = yield* application.createChat({
          workspaceId: created.id,
          externalId: "thread-old",
        });
        const repeated = yield* application.bindWorkspace({
          binding,
          workspaceName: "ignored rename",
          configuration: { kind: "direct", cwd: `${firstCwd}/.` },
        });
        assert.deepStrictEqual(repeated, created);
        assert.strictEqual(configurationChanges, 0);

        const rebound = yield* application.bindWorkspace({
          binding,
          workspaceName: "still ignored",
          configuration: {
            kind: "direct",
            cwd: `${temporaryDirectory}/first/../second`,
          },
        });
        assert.strictEqual(rebound.name, "general");
        assert.strictEqual(rebound.defaultCwd, secondCwd);
        assert.strictEqual(configurationChanges, 1);

        const worktreeBound = yield* application.bindWorkspace({
          binding,
          workspaceName: "ignored worktree rename",
          configuration: {
            kind: "worktree",
            repository: `${secondCwd}/.`,
            settings: { branch: "main", prefix: "chat/" },
          },
        });
        assert.deepStrictEqual(worktreeBound, {
          ...rebound,
          worktree: { branch: "main", prefix: "chat/" },
        });
        assert.strictEqual(configurationChanges, 2);
        assert.deepStrictEqual(validations, [
          { defaultCwd: secondCwd, worktree: { branch: "main", prefix: "fresh/" } },
          { defaultCwd: secondCwd, worktree: { branch: "main", prefix: "chat/" } },
        ]);

        const worktreeChat = yield* application.createChat({
          workspaceId: created.id,
          externalId: "thread-worktree",
        });
        assert.strictEqual(worktreeChat.cwd, worktreeCwd);

        const repeatedWorktree = yield* application.bindWorkspace({
          binding,
          workspaceName: "ignored again",
          configuration: {
            kind: "worktree",
            repository: secondCwd,
            settings: { branch: "main", prefix: "chat/" },
          },
        });
        assert.deepStrictEqual(repeatedWorktree, worktreeBound);
        assert.strictEqual(configurationChanges, 2);

        const directAgain = yield* application.bindWorkspace({
          binding,
          workspaceName: "ignored direct rename",
          configuration: { kind: "direct", cwd: secondCwd },
        });
        assert.deepStrictEqual(directAgain, { ...rebound, worktree: null });
        assert.strictEqual(configurationChanges, 3);

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
          [firstCwd, worktreeCwd, secondCwd],
        );

        const invalidBranch = yield* application
          .bindWorkspace({
            binding: { platform: "discord", externalId: "invalid-branch" },
            workspaceName: "invalid branch",
            configuration: {
              kind: "worktree",
              repository: secondCwd,
              settings: { branch: "missing", prefix: "chat/" },
            },
          })
          .pipe(Effect.flip);
        if (!(invalidBranch instanceof WorkspaceBindingInvalid)) {
          return yield* Effect.die(`Unexpected bind failure: ${invalidBranch._tag}`);
        }
        assert.strictEqual(invalidBranch.issue.field, "branch");
        assert.strictEqual(invalidBranch.issue.reason, "not-commit");
        assert.isTrue(
          Option.isNone(yield* application.findWorkspaceByPlatformId("discord", "invalid-branch")),
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
              configuration: { kind: "direct", cwd: input.cwd },
            })
            .pipe(Effect.flip);
          if (!(error instanceof WorkspaceBindingInvalid)) {
            return yield* Effect.die(`Unexpected bind failure: ${error._tag}`);
          }
          assert.strictEqual(error.issue.field, "cwd");
          assert.strictEqual(error.issue.reason, input.reason);
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
            configuration: { kind: "direct", cwd: unreadableCwd },
          })
          .pipe(Effect.flip);
        if (!(unreadable instanceof WorkspaceBindingInvalid)) {
          return yield* Effect.die(`Unexpected bind failure: ${unreadable._tag}`);
        }
        assert.strictEqual(unreadable.issue.field, "cwd");
        assert.strictEqual(unreadable.issue.reason, "unreadable");
        assert.isTrue(
          Option.isNone(yield* application.findWorkspaceByPlatformId("discord", "unreadable")),
        );
      }).pipe(
        Effect.provide(ApplicationLayer.layer(gitWorktree)),
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
