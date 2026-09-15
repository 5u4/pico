import * as BunCrypto from "@effect/platform-bun/BunCrypto";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import * as BunPath from "@effect/platform-bun/BunPath";
import { assert, describe, it } from "@effect/vitest";
import * as AgentMessage from "@pico/contract/agent-message";
import {
  AgentRuntime,
  type ContextUsage,
  type ShakeMode,
  type ShakeResult,
} from "@pico/contract/agent-runtime";
import { AgentSessionStore } from "@pico/contract/agent-session-store";
import { Application } from "@pico/contract/application";
import * as Chat from "@pico/contract/chat-model";
import { ChatRepository } from "@pico/contract/chat-repository";
import {
  AgentError,
  ApplicationError,
  type ChatClosed,
  PersistenceError,
} from "@pico/contract/errors";
import { AbsolutePath } from "@pico/contract/path";
import * as Schedule from "@pico/contract/schedule";
import * as Workspace from "@pico/contract/workspace-model";
import type { CreateWorktreeOptions, GitWorktree } from "@pico/contract/worktree";
import * as Persistence from "@pico/persistence/layer";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as ApplicationLayer from "./application.ts";

const platformLayer = Layer.merge(BunFileSystem.layer, BunPath.layer);

const uuidV7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const missingWorkspaceId = Workspace.WorkspaceId.make("018f47a0-0000-7000-8000-000000000099");

const missingChatId = Chat.ChatId.make("018f47a0-0000-7000-8000-000000000098");

const textPrompt = (text: string) => AgentMessage.AgentPrompt.make({ text, attachments: [] });

const runtimeTranscript: AgentMessage.AgentTranscript = [
  {
    role: "user",
    content: [{ type: "text", text: "hello" }],
    timestamp: 7,
  },
];

const assertApplicationError = (
  error: ApplicationError | ChatClosed,
  reason: ApplicationError["reason"],
) => {
  if (!(error instanceof ApplicationError)) {
    assert.fail(`Expected ApplicationError, received ${error._tag}`);
    return;
  }
  assert.strictEqual(error.reason, reason);
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
      const createdWorktrees: Array<CreateWorktreeOptions> = [];
      const sentMessages: Array<{
        readonly chatId: string;
        readonly content: string | AgentMessage.AgentPrompt;
      }> = [];
      const transcriptChatIds: Array<Chat.ChatId> = [];
      const abortedChatIds: Array<Chat.ChatId> = [];
      const shakeInputs: Array<{ readonly chatId: Chat.ChatId; readonly mode: ShakeMode }> = [];
      const contextChatIds: Array<Chat.ChatId> = [];
      let sendFailure: AgentError | null = null;
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
              }),
            remove: () => Effect.void,
          });
        }),
      ).pipe(Layer.provide(persistenceLayer));
      const runtimeLayer = Layer.succeed(
        AgentRuntime,
        AgentRuntime.of({
          availableModels: () => Effect.die("unexpected model catalog read"),
          switchModel: () => Effect.die("unexpected model switch"),
          askBtw: () => Effect.die("unexpected side question"),
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
            Effect.sync(() => {
              sentMessages.push({ chatId, content });
            }).pipe(
              Effect.andThen(
                Effect.suspend(() =>
                  sendFailure === null ? Effect.void : Effect.fail(sendFailure),
                ),
              ),
              Effect.as({ kind: "started", completed: Effect.void } as const),
            ),
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
        renameChatBranch: () => Effect.die("unexpected branch rename"),
        removeChat: () => Effect.die("unexpected worktree removal"),
      };

      yield* Effect.gen(function* () {
        const application = yield* Application;
        const scheduleHost = (yield* Schedule.ScheduleRunHostFactory)(null);
        const chats = yield* ChatRepository;
        assert.deepStrictEqual(yield* application.listWorkspaces(), []);
        assertApplicationError(
          yield* application.listChats(missingWorkspaceId).pipe(Effect.flip),
          "not-found",
        );
        for (const invalidCwd of [
          AbsolutePath.make(path.join(temporaryDirectory, "missing")),
          storeFile,
        ]) {
          assertApplicationError(
            yield* application
              .createWorkspace({
                name: "invalid",
                platform: "web",
                externalId: null,
                defaultCwd: invalidCwd,
                worktree: null,
              })
              .pipe(Effect.flip),
            "invalid-state",
          );
          assert.deepStrictEqual(yield* application.listWorkspaces(), []);
        }

        yield* TestClock.setTime(1_000);
        const regularWorkspace = yield* application.createWorkspace({
          name: "regular",
          platform: "web",
          externalId: null,
          defaultCwd,
          worktree: null,
        });
        assert.deepStrictEqual(yield* application.listChats(regularWorkspace.id), []);

        yield* TestClock.setTime(2_000);
        const regularChat = yield* application.createChat({
          workspaceId: regularWorkspace.id,
          externalId: null,
        });
        assert.match(regularChat.id, uuidV7);
        assert.strictEqual(regularChat.cwd, defaultCwd);
        assert.strictEqual(regularChat.createdAt, 2_000);
        assert.strictEqual(regularChat.archivedAt, null);

        yield* TestClock.setTime(3_000);
        const worktreeWorkspace = yield* application.createWorkspace({
          name: "worktree",
          platform: "web",
          externalId: null,
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

        yield* TestClock.setTime(5_000);
        const discordWorkspace = yield* application.createWorkspace({
          name: "discord",
          platform: "discord",
          externalId: "1.10",
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
        assert.deepStrictEqual(yield* application.listWorkspaces(), [
          discordWorkspace,
          worktreeWorkspace,
          regularWorkspace,
        ]);
        assert.deepStrictEqual(yield* application.listChats(regularWorkspace.id), [
          unboundChat,
          regularChat,
        ]);
        assert.deepStrictEqual(yield* application.listChats(discordWorkspace.id), [discordChat]);
        assert.deepStrictEqual(yield* application.listChats(worktreeWorkspace.id), [worktreeChat]);

        assert.deepStrictEqual(
          Option.getOrThrow(yield* application.findWorkspaceByPlatformId("discord", "1.10")),
          discordWorkspace,
        );
        assert.isTrue(
          Option.isNone(yield* application.findWorkspaceByPlatformId("discord", "1.99")),
        );
        assert.deepStrictEqual(
          Option.getOrThrow(yield* application.findChatByPlatformId("discord", "1.10", "thread-1")),
          discordChat,
        );
        assert.isTrue(
          Option.isNone(yield* application.findChatByPlatformId("discord", "1.10", "missing")),
        );
        assert.isTrue(
          Option.isNone(yield* application.findChatByPlatformId("discord", "1.99", "thread-1")),
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
          "operation",
        );
        assert.deepStrictEqual(transcriptChatIds, [discordChat.id, missingChatId]);

        const attachedPrompt = AgentMessage.AgentPrompt.make({
          text: "hello",
          attachments: [
            {
              type: "image",
              name: "diagram.png",
              data: "iVBORw==",
              mimeType: "image/png",
            },
          ],
        });
        yield* application.sendMessage(discordChat.id, attachedPrompt);
        yield* application.sendMessage(discordChat.id, textPrompt("second"));
        assert.deepStrictEqual(sentMessages, [
          { chatId: discordChat.id, content: attachedPrompt },
          { chatId: discordChat.id, content: textPrompt("second") },
        ]);
        sendFailure = new AgentError({ message: "Discord identity is not ready" });
        const sendError = yield* application
          .sendMessage(discordChat.id, textPrompt("retry"))
          .pipe(Effect.flip);
        assertApplicationError(sendError, "operation");
        assert.include(sendError.message, sendFailure.message);
        sendFailure = null;
        yield* application.abort(discordChat.id);
        assert.deepStrictEqual(abortedChatIds, [discordChat.id]);
        assertApplicationError(
          yield* application.abort(missingChatId).pipe(Effect.flip),
          "not-found",
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
          "not-found",
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
          "not-found",
        );
        assert.deepStrictEqual(shakeInputs, [{ chatId: discordChat.id, mode: "images" }]);

        assertApplicationError(
          yield* application
            .createChat({ workspaceId: missingWorkspaceId, externalId: null })
            .pipe(Effect.flip),
          "not-found",
        );
        const firstScheduledId = Chat.ChatId.make("018f47a0-0000-7000-8000-000000000010");
        const secondScheduledId = Chat.ChatId.make("018f47a0-0000-7000-8000-000000000011");
        const firstScheduled = yield* scheduleHost.prepare({
          kind: "workspace",
          workspaceId: worktreeWorkspace.id,
          newChatId: firstScheduledId,
        });
        const secondScheduled = yield* scheduleHost.prepare({
          kind: "workspace",
          workspaceId: worktreeWorkspace.id,
          newChatId: secondScheduledId,
        });
        assert.strictEqual(firstScheduled.chatId, firstScheduledId);
        assert.strictEqual(secondScheduled.chatId, secondScheduledId);
        assert.notStrictEqual(firstScheduled.chatId, secondScheduled.chatId);
        assert.strictEqual(firstScheduled.cwd, worktreeCwd);
        assert.strictEqual(secondScheduled.cwd, worktreeCwd);
        assert.strictEqual(firstScheduled.workspaceId, worktreeWorkspace.id);
        assert.deepStrictEqual(
          yield* scheduleHost.prepare({
            kind: "workspace",
            workspaceId: worktreeWorkspace.id,
            newChatId: firstScheduledId,
          }),
          firstScheduled,
        );
        const resolvedChat = yield* scheduleHost.prepare({
          kind: "chat",
          chatId: worktreeChat.id,
        });
        assert.deepStrictEqual(resolvedChat, {
          chatId: worktreeChat.id,
          workspaceId: worktreeWorkspace.id,
          cwd: worktreeCwd,
        });
        for (const destination of [
          { kind: "chat", chatId: missingChatId },
          { kind: "workspace", workspaceId: missingWorkspaceId, newChatId: missingChatId },
          {
            kind: "workspace",
            workspaceId: regularWorkspace.id,
            newChatId: firstScheduledId,
          },
        ] satisfies ReadonlyArray<Schedule.ScheduleRunDestination>) {
          assert.instanceOf(
            yield* scheduleHost.prepare(destination).pipe(Effect.flip),
            Schedule.ScheduleHostError,
          );
        }
        assert.isTrue(Option.isNone(yield* chats.findById(missingChatId)));
        yield* chats.archive(firstScheduledId, 7_000);
        for (const destination of [
          { kind: "chat", chatId: firstScheduledId },
          {
            kind: "workspace",
            workspaceId: worktreeWorkspace.id,
            newChatId: firstScheduledId,
          },
        ] satisfies ReadonlyArray<Schedule.ScheduleRunDestination>) {
          assert.instanceOf(
            yield* scheduleHost.prepare(destination).pipe(Effect.flip),
            Schedule.ScheduleHostError,
          );
        }
        const runId = Schedule.ScheduleRunId.make(
          "scheduled-1000-018f47a0-0000-7000-8000-000000000003",
        );
        const captured = yield* scheduleHost.runPrompt(
          regularChat.id,
          runId,
          textPrompt("scheduled prompt"),
          () => Effect.void,
        );
        assert.deepStrictEqual(captured, {
          runId,
          outcome: "completed",
          events: [{ type: "run-started" }],
          finalAssistantText: `captured:${regularChat.id}`,
        });
        yield* scheduleHost.deliver(regularChat.id, "scheduled delivery");
        assert.deepInclude(sentMessages, { chatId: regularChat.id, content: "scheduled delivery" });
        yield* scheduleHost.publish(regularChat.id, "scheduled publish");
        assert.deepInclude(sentMessages, { chatId: regularChat.id, content: "scheduled publish" });

        const remoteThreads = new Set(["thread-1"]);
        const deletedThreads: string[] = [];
        const remoteMessages: string[] = [];
        let createdThreads = 0;
        let rejectCreate = false;
        let rejectSend = false;
        let rejectCleanup = false;
        let archiveBeforeBinding: Chat.ChatId | null = null;
        const adapter: Schedule.SchedulePlatform = {
          platform: "discord",
          resolveTarget: () => Effect.die("External lookup belongs to Discord tests"),
          validateTarget: (target) =>
            target.workspaceExternalId !== "1.10" ||
            (target.kind === "chat" && !remoteThreads.has(target.chatExternalId))
              ? Effect.fail(
                  new Schedule.ScheduleHostError({ message: "Remote destination missing" }),
                )
              : Effect.void,
          createThread: () =>
            Effect.gen(function* () {
              if (rejectCreate)
                return yield* new Schedule.ScheduleHostError({ message: "Create rejected" });
              const externalId = `${++createdThreads}`;
              remoteThreads.add(externalId);
              if (archiveBeforeBinding !== null) yield* chats.archive(archiveBeforeBinding, 8_000);
              return externalId;
            }).pipe(
              Effect.mapError(
                (error) => new Schedule.ScheduleHostError({ message: error.message }),
              ),
            ),
          deleteThread: (externalId) =>
            Effect.gen(function* () {
              deletedThreads.push(externalId);
              if (rejectCleanup)
                return yield* new Schedule.ScheduleHostError({ message: "Cleanup rejected" });
              remoteThreads.delete(externalId);
            }),
          send: ({ content }) =>
            Effect.gen(function* () {
              if (rejectSend)
                return yield* new Schedule.ScheduleHostError({ message: "Send rejected" });
              remoteMessages.push(content);
            }),
        };
        const discordHost = (yield* Schedule.ScheduleRunHostFactory)(adapter);
        assert.instanceOf(
          yield* scheduleHost
            .resolveTarget({ kind: "workspace", workspaceId: discordWorkspace.id })
            .pipe(Effect.flip),
          Schedule.ScheduleHostError,
        );
        const scheduledDiscordId = Chat.ChatId.make("018f47a0-0000-7000-8000-000000000020");
        const destination = {
          kind: "workspace",
          workspaceId: discordWorkspace.id,
          newChatId: scheduledDiscordId,
        } satisfies Schedule.ScheduleRunDestination;
        const target = yield* discordHost.prepare(destination);
        assert.strictEqual(createdThreads, 0);
        assert.instanceOf(
          yield* discordHost
            .resolveTarget({ kind: "chat", chatId: target.chatId })
            .pipe(Effect.flip),
          Schedule.ScheduleHostError,
        );
        yield* Effect.all(
          [
            discordHost.materialize({ destination, target, title: "Daily report" }),
            discordHost.materialize({ destination, target, title: "Daily report" }),
          ],
          { concurrency: "unbounded" },
        );
        assert.strictEqual(createdThreads, 1);
        assert.deepStrictEqual(
          yield* application.findChatPlatformBinding(target.chatId),
          Option.some({ platform: "discord", externalId: "1" }),
        );
        yield* discordHost.publish(target.chatId, "remote publication");
        assert.deepStrictEqual(remoteMessages, ["remote publication"]);
        rejectSend = true;
        assert.strictEqual(
          (yield* discordHost.deliver(target.chatId, "failed send").pipe(Effect.flip)).message,
          "Send rejected",
        );
        assert.isTrue(remoteThreads.has("1"));
        assert.deepStrictEqual(deletedThreads, []);
        yield* discordHost.materialize({
          destination: { kind: "chat", chatId: discordChat.id },
          target: { chatId: discordChat.id, workspaceId: discordWorkspace.id, cwd: defaultCwd },
          title: "Existing destination",
        });
        assert.strictEqual(createdThreads, 1);

        const failedDestination = {
          ...destination,
          newChatId: Chat.ChatId.make("018f47a0-0000-7000-8000-000000000021"),
        };
        const failedTarget = yield* discordHost.prepare(failedDestination);
        rejectCreate = true;
        assert.strictEqual(
          (yield* discordHost
            .materialize({
              destination: failedDestination,
              target: failedTarget,
              title: "Failed create",
            })
            .pipe(Effect.flip)).message,
          "Create rejected",
        );
        assert.deepStrictEqual(deletedThreads, []);
        rejectCreate = false;
        rejectCleanup = true;
        archiveBeforeBinding = failedTarget.chatId;
        const bindFailure = yield* discordHost
          .materialize({
            destination: failedDestination,
            target: failedTarget,
            title: "Failed bind",
          })
          .pipe(Effect.flip);
        assert.include(bindFailure.message, "Could not bind");
        assert.notInclude(bindFailure.message, "Cleanup rejected");
        assert.deepStrictEqual(deletedThreads, ["2"]);
        assert.isTrue(
          Option.isNone(yield* application.findChatPlatformBinding(failedTarget.chatId)),
        );

        yield* fileSystem.remove(defaultCwd, { recursive: true });
        assertApplicationError(
          yield* application
            .createChat({ workspaceId: regularWorkspace.id, externalId: "missing-cwd" })
            .pipe(Effect.flip),
          "invalid-state",
        );
        assert.isTrue(
          Option.isNone(yield* chats.findByExternalId(regularWorkspace.id, "missing-cwd")),
        );
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
      const insertionFailure = new PersistenceError({ message: "database insert rejected" });
      const logs: Array<ReturnType<typeof Logger.formatStructured.log>> = [];
      const logger = Logger.make((options) => {
        logs.push(Logger.formatStructured.log(options));
      });
      let removalFails = false;
      const failingChats = Layer.effect(
        ChatRepository,
        Effect.gen(function* () {
          const chats = yield* ChatRepository;
          return ChatRepository.of({
            ...chats,
            create: () => Effect.fail(insertionFailure),
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
            removalFails
              ? Effect.fail(new AgentError({ message: "private cleanup details" }))
              : fileSystem
                  .remove(path.join(sessionsDir, `${chatId}.jsonl`), { force: true })
                  .pipe(Effect.orDie),
        }),
      );
      const runtimeLayer = Layer.succeed(
        AgentRuntime,
        AgentRuntime.of({
          availableModels: () => Effect.die("unexpected model catalog read"),
          switchModel: () => Effect.die("unexpected model switch"),
          askBtw: () => Effect.die("unexpected side question"),
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
        renameChatBranch: () => Effect.die("unexpected branch rename"),
        removeChat: () => Effect.die("unexpected worktree removal"),
      };

      yield* Effect.gen(function* () {
        const application = yield* Application;
        const chats = yield* ChatRepository;
        const direct = yield* application.createWorkspace({
          name: "direct",
          platform: "web",
          externalId: null,
          defaultCwd: directCwd,
          worktree: null,
        });
        const directError = yield* application
          .createChat({ workspaceId: direct.id, externalId: null })
          .pipe(Effect.flip);
        assertApplicationError(directError, "operation");
        assert.include(directError.message, insertionFailure.message);
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
          platform: "web",
          externalId: null,
          defaultCwd: repositoryCwd,
          worktree: { branch: "main", prefix: "chat/" },
        });
        const worktreeError = yield* application
          .createChat({ workspaceId: worktree.id, externalId: null })
          .pipe(Effect.flip);
        assertApplicationError(worktreeError, "operation");
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

        removalFails = true;
        const rollbackError = yield* application
          .createChat({ workspaceId: worktree.id, externalId: null })
          .pipe(Effect.flip);
        assertApplicationError(rollbackError, "operation");
        assert.include(rollbackError.message, insertionFailure.message);
        assert.notInclude(rollbackError.message, "private cleanup details");
        const retainedSessionId = createdSessionIds[2];
        if (retainedSessionId === undefined) {
          return yield* Effect.die("Rollback session was not created");
        }
        assert.isTrue(
          yield* fileSystem.exists(path.join(sessionsDir, `${retainedSessionId}.jsonl`)),
        );
        assert.isFalse(yield* fileSystem.exists(worktreeCwd));
        assert.isFalse(yield* fileSystem.exists(branchMarker));
        assert.isTrue(Option.isNone(yield* chats.findById(retainedSessionId)));
        const errors = logs.filter((entry) => entry.level === "ERROR");
        assert.strictEqual(errors.length, 1);
        assert.deepInclude(errors[0]?.annotations, {
          component: "application",
          operation: "create-chat",
          phase: "session-rollback",
          chatId: retainedSessionId,
          workspaceId: worktree.id,
        });
        assert.notInclude(JSON.stringify(logs), "private cleanup details");
      }).pipe(
        Effect.provide(ApplicationLayer.layer(gitWorktree)),
        Effect.provide(repositories),
        Effect.provide(sessionsLayer),
        Effect.provide(runtimeLayer),
        Effect.provide(BunCrypto.layer),
        Effect.provide(Logger.layer([logger])),
        Effect.scoped,
      );
    }).pipe(Effect.provide(platformLayer)),
  );
});
