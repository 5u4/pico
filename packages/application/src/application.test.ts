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
import { AgentSessionStore, type CreateAgentSession } from "@pico/contract/agent-session-store";
import { Application } from "@pico/contract/application";
import * as Chat from "@pico/contract/chat-model";
import { ChatRepository } from "@pico/contract/chat-repository";
import {
  AgentError,
  ApplicationError,
  ChatClosed,
  GitError,
  PersistenceError,
  WorkspaceBindingInvalid,
} from "@pico/contract/errors";
import { AbsolutePath } from "@pico/contract/path";
import * as Schedule from "@pico/contract/schedule";
import * as Workspace from "@pico/contract/workspace-model";
import { WorkspaceRepository } from "@pico/contract/workspace-repository";
import type {
  CreateWorktreeOptions,
  GitWorktree,
  RenameChatBranchResult,
} from "@pico/contract/worktree";
import * as Persistence from "@pico/persistence/layer";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
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
      const createdSessions: Array<CreateAgentSession> = [];
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
            Effect.sync(() => {
              sentMessages.push({ chatId, content });
            }).pipe(
              Effect.andThen(
                Effect.suspend(() =>
                  sendFailure === null ? Effect.void : Effect.fail(sendFailure),
                ),
              ),
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
          textPrompt("scheduled prompt"),
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
          "invalid-state",
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
        renameChatBranch: () => Effect.die("unexpected branch rename"),
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

        const directAgain = yield* application.bindWorkspace({
          binding,
          workspaceName: "ignored direct rename",
          configuration: { kind: "direct", cwd: secondCwd },
        });
        assert.deepStrictEqual(directAgain, { ...rebound, worktree: null });

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
        Effect.provide(persistenceLayer),
        Effect.provide(sessionsLayer),
        Effect.provide(runtimeLayer),
        Effect.provide(BunCrypto.layer),
        Effect.scoped,
      );
    }).pipe(Effect.provide(platformLayer)),
  );

  it.effect("message and bind creation races converge on the requested configuration", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const temporaryDirectory = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "pico-application-binding-race-",
      });
      const defaultCwd = AbsolutePath.make(path.join(temporaryDirectory, "default"));
      const repositoryCwd = AbsolutePath.make(path.join(temporaryDirectory, "repository"));
      const worktreeCwd = AbsolutePath.make(path.join(temporaryDirectory, "worktree"));
      yield* fileSystem.makeDirectory(defaultCwd);
      yield* fileSystem.makeDirectory(repositoryCwd);
      const settings = { branch: "main", prefix: "bound/" };
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
      const sessionsLayer = Layer.succeed(
        AgentSessionStore,
        AgentSessionStore.of({ create: () => Effect.void, remove: () => Effect.void }),
      );
      const gitWorktree: GitWorktree = {
        validate: () => Effect.void,
        create: (options, use) =>
          Effect.gen(function* () {
            assert.strictEqual(options.repositoryCwd, repositoryCwd);
            assert.deepStrictEqual(options.settings, settings);
            return yield* use(worktreeCwd);
          }),
        inspectChat: () => Effect.succeed({ kind: "not-managed" }),
        renameChatBranch: () => Effect.die("unexpected branch rename"),
        removeChat: () => Effect.die("unexpected worktree removal"),
      };

      for (const winner of ["message", "binding"] as const) {
        const waiting = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const blockedName = winner === "message" ? "binding" : "message";
        const storeFile = AbsolutePath.make(path.join(temporaryDirectory, `${winner}.db`));
        const persistenceLayer = Persistence.layer(storeFile);
        const gatedWorkspaces = Layer.effect(
          WorkspaceRepository,
          Effect.gen(function* () {
            const repository = yield* WorkspaceRepository;
            return WorkspaceRepository.of({
              ...repository,
              getOrCreateByBinding: (candidate) =>
                Effect.gen(function* () {
                  if (candidate.name === blockedName) {
                    yield* Deferred.succeed(waiting, undefined);
                    yield* Deferred.await(release);
                  }
                  return yield* repository.getOrCreateByBinding(candidate);
                }),
            });
          }),
        ).pipe(Layer.provide(persistenceLayer));

        yield* Effect.gen(function* () {
          const application = yield* Application;
          const chats = yield* ChatRepository;
          const binding = Workspace.WorkspaceBinding.make({
            platform: "discord",
            externalId: winner,
          });
          const messageCreation = application.getOrCreateWorkspaceByBinding({
            name: "message",
            binding,
            defaultCwd,
            worktree: null,
          });
          const bind = application.bindWorkspace({
            binding,
            workspaceName: "binding",
            configuration: { kind: "worktree", repository: repositoryCwd, settings },
          });
          const blocked = yield* (winner === "message" ? bind : messageCreation).pipe(
            Effect.forkChild,
          );
          yield* Deferred.await(waiting);
          const first = yield* winner === "message" ? messageCreation : bind;
          const initialChat = yield* application.createChat({
            workspaceId: first.id,
            externalId: "before-release",
          });
          assert.strictEqual(initialChat.cwd, winner === "message" ? defaultCwd : worktreeCwd);

          yield* Deferred.succeed(release, undefined);
          const second = yield* Fiber.join(blocked);
          assert.strictEqual(second.id, first.id);
          assert.deepStrictEqual(second, {
            ...first,
            defaultCwd: repositoryCwd,
            worktree: settings,
          });
          assert.deepStrictEqual(
            Option.getOrThrow(yield* application.findWorkspaceByPlatformId("discord", winner)),
            second,
          );
          const nextChat = yield* application.createChat({
            workspaceId: second.id,
            externalId: "after-release",
          });
          assert.strictEqual(nextChat.cwd, worktreeCwd);
          assert.strictEqual(
            Option.getOrThrow(yield* chats.findById(initialChat.id)).cwd,
            initialChat.cwd,
          );
        }).pipe(
          Effect.provide(ApplicationLayer.layer(gitWorktree)),
          Effect.provide(Layer.merge(persistenceLayer, gatedWorkspaces)),
          Effect.provide(sessionsLayer),
          Effect.provide(runtimeLayer),
          Effect.provide(BunCrypto.layer),
          Effect.scoped,
        );
      }
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
        renameChatBranch: () => Effect.die("unexpected branch rename"),
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
            textPrompt("scheduled"),
            () => Effect.void,
          )
          .pipe(Effect.forkChild);
        yield* Deferred.await(scheduledStarted);
        yield* application.abort(chat.id);
        assert.strictEqual(aborts, 1);
        assert.strictEqual((yield* Fiber.join(scheduled)).outcome, "aborted");

        const send = yield* application
          .sendMessage(chat.id, textPrompt("in flight"))
          .pipe(Effect.forkChild);
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
          yield* application.sendMessage(chat.id, textPrompt("late")).pipe(Effect.flip),
          ChatClosed,
        );
        assert.instanceOf(yield* application.contextUsage(chat.id).pipe(Effect.flip), ChatClosed);
        assert.instanceOf(yield* application.shake(chat.id, "elide").pipe(Effect.flip), ChatClosed);
        yield* application.abort(chat.id);
        assert.strictEqual(aborts, 1);
        assert.deepStrictEqual(yield* application.transcript(chat.id), runtimeTranscript);

        const missingChatId = Chat.ChatId.make("018f47a0-0000-7000-8000-000000000099");
        assertApplicationError(
          yield* application.sendMessage(missingChatId, textPrompt("missing")).pipe(Effect.flip),
          "not-found",
        );
        assertApplicationError(
          yield* application.contextUsage(missingChatId).pipe(Effect.flip),
          "not-found",
        );
        assertApplicationError(
          yield* application.shake(missingChatId, "elide").pipe(Effect.flip),
          "not-found",
        );
        assertApplicationError(
          yield* application.abort(missingChatId).pipe(Effect.flip),
          "not-found",
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
        renameChatBranch: () => Effect.die("unexpected branch rename"),
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
        const closeError = yield* application
          .closeChat(failedChat.id, { allowDirtyWorktree: true })
          .pipe(Effect.flip);
        assertApplicationError(closeError, "operation");
        assert.include(closeError.message, "dispose failed");
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
          binding: null,
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
          binding: null,
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

  it.effect("names only eligible worktree chats and slugifies valid topics", () =>
    Effect.gen(function* () {
      const directWorkspaceId = Workspace.WorkspaceId.make("018f47a0-0000-7000-8000-000000000010");
      const worktreeWorkspaceId = Workspace.WorkspaceId.make(
        "018f47a0-0000-7000-8000-000000000011",
      );
      const missingNamingWorkspaceId = Workspace.WorkspaceId.make(
        "018f47a0-0000-7000-8000-000000000015",
      );
      const directChatId = Chat.ChatId.make("018f47a0-0000-7000-8000-000000000012");
      const archivedChatId = Chat.ChatId.make("018f47a0-0000-7000-8000-000000000013");
      const eligibleChatId = Chat.ChatId.make("018f47a0-0000-7000-8000-000000000014");
      const orphanedChatId = Chat.ChatId.make("018f47a0-0000-7000-8000-000000000016");
      const directCwd = AbsolutePath.make("/tmp/pico-direct");
      const worktreeCwd = AbsolutePath.make(`/tmp/pico-worktrees/${eligibleChatId}`);
      const workspaces = new Map<Workspace.WorkspaceId, Workspace.Workspace>([
        [
          directWorkspaceId,
          {
            id: directWorkspaceId,
            name: "direct",
            binding: null,
            defaultCwd: directCwd,
            worktree: null,
            createdAt: 1,
          },
        ],
        [
          worktreeWorkspaceId,
          {
            id: worktreeWorkspaceId,
            name: "worktree",
            binding: null,
            defaultCwd: directCwd,
            worktree: { branch: "main", prefix: "chat/" },
            createdAt: 1,
          },
        ],
      ]);
      const chats = new Map<Chat.ChatId, Chat.Chat>([
        [
          directChatId,
          {
            id: directChatId,
            workspaceId: directWorkspaceId,
            cwd: directCwd,
            externalId: null,
            createdAt: 1,
            archivedAt: null,
          },
        ],
        [
          archivedChatId,
          {
            id: archivedChatId,
            workspaceId: worktreeWorkspaceId,
            cwd: worktreeCwd,
            externalId: null,
            createdAt: 1,
            archivedAt: 2,
          },
        ],
        [
          orphanedChatId,
          {
            id: orphanedChatId,
            workspaceId: missingNamingWorkspaceId,
            cwd: directCwd,
            externalId: null,
            createdAt: 1,
            archivedAt: null,
          },
        ],
        [
          eligibleChatId,
          {
            id: eligibleChatId,
            workspaceId: worktreeWorkspaceId,
            cwd: worktreeCwd,
            externalId: null,
            createdAt: 1,
            archivedAt: null,
          },
        ],
      ]);
      const repositories = Layer.merge(
        Layer.succeed(
          ChatRepository,
          ChatRepository.of({
            create: () => Effect.die("unexpected chat create"),
            archive: () => Effect.die("unexpected chat archive"),
            findById: (id) => Effect.succeed(Option.fromUndefinedOr(chats.get(id))),
            findByExternalId: () => Effect.die("unexpected external chat lookup"),
          }),
        ),
        Layer.succeed(
          WorkspaceRepository,
          WorkspaceRepository.of({
            create: () => Effect.die("unexpected workspace create"),
            getOrCreateByBinding: () => Effect.die("unexpected bound workspace creation"),
            findById: (id) => Effect.succeed(Option.fromUndefinedOr(workspaces.get(id))),
            findByBinding: () => Effect.die("unexpected workspace binding lookup"),
            replaceConfiguration: () => Effect.die("unexpected workspace replacement"),
          }),
        ),
      );
      const renamed = yield* Deferred.make<void>();
      const renames: Array<{
        readonly chatId: Chat.ChatId;
        readonly cwd: AbsolutePath;
        readonly prefix: string;
        readonly topic: string;
      }> = [];
      const gitWorktree: GitWorktree = {
        validate: () => Effect.die("unexpected validation"),
        create: () => Effect.die("unexpected worktree creation"),
        inspectChat: () => Effect.die("unexpected worktree inspection"),
        renameChatBranch: (input) =>
          Effect.sync(() => {
            renames.push(input);
          }).pipe(
            Effect.andThen(Deferred.succeed(renamed, undefined)),
            Effect.as({ kind: "renamed" } satisfies RenameChatBranchResult),
          ),
        removeChat: () => Effect.die("unexpected worktree removal"),
      };

      yield* Effect.gen(function* () {
        const handler = (yield* ApplicationLayer.makeBranchNaming(gitWorktree)).handle;
        let generations = 0;
        const generate = async () => {
          generations += 1;
          return "Fix-GitHub-Flow";
        };
        handler({ chatId: missingChatId, generateTopic: generate });
        handler({ chatId: archivedChatId, generateTopic: generate });
        handler({ chatId: directChatId, generateTopic: generate });
        handler({ chatId: orphanedChatId, generateTopic: generate });
        for (const topic of [
          "single",
          "修复-登录",
          "1fix-widget",
          "one-two-three-four-five-six-seven",
          `${"a".repeat(47)}-b`,
        ]) {
          handler({ chatId: eligibleChatId, generateTopic: async () => topic });
        }
        handler({ chatId: eligibleChatId, generateTopic: async () => null });
        handler({ chatId: eligibleChatId, generateTopic: generate });
        yield* Deferred.await(renamed);

        assert.strictEqual(generations, 1);
        assert.deepStrictEqual(renames, [
          {
            chatId: eligibleChatId,
            cwd: worktreeCwd,
            prefix: "chat/",
            topic: "fix-github-flow",
          },
        ]);
      }).pipe(Effect.provide(repositories), Effect.scoped);
    }),
  );

  it.effect("revalidates archive and worktree configuration after generation", () =>
    Effect.gen(function* () {
      const firstWorkspaceId = Workspace.WorkspaceId.make("018f47a0-0000-7000-8000-000000000020");
      const firstChatId = Chat.ChatId.make("018f47a0-0000-7000-8000-000000000021");
      const cwd = AbsolutePath.make(`/tmp/pico-worktrees/${firstChatId}`);
      let chat: Chat.Chat = {
        id: firstChatId,
        workspaceId: firstWorkspaceId,
        cwd,
        externalId: null,
        createdAt: 1,
        archivedAt: null,
      };
      let workspace: Workspace.Workspace = {
        id: firstWorkspaceId,
        name: "worktree",
        binding: null,
        defaultCwd: AbsolutePath.make("/tmp/pico-repository"),
        worktree: { branch: "main", prefix: "chat/" },
        createdAt: 1,
      };
      let chatReads = 0;
      let workspaceReads = 0;
      let secondChatRead = Promise.withResolvers<void>();
      let secondWorkspaceRead: PromiseWithResolvers<void> | undefined;
      const repositories = Layer.merge(
        Layer.succeed(
          ChatRepository,
          ChatRepository.of({
            create: () => Effect.die("unexpected chat create"),
            archive: () => Effect.die("unexpected chat archive"),
            findById: (id) =>
              Effect.sync(() => {
                if (id !== firstChatId) return Option.none<Chat.Chat>();
                chatReads += 1;
                if (chatReads === 2) secondChatRead.resolve();
                return Option.some(chat);
              }),
            findByExternalId: () => Effect.die("unexpected external chat lookup"),
          }),
        ),
        Layer.succeed(
          WorkspaceRepository,
          WorkspaceRepository.of({
            create: () => Effect.die("unexpected workspace create"),
            getOrCreateByBinding: () => Effect.die("unexpected bound workspace creation"),
            findById: (id) =>
              Effect.sync(() => {
                if (id !== firstWorkspaceId) return Option.none<Workspace.Workspace>();
                workspaceReads += 1;
                if (workspaceReads === 2) secondWorkspaceRead?.resolve();
                return Option.some(workspace);
              }),
            findByBinding: () => Effect.die("unexpected workspace binding lookup"),
            replaceConfiguration: () => Effect.die("unexpected workspace replacement"),
          }),
        ),
      );
      const renames: string[] = [];
      const renamed = yield* Deferred.make<void>();
      const gitWorktree: GitWorktree = {
        validate: () => Effect.die("unexpected validation"),
        create: () => Effect.die("unexpected worktree creation"),
        inspectChat: () => Effect.die("unexpected worktree inspection"),
        renameChatBranch: ({ topic }) =>
          Effect.sync(() => {
            renames.push(topic);
          }).pipe(
            Effect.andThen(Deferred.succeed(renamed, undefined)),
            Effect.as({ kind: "renamed" } satisfies RenameChatBranchResult),
          ),
        removeChat: () => Effect.die("unexpected worktree removal"),
      };

      yield* Effect.gen(function* () {
        const handler = (yield* ApplicationLayer.makeBranchNaming(gitWorktree)).handle;

        const archivedGeneration = Promise.withResolvers<string | null>();
        const archivedStarted = Promise.withResolvers<void>();
        handler({
          chatId: firstChatId,
          generateTopic: () => {
            archivedStarted.resolve();
            return archivedGeneration.promise;
          },
        });
        yield* Effect.promise(() => archivedStarted.promise);
        chat = { ...chat, archivedAt: 2 };
        archivedGeneration.resolve("archive-race");
        yield* Effect.promise(() => secondChatRead.promise);
        yield* Effect.yieldNow;
        assert.deepStrictEqual(renames, []);

        chat = { ...chat, archivedAt: null };
        chatReads = 0;
        workspaceReads = 0;
        secondChatRead = Promise.withResolvers<void>();
        const configSecondWorkspaceRead = Promise.withResolvers<void>();
        secondWorkspaceRead = configSecondWorkspaceRead;
        const configGeneration = Promise.withResolvers<string | null>();
        const configStarted = Promise.withResolvers<void>();
        handler({
          chatId: firstChatId,
          generateTopic: () => {
            configStarted.resolve();
            return configGeneration.promise;
          },
        });
        yield* Effect.promise(() => configStarted.promise);
        workspace = {
          ...workspace,
          worktree: { branch: "release", prefix: "renamed/" },
        };
        configGeneration.resolve("config-race");
        yield* Effect.promise(() => configSecondWorkspaceRead.promise);
        yield* Effect.yieldNow;
        assert.deepStrictEqual(renames, []);

        chatReads = 0;
        workspaceReads = 0;
        secondChatRead = Promise.withResolvers<void>();
        const cwdGeneration = Promise.withResolvers<string | null>();
        const cwdStarted = Promise.withResolvers<void>();
        handler({
          chatId: firstChatId,
          generateTopic: () => {
            cwdStarted.resolve();
            return cwdGeneration.promise;
          },
        });
        yield* Effect.promise(() => cwdStarted.promise);
        chat = { ...chat, cwd: AbsolutePath.make("/tmp/pico-worktrees/moved") };
        cwdGeneration.resolve("cwd-race");
        yield* Effect.promise(() => secondChatRead.promise);
        yield* Effect.yieldNow;
        assert.deepStrictEqual(renames, []);

        chatReads = 0;
        workspaceReads = 0;
        handler({ chatId: firstChatId, generateTopic: async () => "valid-final-topic" });
        yield* Deferred.await(renamed);
        assert.deepStrictEqual(renames, ["valid-final-topic"]);
      }).pipe(Effect.provide(repositories), Effect.scoped);
    }),
  );

  it.effect("contains repository, model, and Git failures across background requests", () =>
    Effect.gen(function* () {
      const workspaceId = Workspace.WorkspaceId.make("018f47a0-0000-7000-8000-000000000030");
      const namingChatId = Chat.ChatId.make("018f47a0-0000-7000-8000-000000000031");
      const cwd = AbsolutePath.make(`/tmp/pico-worktrees/${namingChatId}`);
      const chat: Chat.Chat = {
        id: namingChatId,
        workspaceId,
        cwd,
        externalId: null,
        createdAt: 1,
        archivedAt: null,
      };
      const workspace: Workspace.Workspace = {
        id: workspaceId,
        name: "worktree",
        binding: null,
        defaultCwd: AbsolutePath.make("/tmp/pico-repository"),
        worktree: { branch: "main", prefix: "chat/" },
        createdAt: 1,
      };
      const repositoryFailureObserved = Promise.withResolvers<void>();
      const logs: Array<ReturnType<typeof Logger.formatStructured.log>> = [];
      const failuresLogged = Promise.withResolvers<void>();
      const logger = Logger.make((options) => {
        if (options.logLevel !== "Error") return;
        logs.push(Logger.formatStructured.log(options));
        if (logs.length === 4) failuresLogged.resolve();
      });
      let repositoryFails = true;
      const repositories = Layer.merge(
        Layer.succeed(
          ChatRepository,
          ChatRepository.of({
            create: () => Effect.die("unexpected chat create"),
            archive: () => Effect.die("unexpected chat archive"),
            findById: () =>
              repositoryFails
                ? Effect.sync(() => repositoryFailureObserved.resolve()).pipe(
                    Effect.andThen(
                      Effect.fail(
                        new PersistenceError({
                          message: "chat.findById: ConnectionError, SQLite code 14",
                        }),
                      ),
                    ),
                  )
                : Effect.succeed(Option.some(chat)),
            findByExternalId: () => Effect.die("unexpected external chat lookup"),
          }),
        ),
        Layer.succeed(
          WorkspaceRepository,
          WorkspaceRepository.of({
            create: () => Effect.die("unexpected workspace create"),
            getOrCreateByBinding: () => Effect.die("unexpected bound workspace creation"),
            findById: () => Effect.succeed(Option.some(workspace)),
            findByBinding: () => Effect.die("unexpected workspace binding lookup"),
            replaceConfiguration: () => Effect.die("unexpected workspace replacement"),
          }),
        ),
      );
      const gitFailureObserved = yield* Deferred.make<void>();
      const renamed = yield* Deferred.make<void>();
      let gitFails = true;
      let renameAttempts = 0;
      const gitWorktree: GitWorktree = {
        validate: () => Effect.die("unexpected validation"),
        create: () => Effect.die("unexpected worktree creation"),
        inspectChat: () => Effect.die("unexpected worktree inspection"),
        renameChatBranch: () =>
          Effect.gen(function* () {
            renameAttempts += 1;
            if (gitFails) {
              yield* Deferred.succeed(gitFailureObserved, undefined);
              return yield* Effect.failCause(
                Cause.combine(
                  Cause.fail(
                    new GitError({
                      message: "Failed to rename chat branch: Git exited with code 128",
                    }),
                  ),
                  Cause.combine(
                    Cause.die(new Error("private defect token=secret")),
                    Cause.interrupt(),
                  ),
                ),
              );
            }
            yield* Deferred.succeed(renamed, undefined);
            return { kind: "renamed" } satisfies RenameChatBranchResult;
          }),
        removeChat: () => Effect.die("unexpected worktree removal"),
      };

      yield* Effect.gen(function* () {
        const handler = (yield* ApplicationLayer.makeBranchNaming(gitWorktree)).handle;
        handler({ chatId: namingChatId, generateTopic: async () => "repository-failure" });
        yield* Effect.promise(() => repositoryFailureObserved.promise);
        repositoryFails = false;

        const modelFailureObserved = Promise.withResolvers<void>();
        handler({
          chatId: namingChatId,
          generateTopic: () => {
            modelFailureObserved.resolve();
            return Promise.reject(new Error("private model token=secret"));
          },
        });
        yield* Effect.promise(() => modelFailureObserved.promise);

        handler({
          chatId: namingChatId,
          generateTopic: async () => {
            throw new AgentError({ message: "Generate branch topic: HTTP 429" });
          },
        });

        handler({ chatId: namingChatId, generateTopic: async () => "git-failure" });
        yield* Deferred.await(gitFailureObserved);
        gitFails = false;

        handler({ chatId: namingChatId, generateTopic: async () => "final-success" });
        yield* Deferred.await(renamed);
        assert.strictEqual(renameAttempts, 2);
        yield* Effect.promise(() => failuresLogged.promise);

        const pendingGeneration = Promise.withResolvers<string | null>();
        const generationStarted = Promise.withResolvers<void>();
        handler({
          chatId: namingChatId,
          generateTopic: () => {
            generationStarted.resolve();
            return pendingGeneration.promise;
          },
        });
        yield* Effect.promise(() => generationStarted.promise);
      }).pipe(Effect.provide(repositories), Effect.scoped, Effect.provide(Logger.layer([logger])));
      assert.strictEqual(renameAttempts, 2);
      assert.strictEqual(logs.length, 4);
      assert.deepStrictEqual(logs.map((entry) => entry.annotations.phase).sort(), [
        "eligibility",
        "generation",
        "generation",
        "rename",
      ]);
      for (const entry of logs) {
        assert.deepInclude(entry.annotations, {
          component: "application",
          operation: "branch-naming",
          chatId: namingChatId,
        });
        if (entry.annotations.phase !== "eligibility") {
          assert.strictEqual(entry.annotations.workspaceId, workspaceId);
        }
      }
      const output = JSON.stringify(logs);
      assert.include(output, "chat.findById: ConnectionError, SQLite code 14");
      assert.include(output, "Failed to rename chat branch: Git exited with code 128");
      assert.include(output, "Generate branch topic: HTTP 429");
      assert.notInclude(output, "private model token=secret");
      assert.notInclude(output, "private defect token=secret");
      assert.strictEqual(
        logs.find((entry) => entry.annotations.phase === "rename")?.annotations.reason,
        "defect",
      );
      assert.notInclude(output, "git-failure");
    }),
  );
});
