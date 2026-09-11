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
import {
  AgentError,
  ApplicationError,
  ChatClosed,
  PersistenceError,
  WorkspaceBindingInvalid,
} from "@pico/contract/errors";
import { AbsolutePath } from "@pico/contract/path";
import * as Schedule from "@pico/contract/schedule";
import * as Workspace from "@pico/contract/workspace-model";
import { WorkspaceRepository } from "@pico/contract/workspace-repository";
import type { CreateWorktreeOptions, GitWorktree } from "@pico/contract/worktree";
import * as Persistence from "@pico/persistence/layer";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
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

const assertApplicationError = (error: ApplicationError | ChatClosed, message: string) => {
  if (!(error instanceof ApplicationError)) {
    assert.fail(`Expected ApplicationError, received ${error._tag}`);
    return;
  }
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
            remove: () => Effect.void,
          });
        }),
      ).pipe(Layer.provide(persistenceLayer));
      const runtimeLayer = Layer.succeed(
        AgentRuntime,
        AgentRuntime.of({
          events: Stream.empty,
          drain: () => Effect.void,
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
          sendCaptured: (capturedChatId, runId, _prompt, onEvent) =>
            onEvent({ type: "run-started" }).pipe(
              Effect.as({
                runId,
                outcome: "completed",
                events: [{ type: "run-started" }],
                finalAssistantText: `captured:${capturedChatId}`,
              }),
            ),
          deliver: (deliveredChatId, content) =>
            Effect.sync(() => sentMessages.push({ chatId: deliveredChatId, content })),
          publish: (publishedChatId, content) =>
            Effect.sync(() => sentMessages.push({ chatId: publishedChatId, content })),
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
          close: () => Effect.die("unexpected runtime close"),
        }),
      );
      const gitWorktree: GitWorktree = {
        validate: () => Effect.void,
        create: (options, use) =>
          Effect.sync(() => {
            createdWorktrees.push(options);
          }).pipe(Effect.andThen(use(worktreeCwd))),
        inspectChat: () => Effect.succeed({ kind: "not-managed" }),
        removeChat: () => Effect.die("unexpected worktree removal"),
      };

      yield* Effect.gen(function* () {
        const application = yield* Application;
        const scheduleHost = yield* Schedule.ScheduleRunHostService;
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
        const unboundChat = yield* application.createChat({
          workspaceId: regularWorkspace.id,
          externalId: "local-thread",
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
        assert.deepStrictEqual(
          Option.getOrThrow(yield* application.findChatPlatformBinding(discordChat.id)),
          { platform: "discord", externalId: "thread-1" },
        );
        assert.isTrue(Option.isNone(yield* application.findChatPlatformBinding(regularChat.id)));
        assert.isTrue(Option.isNone(yield* application.findChatPlatformBinding(unboundChat.id)));
        assert.isTrue(Option.isNone(yield* application.findChatPlatformBinding(missingChatId)));

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
          "Chat not found",
        );
        assert.deepStrictEqual(abortedChatIds, [discordChat.id]);
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
          "Chat not found",
        );
        assert.deepStrictEqual(contextChatIds, [discordChat.id]);
        assert.deepStrictEqual(yield* application.shake(discordChat.id, "images"), {
          mode: "images",
          imagesDropped: 2,
          tokensFreed: 512,
        });
        assert.deepStrictEqual(shakeInputs, [{ chatId: discordChat.id, mode: "images" }]);
        assertApplicationError(
          yield* application.shake(missingChatId, "elide").pipe(Effect.flip),
          "Chat not found",
        );
        assert.deepStrictEqual(shakeInputs, [{ chatId: discordChat.id, mode: "images" }]);

        assertApplicationError(
          yield* application
            .createChat({ workspaceId: missingWorkspaceId, externalId: null })
            .pipe(Effect.flip),
          "Failed to create chat",
        );
        const firstScheduledId = Chat.ChatId.make("018f47a0-0000-7000-8000-000000000010");
        const secondScheduledId = Chat.ChatId.make("018f47a0-0000-7000-8000-000000000011");
        const firstScheduled = yield* scheduleHost.prepare({
          kind: "workspace-chat",
          ownerWorkspaceId: worktreeWorkspace.id,
          chatId: firstScheduledId,
        });
        const secondScheduled = yield* scheduleHost.prepare({
          kind: "workspace-chat",
          ownerWorkspaceId: worktreeWorkspace.id,
          chatId: secondScheduledId,
        });
        assert.strictEqual(firstScheduled.chatId, firstScheduledId);
        assert.strictEqual(secondScheduled.chatId, secondScheduledId);
        assert.notStrictEqual(firstScheduled.chatId, secondScheduled.chatId);
        assert.strictEqual(firstScheduled.cwd, worktreeCwd);
        assert.strictEqual(secondScheduled.cwd, worktreeCwd);
        const crossWorkspace = yield* scheduleHost
          .prepare({
            kind: "existing-chat",
            ownerWorkspaceId: regularWorkspace.id,
            chatId: discordChat.id,
          })
          .pipe(Effect.flip);
        assert.strictEqual(
          crossWorkspace.message,
          "Scheduled chat does not belong to its owner workspace",
        );
        const runId = Schedule.ScheduleRunId.make(
          "scheduled-1000-018f47a0-0000-7000-8000-000000000003",
        );
        const captured = yield* scheduleHost.runPrompt(
          discordChat.id,
          runId,
          "scheduled prompt",
          () => Effect.void,
        );
        assert.deepStrictEqual(captured, {
          runId,
          outcome: "completed",
          events: [{ type: "run-started" }],
          finalAssistantText: `captured:${discordChat.id}`,
        });
        yield* scheduleHost.deliver(discordChat.id, "scheduled delivery");
        assert.deepInclude(sentMessages, { chatId: discordChat.id, content: "scheduled delivery" });
        yield* scheduleHost.publish(discordChat.id, "scheduled publish");
        assert.deepInclude(sentMessages, { chatId: discordChat.id, content: "scheduled publish" });

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
        assert.strictEqual(createdSessions.length, 6);
        assert.strictEqual(createdWorktrees.length, 3);
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
          remove: () => Effect.void,
        }),
      );
      const runtimeLayer = Layer.succeed(
        AgentRuntime,
        AgentRuntime.of({
          events: Stream.empty,
          drain: () => Effect.void,
          transcript: () => Effect.die("unexpected transcript read"),
          send: () => Effect.die("unexpected runtime send"),
          sendCaptured: () => Effect.die("unexpected captured runtime send"),
          deliver: () => Effect.die("unexpected scheduled delivery"),
          publish: () => Effect.die("unexpected scheduled publish"),
          abort: () => Effect.die("unexpected runtime abort"),
          contextUsage: () => Effect.die("unexpected runtime context read"),
          shake: () => Effect.die("unexpected runtime shake"),
          close: () => Effect.die("unexpected runtime close"),
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
        inspectChat: () => Effect.succeed({ kind: "not-managed" }),
        removeChat: () => Effect.die("unexpected worktree removal"),
      };

      yield* Effect.gen(function* () {
        const application = yield* Application;
        const chats = yield* ChatRepository;
        const binding: Workspace.WorkspaceBinding = {
          platform: "discord",
          externalId: "channel-1",
        };

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

        const invalidInputs: ReadonlyArray<{
          readonly externalId: string;
          readonly cwd: string;
          readonly reason: Extract<
            WorkspaceBindingInvalid["issue"],
            { readonly field: "cwd" }
          >["reason"];
        }> = [
          { externalId: "whitespace", cwd: ` ${firstCwd}`, reason: "surrounding-whitespace" },
          { externalId: "relative", cwd: "relative/project", reason: "not-absolute" },
          { externalId: "home", cwd: "~/project", reason: "not-absolute" },
          {
            externalId: "missing",
            cwd: path.join(temporaryDirectory, "missing"),
            reason: "not-found",
          },
          { externalId: "file", cwd: file, reason: "not-directory" },
        ];
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
  it.effect("serializes close after sends and lets abort reach a scheduled run", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const temporaryDirectory = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "pico-application-close-",
      });
      const defaultCwd = AbsolutePath.make(path.join(temporaryDirectory, "workspace"));
      const storeFile = AbsolutePath.make(path.join(temporaryDirectory, "store.db"));
      yield* fileSystem.makeDirectory(defaultCwd);
      const persistenceLayer = Persistence.layer(storeFile);
      const sendStarted = yield* Deferred.make<void>();
      const releaseSend = yield* Deferred.make<void>();
      const scheduledStarted = yield* Deferred.make<void>();
      const releaseScheduled = yield* Deferred.make<void>();
      const order: Array<string> = [];
      let aborts = 0;

      const runtimeLayer = Layer.effect(
        AgentRuntime,
        Effect.gen(function* () {
          const chats = yield* ChatRepository;
          return AgentRuntime.of({
            events: Stream.empty,
            drain: () => Effect.void,
            transcript: () => Effect.succeed(runtimeTranscript),
            send: () =>
              Effect.gen(function* () {
                order.push("send-start");
                yield* Deferred.succeed(sendStarted, undefined);
                yield* Deferred.await(releaseSend);
                order.push("send-end");
              }),
            sendCaptured: (_chatId, runId) =>
              Deferred.succeed(scheduledStarted, undefined).pipe(
                Effect.andThen(Deferred.await(releaseScheduled)),
                Effect.as({
                  runId,
                  outcome: "aborted",
                  events: [],
                  finalAssistantText: "",
                }),
              ),
            deliver: () => Effect.die("unexpected scheduled delivery"),
            publish: () => Effect.die("unexpected scheduled publish"),
            close: (id) =>
              Effect.gen(function* () {
                const chat = Option.getOrThrow(yield* chats.findById(id).pipe(Effect.orDie));
                assert.strictEqual(chat.archivedAt, 3_000);
                order.push("runtime-close");
              }),
            abort: () =>
              Effect.sync(() => {
                aborts += 1;
              }).pipe(Effect.andThen(Deferred.succeed(releaseScheduled, undefined)), Effect.asVoid),
            contextUsage: () => Effect.succeed({ kind: "unavailable" }),
            shake: () =>
              Effect.succeed({
                mode: "elide",
                toolResultsDropped: 0,
                blocksDropped: 0,
                tokensFreed: 0,
              }),
          });
        }),
      ).pipe(Layer.provide(persistenceLayer));
      const sessionsLayer = Layer.succeed(
        AgentSessionStore,
        AgentSessionStore.of({ create: () => Effect.void, remove: () => Effect.void }),
      );
      const gitWorktree: GitWorktree = {
        validate: () => Effect.void,
        create: (_options, use) => use(defaultCwd),
        inspectChat: () =>
          Effect.sync(() => {
            order.push("inspect");
            return { kind: "not-managed" };
          }),
        removeChat: () => Effect.die("direct chat must not remove a worktree"),
      };

      yield* Effect.gen(function* () {
        const application = yield* Application;
        const scheduleHost = yield* Schedule.ScheduleRunHostService;
        yield* TestClock.setTime(1_000);
        const workspace = yield* application.createWorkspace({
          name: "close",
          binding: null,
          defaultCwd,
          worktree: null,
        });
        yield* TestClock.setTime(2_000);
        const chat = yield* application.createChat({ workspaceId: workspace.id, externalId: null });

        const scheduled = yield* scheduleHost
          .runPrompt(
            chat.id,
            Schedule.ScheduleRunId.make("scheduled-1000-018f47a0-0000-7000-8000-000000000003"),
            "scheduled",
            () => Effect.void,
          )
          .pipe(Effect.forkChild);
        yield* Deferred.await(scheduledStarted);
        yield* application.abort(chat.id);
        assert.strictEqual(aborts, 1);
        assert.strictEqual((yield* Fiber.join(scheduled)).outcome, "aborted");

        const send = yield* application.sendMessage(chat.id, "in flight").pipe(Effect.forkChild);
        yield* Deferred.await(sendStarted);
        yield* TestClock.setTime(3_000);
        const closing = yield* application
          .closeChat(chat.id, { allowDirtyWorktree: false })
          .pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        assert.deepStrictEqual(order, ["send-start"]);
        yield* Deferred.succeed(releaseSend, undefined);
        yield* Fiber.join(send);
        assert.deepStrictEqual(yield* Fiber.join(closing), { kind: "closed" });
        assert.deepStrictEqual(order, ["send-start", "send-end", "inspect", "runtime-close"]);

        const chats = yield* ChatRepository;
        assert.strictEqual(Option.getOrThrow(yield* chats.findById(chat.id)).archivedAt, 3_000);
        assert.instanceOf(
          yield* application.sendMessage(chat.id, "late").pipe(Effect.flip),
          ChatClosed,
        );
        assert.instanceOf(yield* application.contextUsage(chat.id).pipe(Effect.flip), ChatClosed);
        assert.instanceOf(yield* application.shake(chat.id, "elide").pipe(Effect.flip), ChatClosed);
        yield* application.abort(chat.id);
        assert.strictEqual(aborts, 1);
        assert.deepStrictEqual(yield* application.transcript(chat.id), runtimeTranscript);

        const missingChatId = Chat.ChatId.make("018f47a0-0000-7000-8000-000000000099");
        assertApplicationError(
          yield* application.sendMessage(missingChatId, "missing").pipe(Effect.flip),
          "Chat not found",
        );
        assertApplicationError(
          yield* application.contextUsage(missingChatId).pipe(Effect.flip),
          "Chat not found",
        );
        assertApplicationError(
          yield* application.shake(missingChatId, "elide").pipe(Effect.flip),
          "Chat not found",
        );
        assertApplicationError(
          yield* application.abort(missingChatId).pipe(Effect.flip),
          "Chat not found",
        );

        yield* TestClock.setTime(4_000);
        assert.deepStrictEqual(
          yield* application.closeChat(chat.id, { allowDirtyWorktree: false }),
          { kind: "closed" },
        );
        assert.strictEqual(Option.getOrThrow(yield* chats.findById(chat.id)).archivedAt, 3_000);
      }).pipe(
        Effect.provide(ApplicationLayer.layer(gitWorktree)),
        Effect.provide(persistenceLayer),
        Effect.provide(runtimeLayer),
        Effect.provide(sessionsLayer),
        Effect.provide(BunCrypto.layer),
        Effect.scoped,
      );
    }).pipe(Effect.provide(platformLayer)),
  );
  it.effect("confirms destructive cleanup and never removes before runtime disposal", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const temporaryDirectory = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "pico-application-cleanup-",
      });
      const defaultCwd = AbsolutePath.make(path.join(temporaryDirectory, "repository"));
      const worktreeCwd = AbsolutePath.make(path.join(temporaryDirectory, "worktree"));
      const storeFile = AbsolutePath.make(path.join(temporaryDirectory, "store.db"));
      const persistenceLayer = Persistence.layer(storeFile);
      const order: Array<string> = [];
      let inspectionState: "clean" | "dirty" = "dirty";
      let removalResult: "removed" | "force-required" = "removed";
      let runtimeFails = false;

      const runtimeLayer = Layer.effect(
        AgentRuntime,
        Effect.gen(function* () {
          const chats = yield* ChatRepository;
          return AgentRuntime.of({
            events: Stream.empty,
            drain: () => Effect.void,
            transcript: () => Effect.succeed([]),
            send: () => Effect.die("unexpected send"),
            sendCaptured: () => Effect.die("unexpected captured runtime send"),
            deliver: () => Effect.die("unexpected scheduled delivery"),
            publish: () => Effect.die("unexpected scheduled publish"),
            close: (id) =>
              Effect.gen(function* () {
                assert.isNotNull(
                  Option.getOrThrow(yield* chats.findById(id).pipe(Effect.orDie)).archivedAt,
                );
                order.push("runtime-close");
                if (runtimeFails) return yield* new AgentError({ message: "dispose failed" });
              }),
            abort: () => Effect.die("unexpected abort"),
            contextUsage: () => Effect.die("unexpected context read"),
            shake: () => Effect.die("unexpected shake"),
          });
        }),
      ).pipe(Layer.provide(persistenceLayer));
      const sessionsLayer = Layer.succeed(
        AgentSessionStore,
        AgentSessionStore.of({ create: () => Effect.void, remove: () => Effect.void }),
      );
      const gitWorktree: GitWorktree = {
        validate: () => Effect.void,
        create: (_options, use) => use(worktreeCwd),
        inspectChat: () =>
          Effect.sync(() => {
            order.push(`inspect-${inspectionState}`);
            return { kind: "managed", state: inspectionState };
          }),
        removeChat: ({ force }) =>
          Effect.sync(() => {
            order.push(force ? "remove-force" : "remove-clean");
            return { kind: removalResult };
          }),
      };

      yield* Effect.gen(function* () {
        const application = yield* Application;
        const chats = yield* ChatRepository;
        const workspace = yield* application.createWorkspace({
          name: "worktree",
          binding: null,
          defaultCwd,
          worktree: { branch: "main", prefix: "chat/" },
        });
        const dirtyChat = yield* application.createChat({
          workspaceId: workspace.id,
          externalId: null,
        });

        assert.deepStrictEqual(
          yield* application.closeChat(dirtyChat.id, { allowDirtyWorktree: false }),
          { kind: "worktree-confirmation-required" },
        );
        assert.isNull(Option.getOrThrow(yield* chats.findById(dirtyChat.id)).archivedAt);
        assert.deepStrictEqual(order, ["inspect-dirty"]);

        assert.deepStrictEqual(
          yield* application.closeChat(dirtyChat.id, { allowDirtyWorktree: true }),
          { kind: "closed" },
        );
        assert.deepStrictEqual(order, [
          "inspect-dirty",
          "inspect-dirty",
          "runtime-close",
          "remove-force",
        ]);

        const racedChat = yield* application.createChat({
          workspaceId: workspace.id,
          externalId: null,
        });
        inspectionState = "clean";
        removalResult = "force-required";
        assert.deepStrictEqual(
          yield* application.closeChat(racedChat.id, { allowDirtyWorktree: false }),
          { kind: "worktree-confirmation-required" },
        );
        assert.isNotNull(Option.getOrThrow(yield* chats.findById(racedChat.id)).archivedAt);
        assert.deepStrictEqual(order.slice(-3), ["inspect-clean", "runtime-close", "remove-clean"]);

        const failedChat = yield* application.createChat({
          workspaceId: workspace.id,
          externalId: null,
        });
        runtimeFails = true;
        removalResult = "removed";
        const removalsBeforeFailure = order.filter((entry) => entry.startsWith("remove")).length;
        assertApplicationError(
          yield* application
            .closeChat(failedChat.id, { allowDirtyWorktree: true })
            .pipe(Effect.flip),
          "Failed to close chat runtime",
        );
        assert.isNotNull(Option.getOrThrow(yield* chats.findById(failedChat.id)).archivedAt);
        assert.strictEqual(
          order.filter((entry) => entry.startsWith("remove")).length,
          removalsBeforeFailure,
        );
      }).pipe(
        Effect.provide(ApplicationLayer.layer(gitWorktree)),
        Effect.provide(persistenceLayer),
        Effect.provide(runtimeLayer),
        Effect.provide(sessionsLayer),
        Effect.provide(BunCrypto.layer),
        Effect.scoped,
      );
    }).pipe(Effect.provide(platformLayer)),
  );
  it.effect("rolls back direct and worktree resources when chat insertion fails", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const temporaryDirectory = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "pico-chat-rollback-",
      });
      const directCwd = AbsolutePath.make(path.join(temporaryDirectory, "direct"));
      const repositoryCwd = AbsolutePath.make(path.join(temporaryDirectory, "repository"));
      const worktreeCwd = AbsolutePath.make(path.join(temporaryDirectory, "worktree"));
      const sessionsDir = path.join(temporaryDirectory, "sessions");
      const branchMarker = path.join(temporaryDirectory, "worktree-branch");
      const storeFile = AbsolutePath.make(path.join(temporaryDirectory, "store.db"));
      yield* fileSystem.makeDirectory(directCwd);
      yield* fileSystem.makeDirectory(repositoryCwd);
      yield* fileSystem.makeDirectory(sessionsDir);

      const persistenceLayer = Persistence.layer(storeFile);
      const failingChats = Layer.effect(
        ChatRepository,
        Effect.gen(function* () {
          const chats = yield* ChatRepository;
          return ChatRepository.of({
            ...chats,
            create: () =>
              Effect.fail(new PersistenceError({ message: "database insert rejected" })),
          });
        }),
      ).pipe(Layer.provide(persistenceLayer));
      const repositories = Layer.merge(persistenceLayer, failingChats);
      const createdSessionIds: Array<Chat.ChatId> = [];
      const sessionsLayer = Layer.succeed(
        AgentSessionStore,
        AgentSessionStore.of({
          create: ({ chatId }) =>
            Effect.sync(() => {
              createdSessionIds.push(chatId);
            }).pipe(
              Effect.andThen(
                fileSystem
                  .writeFileString(path.join(sessionsDir, `${chatId}.jsonl`), "session")
                  .pipe(Effect.orDie),
              ),
            ),
          remove: (chatId) =>
            fileSystem
              .remove(path.join(sessionsDir, `${chatId}.jsonl`), { force: true })
              .pipe(Effect.orDie),
        }),
      );
      const runtimeLayer = Layer.succeed(
        AgentRuntime,
        AgentRuntime.of({
          events: Stream.empty,
          drain: () => Effect.void,
          transcript: () => Effect.die("unexpected transcript read"),
          send: () => Effect.die("unexpected runtime send"),
          sendCaptured: () => Effect.die("unexpected captured runtime send"),
          deliver: () => Effect.die("unexpected scheduled delivery"),
          publish: () => Effect.die("unexpected scheduled publish"),
          abort: () => Effect.die("unexpected runtime abort"),
          contextUsage: () => Effect.die("unexpected runtime context read"),
          shake: () => Effect.die("unexpected runtime shake"),
          close: () => Effect.die("unexpected runtime close"),
        }),
      );
      const gitWorktree: GitWorktree = {
        validate: () => Effect.void,
        create: (_options, use) =>
          Effect.gen(function* () {
            yield* fileSystem.makeDirectory(worktreeCwd).pipe(Effect.orDie);
            yield* fileSystem.writeFileString(branchMarker, "created").pipe(Effect.orDie);
            return yield* use(worktreeCwd).pipe(
              Effect.tapError(() =>
                Effect.all(
                  [
                    fileSystem.remove(worktreeCwd, { recursive: true, force: true }),
                    fileSystem.remove(branchMarker, { force: true }),
                  ],
                  { discard: true },
                ).pipe(Effect.orDie),
              ),
            );
          }),
        inspectChat: () => Effect.succeed({ kind: "not-managed" }),
        removeChat: () => Effect.die("unexpected worktree removal"),
      };

      yield* Effect.gen(function* () {
        const application = yield* Application;
        const chats = yield* ChatRepository;
        const direct = yield* application.createWorkspace({
          name: "direct",
          binding: null,
          defaultCwd: directCwd,
          worktree: null,
        });
        const directError = yield* application
          .createChat({ workspaceId: direct.id, externalId: null })
          .pipe(Effect.flip);
        assertApplicationError(directError, "Failed to create chat");
        const directSessionId = createdSessionIds[0];
        if (directSessionId === undefined) {
          return yield* Effect.die("Direct session was not created");
        }
        assert.isFalse(
          yield* fileSystem.exists(path.join(sessionsDir, `${directSessionId}.jsonl`)),
        );
        assert.isTrue(Option.isNone(yield* chats.findById(directSessionId)));

        const worktree = yield* application.createWorkspace({
          name: "worktree",
          binding: null,
          defaultCwd: repositoryCwd,
          worktree: { branch: "main", prefix: "chat/" },
        });
        const worktreeError = yield* application
          .createChat({ workspaceId: worktree.id, externalId: null })
          .pipe(Effect.flip);
        assertApplicationError(worktreeError, "Failed to create chat");
        const worktreeSessionId = createdSessionIds[1];
        if (worktreeSessionId === undefined) {
          return yield* Effect.die("Worktree session was not created");
        }
        assert.isFalse(
          yield* fileSystem.exists(path.join(sessionsDir, `${worktreeSessionId}.jsonl`)),
        );
        assert.isFalse(yield* fileSystem.exists(worktreeCwd));
        assert.isFalse(yield* fileSystem.exists(branchMarker));
        assert.isTrue(Option.isNone(yield* chats.findById(worktreeSessionId)));
      }).pipe(
        Effect.provide(ApplicationLayer.layer(gitWorktree)),
        Effect.provide(repositories),
        Effect.provide(sessionsLayer),
        Effect.provide(runtimeLayer),
        Effect.provide(BunCrypto.layer),
        Effect.scoped,
      );
    }).pipe(Effect.provide(platformLayer)),
  );
});
