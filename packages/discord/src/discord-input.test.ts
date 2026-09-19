import * as BunCrypto from "@effect/platform-bun/BunCrypto";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import * as BunPath from "@effect/platform-bun/BunPath";
import { assert, describe, it } from "@effect/vitest";
import type { AgentEventEnvelope } from "@pico/contract/agent-event";
import { Publication } from "@pico/contract/agent-event";
import * as AgentMessage from "@pico/contract/agent-message";
import type { ContextUsage } from "@pico/contract/agent-runtime";
import { Application } from "@pico/contract/application";
import * as Chat from "@pico/contract/chat-model";
import { ChatRepository } from "@pico/contract/chat-repository";
import { ApplicationError, ChatClosed } from "@pico/contract/errors";
import { EventRouter } from "@pico/contract/event-router";
import { AbsolutePath } from "@pico/contract/path";
import * as Schedule from "@pico/contract/schedule";
import * as Workspace from "@pico/contract/workspace-model";
import { WorkspaceRepository } from "@pico/contract/workspace-repository";
import * as Persistence from "@pico/persistence/layer";
import { ChannelTypes, InteractionResponseTypes, MessageFlags } from "discordeno";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import * as DiscordAcknowledgement from "./discord-acknowledgement.ts";
import {
  acknowledgeInteraction,
  bindOptions,
  boundWorkspace,
  chatId,
  config,
  defaultCwd,
  handlerFor,
  interaction,
  interactionHandlerFor,
  message,
  startedDelivery,
  workspaceId,
} from "./discord-input.fixture.ts";
import { type DiscordChannel, type DiscordInputBot, install } from "./discord-input.ts";
import * as DiscordOutput from "./discord-output.ts";
import { pumpOutput } from "./layer.ts";

const failingChatId = Chat.ChatId.make("018f47a0-0000-7000-8000-000000000003");

const pngBytes = Uint8Array.from(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  ),
);

describe("discord input", () => {
  it.effect(
    "resolves allowed schedule targets and creates valid public threads without adopting unknown threads",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const channels = new Map<bigint, DiscordChannel>([
            [10n, { id: 10n, guildId: 1n, type: ChannelTypes.GuildText, name: "general" }],
            [11n, { id: 11n, guildId: 1n, type: ChannelTypes.GuildText, name: "other" }],
            [12n, { id: 12n, guildId: 2n, type: ChannelTypes.GuildText }],
            [13n, { id: 13n, guildId: 1n, type: ChannelTypes.GuildVoice }],
            [
              20n,
              {
                id: 20n,
                guildId: 1n,
                parentId: 10n,
                type: ChannelTypes.PublicThread,
                archived: false,
                locked: false,
              },
            ],
            [
              21n,
              {
                id: 21n,
                guildId: 1n,
                parentId: 10n,
                type: ChannelTypes.PublicThread,
                archived: true,
                locked: false,
              },
            ],
            [
              22n,
              {
                id: 22n,
                guildId: 1n,
                parentId: 10n,
                type: ChannelTypes.PublicThread,
                archived: false,
                locked: false,
              },
            ],
            [
              23n,
              {
                id: 23n,
                guildId: 1n,
                parentId: 11n,
                type: ChannelTypes.PublicThread,
                archived: false,
                locked: false,
              },
            ],
          ]);
          const createdThreads: Array<
            Parameters<DiscordInputBot["helpers"]["startThreadWithoutMessage"]>
          > = [];
          const deletedThreads: bigint[] = [];
          const bot: DiscordInputBot = {
            id: 999n,
            events: {},
            helpers: {
              addReaction: async () => undefined,
              deleteOwnReaction: async () => undefined,
              getChannel: async (id) => {
                const channel = channels.get(id);
                if (channel === undefined) throw new Error("Unknown channel");
                return channel;
              },
              sendMessage: async () => {
                throw new Error("Resolution must not publish");
              },
              editChannel: async () => {
                throw new Error("Resolution must not edit");
              },
              startThreadWithMessage: async () => {
                throw new Error("Schedules have no source message");
              },
              startThreadWithoutMessage: async (...args) => {
                assert.match(args[1].name, /\S/u);
                assert.isAtMost(args[1].name.length, 100);
                assert.strictEqual(args[1].type, ChannelTypes.PublicThread);
                createdThreads.push(args);
                return { id: 30n };
              },
              deleteChannel: async (id) => {
                deletedThreads.push(id);
              },
            },
          };
          const chat: Chat.Chat = {
            id: chatId,
            workspaceId,
            externalId: "20",
            cwd: defaultCwd,
            createdAt: 0,
            archivedAt: null,
          };
          let registrations = 0;
          const unused = () => Effect.die("Unexpected application operation");
          const application = Application.of({
            deleteWorkspace: () => Effect.die("unexpected workspace deletion"),
            updateWorkspace: unused,
            listWorkspaces: unused,
            createWorkspace: unused,
            bindWorkspace: unused,
            listChats: unused,
            createChat: unused,
            findWorkspaceByPlatformId: unused,
            findChatPlatformBinding: unused,
            transcript: unused,
            closeChat: unused,
            sendMessage: unused,
            askBtw: unused,
            abort: unused,
            contextUsage: unused,
            availableWorkspaceModels: unused,
            setWorkspaceModel: unused,
            availableModels: unused,
            switchModel: unused,
            shake: unused,
            getOrCreateWorkspaceByBinding: (input) =>
              Effect.sync(() => {
                registrations++;
                assert.strictEqual(input.externalId, "1.10");
                return boundWorkspace;
              }),
            findChatByPlatformId: (_platform, workspaceExternalId, chatExternalId) =>
              Effect.succeed(
                workspaceExternalId === "1.10" && chatExternalId === "20"
                  ? Option.some(chat)
                  : Option.none(),
              ),
            availableSkills: () => Effect.die("unexpected skill command discovery"),
          });
          const { schedule } = yield* install(bot, config, acknowledgeInteraction).pipe(
            Effect.provideService(Application, application),
            Effect.provide(BunCrypto.layer),
          );
          assert.deepStrictEqual(
            yield* schedule.resolveTarget({
              kind: "external-workspace",
              platform: "discord",
              externalId: "10",
            }),
            { kind: "workspace", workspaceId },
          );
          assert.deepStrictEqual(
            yield* schedule.resolveTarget({
              kind: "external-chat",
              platform: "discord",
              externalId: "20",
            }),
            { kind: "chat", chatId },
          );
          assert.deepStrictEqual(createdThreads, []);
          for (const externalId of ["12", "13", "20", "999", "10.0"]) {
            assert.instanceOf(
              yield* schedule
                .resolveTarget({ kind: "external-workspace", platform: "discord", externalId })
                .pipe(Effect.flip),
              Schedule.ScheduleHostError,
            );
          }
          for (const externalId of ["10", "21", "22", "23", "999"]) {
            assert.instanceOf(
              yield* schedule
                .resolveTarget({ kind: "external-chat", platform: "discord", externalId })
                .pipe(Effect.flip),
              Schedule.ScheduleHostError,
            );
          }
          assert.strictEqual(registrations, 1);
          assert.instanceOf(
            yield* schedule
              .validateTarget({
                kind: "chat",
                workspaceExternalId: "1.11",
                chatExternalId: "20",
              })
              .pipe(Effect.flip),
            Schedule.ScheduleHostError,
          );
          assert.strictEqual(
            yield* schedule.createThread({ workspaceExternalId: "1.10", title: "x".repeat(150) }),
            "30",
          );
          assert.deepStrictEqual(createdThreads, [
            [
              10n,
              {
                name: "x".repeat(100),
                type: ChannelTypes.PublicThread,
              },
            ],
          ]);
          assert.strictEqual(
            yield* schedule.createThread({ workspaceExternalId: "1.10", title: "   " }),
            "30",
          );
          assert.strictEqual(createdThreads.length, 2);
          yield* schedule.deleteThread("30");
          assert.deepStrictEqual(deletedThreads, [30n]);
        }),
      ),
  );

  it.effect("owns channel creation, caching, ordering, and the output lookup", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const firstSent = yield* Deferred.make<void>();
        const secondSent = yield* Deferred.make<void>();
        const order: string[] = [];
        const sent: AgentMessage.AgentPrompt[] = [];
        let channelReads = 0;
        let resolveThreadId:
          | ((candidate: Chat.ChatId) => Effect.Effect<Option.Option<bigint>, unknown>)
          | undefined;

        const bot = {
          id: 999n,
          events: {},
          helpers: {
            addReaction: async () => undefined,
            deleteOwnReaction: async () => undefined,
            getChannel: async () => {
              channelReads += 1;
              return { id: 10n, type: ChannelTypes.GuildText, name: "general" };
            },
            sendMessage: async () => undefined,
            editChannel: async () => undefined,
            startThreadWithoutMessage: async () => {
              throw new Error("unexpected schedule");
            },
            deleteChannel: async () => {
              throw new Error("unexpected schedule cleanup");
            },
            startThreadWithMessage: async (_channelId, _messageId, options) => {
              order.push("create-thread");
              assert.deepStrictEqual(options, { name: "hello from pico" });
              return { id: 20n };
            },
          },
        } satisfies DiscordInputBot;

        const application = Application.of({
          deleteWorkspace: () => Effect.die("unexpected workspace deletion"),
          updateWorkspace: () => Effect.die("unexpected workspace update"),
          availableWorkspaceModels: () => Effect.die("unexpected workspace model discovery"),
          setWorkspaceModel: () => Effect.die("unexpected workspace model update"),
          availableModels: () => Effect.die("unexpected model discovery"),
          switchModel: () => Effect.die("unexpected model switch"),
          askBtw: () => Effect.die("unexpected side question"),
          listWorkspaces: () => Effect.die("unexpected workspace list"),
          createWorkspace: () => Effect.die("unexpected explicit workspace creation"),
          getOrCreateWorkspaceByBinding: () =>
            Effect.sync(() => {
              order.push("create-workspace");
              return {
                id: workspaceId,
                name: "general",
                platform: "discord",
                externalId: "1.10",
                defaultCwd,
                worktree: null,
                modelOverride: null,
                createdAt: 0,
              };
            }),
          bindWorkspace: () => Effect.die("unexpected workspace binding"),
          listChats: () => Effect.die("unexpected chat list"),
          createChat: () =>
            Effect.sync(() => {
              order.push("create-chat");
              return {
                id: chatId,
                workspaceId,
                cwd: defaultCwd,
                externalId: "20",
                createdAt: 0,
                archivedAt: null,
              };
            }),
          findWorkspaceByPlatformId: () =>
            Effect.sync(() => {
              order.push("find-workspace");
              return Option.none();
            }),
          findChatByPlatformId: () => Effect.succeed(Option.none()),
          findChatPlatformBinding: () => Effect.die("unexpected chat binding lookup"),
          transcript: () => Effect.die("unexpected transcript read"),
          sendMessage: (_chatId, content) =>
            Effect.gen(function* () {
              order.push("send");
              sent.push(content);
              if (resolveThreadId === undefined) return yield* Effect.die("Resolver not installed");
              assert.strictEqual(
                Option.getOrUndefined(yield* resolveThreadId(chatId).pipe(Effect.orDie)),
                20n,
              );
              yield* Deferred.succeed(sent.length === 1 ? firstSent : secondSent, undefined);
              return startedDelivery;
            }),
          abort: () => Effect.die("unexpected chat abort"),
          contextUsage: () => Effect.die("unexpected context read"),
          shake: () => Effect.die("unexpected chat shake"),
          closeChat: () => Effect.die("unexpected chat close"),
          availableSkills: () => Effect.die("unexpected skill command discovery"),
        });
        resolveThreadId = yield* install(bot, config, acknowledgeInteraction).pipe(
          Effect.map((installed) => installed.resolveThreadId),
          Effect.provideService(Application, application),
          Effect.provide(BunCrypto.layer),
        );
        const handleMessage = handlerFor(bot);

        handleMessage(message({ content: "  hello   from pico  " }));
        yield* Deferred.await(firstSent);
        assert.deepStrictEqual(order, ["create-workspace", "create-thread", "create-chat", "send"]);
        assert.deepStrictEqual(sent, [
          AgentMessage.AgentPrompt.make({ text: "  hello   from pico  ", attachments: [] }),
        ]);
        if (resolveThreadId === undefined) return yield* Effect.die("Resolver not installed");
        assert.strictEqual(Option.getOrUndefined(yield* resolveThreadId(chatId)), 20n);

        handleMessage(message({ channelId: 20n, id: 12n, content: "again" }));
        yield* Deferred.await(secondSent);
        assert.deepStrictEqual(sent, [
          AgentMessage.AgentPrompt.make({ text: "  hello   from pico  ", attachments: [] }),
          AgentMessage.AgentPrompt.make({ text: "again", attachments: [] }),
        ]);
        assert.strictEqual(channelReads, 1);
      }),
    ),
  );

  it.effect(
    "restores cold output, input, and command routing without changing workspace configuration",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const root = yield* fileSystem.makeTempDirectoryScoped({
            prefix: "pico-discord-identity-",
          });
          const repositories = yield* Layer.build(
            Persistence.layer(AbsolutePath.make(path.join(root, "store.db"))),
          );
          const workspaces = Context.get(repositories, WorkspaceRepository);
          const chats = Context.get(repositories, ChatRepository);
          const storedWorkspace = {
            ...boundWorkspace,
            worktree: { branch: "main", prefix: "retained/" },
          } satisfies Workspace.Workspace;
          yield* workspaces.create(storedWorkspace);
          yield* chats.create({
            id: chatId,
            workspaceId,
            cwd: defaultCwd,
            externalId: "20",
            createdAt: 0,
          });
          const persistenceFailure = (cause: { readonly message: string }) =>
            new ApplicationError({ reason: "operation", message: cause.message });
          let channelReads = 0;
          let inputLookups = 0;
          const firstInput = yield* Deferred.make<void>();
          const secondInput = yield* Deferred.make<void>();
          const unknownLookup = yield* Deferred.make<void>();
          const admittedChatIds: Chat.ChatId[] = [];
          const commandChatIds: Chat.ChatId[] = [];
          let bindingLookups = 0;
          const delivered = yield* Deferred.make<void>();
          const sent: Array<{ readonly threadId: bigint; readonly content: string }> = [];
          const bot = {
            id: 999n,
            events: {},
            helpers: {
              addReaction: async () => undefined,
              deleteOwnReaction: async () => undefined,
              getChannel: async (id) => {
                channelReads += 1;
                return {
                  id,
                  guildId: 1n,
                  type: ChannelTypes.PublicThread,
                  parentId: id === 20n ? 10n : 30n,
                };
              },
              sendMessage: async () => undefined,
              editChannel: async () => undefined,
              startThreadWithoutMessage: async () => {
                throw new Error("unexpected schedule");
              },
              deleteChannel: async () => {
                throw new Error("unexpected schedule cleanup");
              },
              startThreadWithMessage: async () => {
                throw new Error("cold output must not create Discord threads");
              },
            },
          } satisfies DiscordInputBot;
          const application = Application.of({
            deleteWorkspace: () => Effect.die("unexpected workspace deletion"),
            updateWorkspace: () => Effect.die("unexpected workspace update"),
            availableWorkspaceModels: () => Effect.die("unexpected workspace model discovery"),
            setWorkspaceModel: () => Effect.die("unexpected workspace model update"),
            availableModels: () => Effect.die("unexpected model discovery"),
            switchModel: () => Effect.die("unexpected model switch"),
            askBtw: () => Effect.die("unexpected side question"),
            listWorkspaces: () => Effect.die("unexpected workspace list"),
            createWorkspace: () => Effect.die("unexpected explicit workspace creation"),
            getOrCreateWorkspaceByBinding: () => Effect.die("unexpected workspace creation"),
            bindWorkspace: () => Effect.die("unexpected workspace binding"),
            listChats: () => Effect.die("unexpected chat list"),
            createChat: () => Effect.die("unexpected chat creation"),
            findWorkspaceByPlatformId: () => Effect.die("unexpected workspace lookup"),
            findChatByPlatformId: (platform, workspaceExternalId, externalId) =>
              Effect.gen(function* () {
                inputLookups += 1;
                const workspace = yield* workspaces.findByBinding({
                  platform,
                  externalId: workspaceExternalId,
                });
                const chat = Option.isNone(workspace)
                  ? Option.none<Chat.Chat>()
                  : yield* chats.findByExternalId(workspace.value.id, externalId);
                if (Option.isNone(chat)) yield* Deferred.succeed(unknownLookup, undefined);
                return chat;
              }).pipe(Effect.mapError(persistenceFailure)),
            findChatPlatformBinding: (requestedChatId) =>
              Effect.sync(() => {
                bindingLookups += 1;
                return Option.some({
                  platform: "discord",
                  externalId: requestedChatId === chatId ? "20" : "not-a-thread",
                });
              }),
            transcript: () => Effect.die("unexpected transcript read"),
            sendMessage: (id) =>
              Effect.gen(function* () {
                admittedChatIds.push(id);
                yield* Deferred.succeed(
                  admittedChatIds.length === 1 ? firstInput : secondInput,
                  undefined,
                );
                return startedDelivery;
              }),
            abort: () => Effect.die("unexpected chat abort"),
            contextUsage: (id) =>
              Effect.sync(() => {
                commandChatIds.push(id);
                return { kind: "unavailable" } satisfies ContextUsage;
              }),
            shake: () => Effect.die("unexpected chat shake"),
            closeChat: () => Effect.die("unexpected chat close"),
            availableSkills: () => Effect.die("unexpected skill command discovery"),
          });
          const { resolveThreadId } = yield* install(bot, config, acknowledgeInteraction).pipe(
            Effect.provideService(Application, application),
            Effect.provide(BunCrypto.layer),
          );
          const envelopes: ReadonlyArray<AgentEventEnvelope> = [
            {
              chatId: failingChatId,
              publication: Publication.make(1),
              origin: "session",
              event: { type: "notice", level: "error", message: "invalid persisted binding" },
            },
            {
              chatId,
              event: { type: "run-started" },
              publication: Publication.make(2),
              origin: "delivery",
            },
            {
              chatId,
              publication: Publication.make(3),
              origin: "delivery",
              event: {
                type: "message-settled",
                message: {
                  role: "assistant",
                  id: AgentMessage.AgentMessageId.make("scheduled-after-restart"),
                  status: "completed",
                  stopReason: "stop",
                  content: [{ type: "text", text: "scheduled after restart" }],
                  model: "pico/schedule",
                  timestamp: 0,
                },
              },
            },
            {
              chatId,
              event: { type: "run-finished", outcome: "completed" },
              publication: Publication.make(4),
              origin: "delivery",
            },
          ];
          const eventRouter = EventRouter.of({
            open: (filter) =>
              Effect.sync(() => {
                assert.isTrue(envelopes.every(filter));
                return {
                  events: Stream.fromIterable(envelopes),
                  setFilter: () => Effect.void,
                };
              }),
            drain: () => Deferred.await(delivered),
          });
          const scope = yield* Scope.Scope;
          const dispatch = DiscordOutput.make(
            {
              send: (threadId, output) =>
                Effect.sync(() => {
                  sent.push({ threadId, content: output.content });
                  return 1n;
                }),
              edit: () => Effect.void,
              renameThread: () => Effect.void,
              triggerTyping: () => Effect.void,
            },
            scope,
            { showToolCalls: false, showThinking: false },
          );
          yield* pumpOutput(eventRouter, resolveThreadId, (threadId, envelope) =>
            dispatch(threadId, envelope).pipe(
              Effect.tap(() =>
                envelope.event.type === "run-finished"
                  ? Deferred.succeed(delivered, undefined)
                  : Effect.void,
              ),
            ),
          );
          yield* eventRouter.drain();

          assert.deepStrictEqual(sent, [{ threadId: 20n, content: "scheduled after restart" }]);
          assert.strictEqual(bindingLookups, 2);
          assert.strictEqual(channelReads, 0);
          const handleMessage = handlerFor(bot);
          handleMessage(message({ channelId: 20n }));
          yield* Deferred.await(firstInput);
          assert.deepStrictEqual(admittedChatIds, [chatId]);
          assert.deepStrictEqual(
            Option.getOrThrow(yield* workspaces.findById(workspaceId)),
            storedWorkspace,
          );
          handleMessage(message({ channelId: 20n, id: 12n }));
          yield* Deferred.await(secondInput);
          assert.deepStrictEqual(admittedChatIds, [chatId, chatId]);
          assert.strictEqual(inputLookups, 1);
          assert.strictEqual(channelReads, 1);

          handleMessage(message({ channelId: 21n }));
          yield* Deferred.await(unknownLookup);
          assert.isTrue(
            Option.isNone(
              yield* workspaces.findByBinding({
                platform: "discord",
                externalId: "1.30",
              }),
            ),
          );

          const commandWorkspaceId = Workspace.WorkspaceId.make(
            "018f47a0-0000-7000-8000-000000000004",
          );
          yield* workspaces.create({
            ...storedWorkspace,
            id: commandWorkspaceId,
            platform: "discord",
            externalId: "1.30",
          });
          yield* chats.create({
            id: failingChatId,
            workspaceId: commandWorkspaceId,
            cwd: defaultCwd,
            externalId: "21",
            createdAt: 0,
          });
          const commandEdited = Promise.withResolvers<void>();
          interactionHandlerFor(bot)(
            interaction({
              channelId: 21n,
              data: { name: "context" },
              edit: async () => commandEdited.resolve(),
            }),
          );
          yield* Effect.promise(() => commandEdited.promise);
          assert.deepStrictEqual(commandChatIds, [failingChatId]);
          assert.deepStrictEqual(
            Option.getOrThrow(yield* workspaces.findById(commandWorkspaceId)),
            {
              ...storedWorkspace,
              id: commandWorkspaceId,
              platform: "discord",
              externalId: "1.30",
            },
          );
        }),
      ).pipe(Effect.provide(Layer.merge(BunFileSystem.layer, BunPath.layer))),
  );

  it.effect("aborts an active send before its lock releases and preserves queued input", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const sendStarted = yield* Deferred.make<void>();
        const stopRequested = yield* Deferred.make<void>();
        const releaseSend = yield* Deferred.make<void>();
        const sendFinished = yield* Deferred.make<void>();
        const abortStarted = yield* Deferred.make<void>();
        const interactionEdited = yield* Deferred.make<void>();
        const queuedSent = yield* Deferred.make<void>();
        const laterSent = yield* Deferred.make<void>();
        const order: string[] = [];
        const bot = {
          id: 999n,
          events: {},
          helpers: {
            addReaction: async () => undefined,
            deleteOwnReaction: async () => undefined,
            getChannel: async () => ({
              id: 20n,
              guildId: 1n,
              type: ChannelTypes.PublicThread,
              parentId: 10n,
            }),
            sendMessage: async () => {
              throw new Error("abort must not send a public reply");
            },
            editChannel: async () => {
              throw new Error("abort must not archive the thread");
            },
            startThreadWithoutMessage: async () => {
              throw new Error("unexpected schedule");
            },
            deleteChannel: async () => {
              throw new Error("unexpected schedule cleanup");
            },
            startThreadWithMessage: async () => {
              throw new Error("abort must not create a thread");
            },
          },
        } satisfies DiscordInputBot;
        const application = Application.of({
          deleteWorkspace: () => Effect.die("unexpected workspace deletion"),
          updateWorkspace: () => Effect.die("unexpected workspace update"),
          availableWorkspaceModels: () => Effect.die("unexpected workspace model discovery"),
          setWorkspaceModel: () => Effect.die("unexpected workspace model update"),
          availableModels: () => Effect.die("unexpected model discovery"),
          switchModel: () => Effect.die("unexpected model switch"),
          askBtw: () => Effect.die("unexpected side question"),
          listWorkspaces: () => Effect.die("unexpected workspace list"),
          createWorkspace: () => Effect.die("unexpected workspace creation"),
          getOrCreateWorkspaceByBinding: () => Effect.succeed(boundWorkspace),
          bindWorkspace: () => Effect.die("unexpected workspace binding"),
          listChats: () => Effect.die("unexpected chat list"),
          createChat: () => Effect.die("unexpected chat creation"),
          findWorkspaceByPlatformId: () => Effect.die("unexpected workspace lookup"),
          findChatByPlatformId: () =>
            Effect.succeed(
              Option.some({
                id: chatId,
                workspaceId,
                cwd: defaultCwd,
                externalId: "20",
                createdAt: 0,
                archivedAt: null,
              }),
            ),
          findChatPlatformBinding: () => Effect.die("unexpected binding lookup"),
          transcript: () => Effect.die("unexpected transcript read"),
          sendMessage: (_id, prompt) =>
            Effect.gen(function* () {
              if (prompt.text === "active") {
                order.push("active-start");
                yield* Deferred.succeed(sendStarted, undefined);
                yield* Deferred.await(stopRequested);
                yield* Deferred.await(releaseSend);
                order.push("active-end");
                yield* Deferred.succeed(sendFinished, undefined);
                return;
              }
              order.push(prompt.text);
              yield* Deferred.succeed(prompt.text === "queued" ? queuedSent : laterSent, undefined);
            }).pipe(Effect.as({ kind: "started", completed: Effect.void })),
          abort: () =>
            Effect.gen(function* () {
              order.push("abort");
              yield* Deferred.succeed(abortStarted, undefined);
              yield* Deferred.succeed(stopRequested, undefined);
              yield* Deferred.await(sendFinished);
            }),
          contextUsage: () => Effect.die("unexpected context read"),
          shake: () => Effect.die("unexpected chat shake"),
          closeChat: () => Effect.die("unexpected chat close"),
          availableSkills: () => Effect.die("unexpected skill command discovery"),
        });
        const acknowledgeAbort = DiscordAcknowledgement.make(async (_id, _token, response) => {
          assert.deepStrictEqual(response, {
            type: InteractionResponseTypes.DeferredChannelMessageWithSource,
            data: { flags: MessageFlags.Ephemeral },
          });
          order.push("private-defer");
        });
        yield* install(bot, config, acknowledgeAbort).pipe(
          Effect.provideService(Application, application),
          Effect.provide(BunCrypto.layer),
        );

        const handleMessage = handlerFor(bot);
        handleMessage(message({ channelId: 20n, content: "active" }));
        yield* Deferred.await(sendStarted);
        handleMessage(message({ channelId: 20n, content: "queued" }));
        interactionHandlerFor(bot)(
          interaction({
            channelId: 20n,
            data: { name: "abort" },
            edit: async () => {
              Effect.runSync(Deferred.succeed(interactionEdited, undefined));
            },
          }),
        );
        yield* Deferred.await(abortStarted);
        assert.deepStrictEqual(order, ["active-start", "private-defer", "abort"]);

        yield* Deferred.succeed(releaseSend, undefined);
        yield* Deferred.await(interactionEdited);
        yield* Deferred.await(queuedSent);
        handleMessage(message({ channelId: 20n, content: "later" }));
        yield* Deferred.await(laterSent);
        assert.deepStrictEqual(order, [
          "active-start",
          "private-defer",
          "abort",
          "active-end",
          "queued",
          "later",
        ]);
      }),
    ),
  );

  it.effect("keeps a cold-thread message ahead of close during channel classification", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const lookupStarted = yield* Deferred.make<void>();
        const releaseLookup = Promise.withResolvers<void>();
        const closeDeferred = yield* Deferred.make<void>();
        const sendStarted = yield* Deferred.make<void>();
        const releaseSend = yield* Deferred.make<void>();
        const closeEdited = yield* Deferred.make<void>();
        const order: string[] = [];
        const replies: string[] = [];
        let firstLookup = true;
        let closed = false;
        let archived = false;
        const chat: Chat.Chat = {
          id: chatId,
          workspaceId,
          cwd: defaultCwd,
          externalId: "20",
          createdAt: 0,
          archivedAt: null,
        };
        const bot = {
          id: 999n,
          events: {},
          helpers: {
            addReaction: async () => undefined,
            deleteOwnReaction: async () => undefined,
            getChannel: async () => {
              if (firstLookup) {
                firstLookup = false;
                Effect.runSync(Deferred.succeed(lookupStarted, undefined));
                await releaseLookup.promise;
              }
              return {
                id: 20n,
                guildId: 1n,
                type: ChannelTypes.PublicThread,
                parentId: 10n,
              };
            },
            sendMessage: async (_channelId, options) => {
              replies.push(options.content);
            },
            editChannel: async () => {
              order.push("archive");
              archived = true;
            },
            startThreadWithoutMessage: async () => {
              throw new Error("unexpected schedule");
            },
            deleteChannel: async () => {
              throw new Error("unexpected schedule cleanup");
            },
            startThreadWithMessage: async () => {
              throw new Error("unexpected thread creation");
            },
          },
        } satisfies DiscordInputBot;
        const application = Application.of({
          deleteWorkspace: () => Effect.die("unexpected workspace deletion"),
          updateWorkspace: () => Effect.die("unexpected workspace update"),
          availableWorkspaceModels: () => Effect.die("unexpected workspace model discovery"),
          setWorkspaceModel: () => Effect.die("unexpected workspace model update"),
          availableModels: () => Effect.die("unexpected model discovery"),
          switchModel: () => Effect.die("unexpected model switch"),
          askBtw: () => Effect.die("unexpected side question"),
          listWorkspaces: () => Effect.die("unexpected workspace list"),
          createWorkspace: () => Effect.die("unexpected explicit workspace creation"),
          getOrCreateWorkspaceByBinding: () => Effect.succeed(boundWorkspace),
          bindWorkspace: () => Effect.die("unexpected workspace binding"),
          listChats: () => Effect.die("unexpected chat list"),
          createChat: () => Effect.die("unexpected chat creation"),
          findWorkspaceByPlatformId: () => Effect.die("unexpected workspace lookup"),
          findChatByPlatformId: () => Effect.succeed(Option.some(chat)),
          findChatPlatformBinding: () => Effect.die("unexpected chat binding lookup"),
          transcript: () => Effect.die("unexpected transcript read"),
          sendMessage: (_id, prompt) =>
            Effect.gen(function* () {
              if (closed) return yield* new ChatClosed();
              yield* Deferred.succeed(sendStarted, undefined);
              yield* Deferred.await(releaseSend);
              order.push(prompt.text);
              return startedDelivery;
            }),
          abort: () => Effect.die("unexpected chat abort"),
          contextUsage: () => Effect.die("unexpected context read"),
          shake: () => Effect.die("unexpected chat shake"),
          closeChat: () =>
            Effect.sync(() => {
              order.push("close");
              closed = true;
              return { kind: "closed" } as const;
            }),
          availableSkills: () => Effect.die("unexpected skill command discovery"),
        });
        const acknowledgeClose = DiscordAcknowledgement.make(async () => {
          Effect.runSync(Deferred.succeed(closeDeferred, undefined));
        });

        yield* install(bot, config, acknowledgeClose).pipe(
          Effect.provideService(Application, application),
          Effect.provide(BunCrypto.layer),
        );
        handlerFor(bot)(message({ channelId: 20n, content: "arrived before close" }));
        yield* Deferred.await(lookupStarted);
        interactionHandlerFor(bot)(
          interaction({
            channelId: 20n,
            data: { name: "close" },
            edit: async () => {
              Effect.runSync(Deferred.succeed(closeEdited, undefined));
            },
          }),
        );
        yield* Deferred.await(closeDeferred);
        yield* TestClock.adjust("1 millis");
        assert.isFalse(closed);
        assert.isFalse(archived);

        releaseLookup.resolve();
        yield* Deferred.await(sendStarted);
        assert.isFalse(closed);
        assert.isFalse(archived);

        yield* Deferred.succeed(releaseSend, undefined);
        yield* Deferred.await(closeEdited);
        assert.deepStrictEqual(order, ["arrived before close", "close", "archive"]);
        assert.deepStrictEqual(replies, []);
        assert.isTrue(closed);
        assert.isTrue(archived);
      }),
    ),
  );

  it.effect("holds the thread semaphore through the awaited shake", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const shakeStarted = yield* Deferred.make<void>();
        const releaseShake = yield* Deferred.make<void>();
        const messageSent = yield* Deferred.make<void>();
        const interactionEdited = yield* Deferred.make<void>();
        const order: Array<string> = [];
        const bot = {
          id: 999n,
          events: {},
          helpers: {
            addReaction: async () => undefined,
            deleteOwnReaction: async () => undefined,
            getChannel: async () => ({
              id: 20n,
              guildId: 1n,
              type: ChannelTypes.PublicThread,
              parentId: 10n,
            }),
            sendMessage: async () => undefined,
            editChannel: async () => undefined,
            startThreadWithoutMessage: async () => {
              throw new Error("unexpected schedule");
            },
            deleteChannel: async () => {
              throw new Error("unexpected schedule cleanup");
            },
            startThreadWithMessage: async () => {
              throw new Error("unexpected thread creation");
            },
          },
        } satisfies DiscordInputBot;
        const application = Application.of({
          deleteWorkspace: () => Effect.die("unexpected workspace deletion"),
          updateWorkspace: () => Effect.die("unexpected workspace update"),
          availableWorkspaceModels: () => Effect.die("unexpected workspace model discovery"),
          setWorkspaceModel: () => Effect.die("unexpected workspace model update"),
          availableModels: () => Effect.die("unexpected model discovery"),
          switchModel: () => Effect.die("unexpected model switch"),
          askBtw: () => Effect.die("unexpected side question"),
          listWorkspaces: () => Effect.die("unexpected workspace list"),
          createWorkspace: () => Effect.die("unexpected explicit workspace creation"),
          getOrCreateWorkspaceByBinding: () => Effect.succeed(boundWorkspace),
          bindWorkspace: () => Effect.die("unexpected workspace binding"),
          listChats: () => Effect.die("unexpected chat list"),
          createChat: () => Effect.die("unexpected chat creation"),
          findWorkspaceByPlatformId: () => Effect.die("unexpected workspace lookup"),
          findChatByPlatformId: () =>
            Effect.succeed(
              Option.some({
                id: chatId,
                workspaceId,
                cwd: defaultCwd,
                externalId: "20",
                createdAt: 0,
                archivedAt: null,
              }),
            ),
          findChatPlatformBinding: () => Effect.die("unexpected chat binding lookup"),
          transcript: () => Effect.die("unexpected transcript read"),
          sendMessage: () =>
            Effect.gen(function* () {
              order.push("message");
              yield* Deferred.succeed(messageSent, undefined);
              return startedDelivery;
            }),
          abort: () => Effect.die("unexpected chat abort"),
          contextUsage: () => Effect.die("unexpected context read"),
          shake: () =>
            Effect.gen(function* () {
              order.push("shake-start");
              yield* Deferred.succeed(shakeStarted, undefined);
              yield* Deferred.await(releaseShake);
              order.push("shake-end");
              return { mode: "elide", toolResultsDropped: 0, blocksDropped: 0, tokensFreed: 0 };
            }),
          closeChat: () => Effect.die("unexpected chat close"),
          availableSkills: () => Effect.die("unexpected skill command discovery"),
        });

        yield* install(bot, config, acknowledgeInteraction).pipe(
          Effect.provideService(Application, application),
          Effect.provide(BunCrypto.layer),
        );
        interactionHandlerFor(bot)(
          interaction({
            channelId: 20n,
            data: { name: "shake", options: [] },
            edit: async () => {
              order.push("edit");
              Effect.runSync(Deferred.succeed(interactionEdited, undefined));
            },
          }),
        );
        yield* Deferred.await(shakeStarted);
        handlerFor(bot)(message({ channelId: 20n }));
        yield* Effect.yieldNow;
        assert.deepStrictEqual(order, ["shake-start"]);

        yield* Deferred.succeed(releaseShake, undefined);
        yield* Deferred.await(interactionEdited);
        yield* Deferred.await(messageSent);
        assert.deepStrictEqual(order, ["shake-start", "shake-end", "edit", "message"]);
      }),
    ),
  );

  it.effect("holds the thread semaphore through context read and edit", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const contextStarted = yield* Deferred.make<void>();
        const releaseContext = yield* Deferred.make<void>();
        const editStarted = yield* Deferred.make<void>();
        const releaseEdit = yield* Deferred.make<void>();
        const messageSent = yield* Deferred.make<void>();
        const interactionEdited = yield* Deferred.make<void>();
        const order: Array<string> = [];
        const bot = {
          id: 999n,
          events: {},
          helpers: {
            addReaction: async () => undefined,
            deleteOwnReaction: async () => undefined,
            getChannel: async () => ({
              id: 20n,
              guildId: 1n,
              type: ChannelTypes.PublicThread,
              parentId: 10n,
            }),
            sendMessage: async () => undefined,
            editChannel: async () => undefined,
            startThreadWithoutMessage: async () => {
              throw new Error("unexpected schedule");
            },
            deleteChannel: async () => {
              throw new Error("unexpected schedule cleanup");
            },
            startThreadWithMessage: async () => {
              throw new Error("unexpected thread creation");
            },
          },
        } satisfies DiscordInputBot;
        const application = Application.of({
          deleteWorkspace: () => Effect.die("unexpected workspace deletion"),
          updateWorkspace: () => Effect.die("unexpected workspace update"),
          availableWorkspaceModels: () => Effect.die("unexpected workspace model discovery"),
          setWorkspaceModel: () => Effect.die("unexpected workspace model update"),
          availableModels: () => Effect.die("unexpected model discovery"),
          switchModel: () => Effect.die("unexpected model switch"),
          askBtw: () => Effect.die("unexpected side question"),
          listWorkspaces: () => Effect.die("unexpected workspace list"),
          createWorkspace: () => Effect.die("unexpected explicit workspace creation"),
          getOrCreateWorkspaceByBinding: () => Effect.succeed(boundWorkspace),
          bindWorkspace: () => Effect.die("unexpected workspace binding"),
          listChats: () => Effect.die("unexpected chat list"),
          createChat: () => Effect.die("unexpected chat creation"),
          findWorkspaceByPlatformId: () => Effect.die("unexpected workspace lookup"),
          findChatByPlatformId: () =>
            Effect.succeed(
              Option.some({
                id: chatId,
                workspaceId,
                cwd: defaultCwd,
                externalId: "20",
                createdAt: 0,
                archivedAt: null,
              }),
            ),
          findChatPlatformBinding: () => Effect.die("unexpected chat binding lookup"),
          transcript: () => Effect.die("unexpected transcript read"),
          sendMessage: () =>
            Effect.gen(function* () {
              order.push("message");
              yield* Deferred.succeed(messageSent, undefined);
              return startedDelivery;
            }),
          abort: () => Effect.die("unexpected chat abort"),
          contextUsage: () =>
            Effect.gen(function* () {
              order.push("context-start");
              yield* Deferred.succeed(contextStarted, undefined);
              yield* Deferred.await(releaseContext);
              order.push("context-end");
              return { kind: "unavailable" } satisfies ContextUsage;
            }),
          shake: () => Effect.die("unexpected chat shake"),
          closeChat: () => Effect.die("unexpected chat close"),
          availableSkills: () => Effect.die("unexpected skill command discovery"),
        });

        yield* install(bot, config, acknowledgeInteraction).pipe(
          Effect.provideService(Application, application),
          Effect.provide(BunCrypto.layer),
        );
        interactionHandlerFor(bot)(
          interaction({
            channelId: 20n,
            data: { name: "context" },
            edit: async () => {
              order.push("edit-start");
              Effect.runSync(Deferred.succeed(editStarted, undefined));
              await Effect.runPromise(Deferred.await(releaseEdit));
              order.push("edit-end");
              Effect.runSync(Deferred.succeed(interactionEdited, undefined));
            },
          }),
        );
        yield* Deferred.await(contextStarted);
        handlerFor(bot)(message({ channelId: 20n }));
        yield* Effect.yieldNow;
        assert.deepStrictEqual(order, ["context-start"]);

        yield* Deferred.succeed(releaseContext, undefined);
        yield* Deferred.await(editStarted);
        yield* Effect.yieldNow;
        assert.deepStrictEqual(order, ["context-start", "context-end", "edit-start"]);

        yield* Deferred.succeed(releaseEdit, undefined);
        yield* Deferred.await(interactionEdited);
        yield* Deferred.await(messageSent);
        assert.deepStrictEqual(order, [
          "context-start",
          "context-end",
          "edit-start",
          "edit-end",
          "message",
        ]);
      }),
    ),
  );

  it.effect("serializes same-channel binds through the awaited response", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const firstEditStarted = yield* Deferred.make<void>();
        const releaseFirstEdit = Promise.withResolvers<void>();
        const secondDeferred = yield* Deferred.make<void>();
        const secondEdited = yield* Deferred.make<void>();
        const order: string[] = [];
        let acknowledgements = 0;
        const acknowledgeBind = DiscordAcknowledgement.make(async () => {
          acknowledgements += 1;
          if (acknowledgements === 2) {
            Effect.runSync(Deferred.succeed(secondDeferred, undefined));
          }
        });
        let workspace: Workspace.Workspace = {
          id: workspaceId,
          name: "general",
          platform: "discord",
          externalId: "1.10",
          defaultCwd,
          worktree: null,
          modelOverride: null,
          createdAt: 0,
        };
        const bot = {
          id: 999n,
          events: {},
          helpers: {
            addReaction: async () => undefined,
            deleteOwnReaction: async () => undefined,
            getChannel: async () => ({
              id: 10n,
              guildId: 1n,
              type: ChannelTypes.GuildText,
              name: "general",
            }),
            sendMessage: async () => undefined,
            editChannel: async () => undefined,
            startThreadWithoutMessage: async () => {
              throw new Error("unexpected schedule");
            },
            deleteChannel: async () => {
              throw new Error("unexpected schedule cleanup");
            },
            startThreadWithMessage: async () => {
              throw new Error("unexpected thread creation");
            },
          },
        } satisfies DiscordInputBot;
        const application = Application.of({
          deleteWorkspace: () => Effect.die("unexpected workspace deletion"),
          updateWorkspace: () => Effect.die("unexpected workspace update"),
          availableWorkspaceModels: () => Effect.die("unexpected workspace model discovery"),
          setWorkspaceModel: () => Effect.die("unexpected workspace model update"),
          availableModels: () => Effect.die("unexpected model discovery"),
          switchModel: () => Effect.die("unexpected model switch"),
          askBtw: () => Effect.die("unexpected side question"),
          listWorkspaces: () => Effect.die("unexpected workspace list"),
          createWorkspace: () => Effect.die("unexpected explicit workspace creation"),
          getOrCreateWorkspaceByBinding: () => Effect.die("unexpected workspace creation"),
          bindWorkspace: ({ configuration }) =>
            Effect.sync(() => {
              if (configuration.kind !== "direct") {
                throw new Error("unexpected worktree binding");
              }
              workspace = { ...workspace, defaultCwd: AbsolutePath.make(configuration.cwd) };
              order.push(`bind:${workspace.defaultCwd}`);
              return workspace;
            }),
          listChats: () => Effect.die("unexpected chat list"),
          createChat: () => Effect.die("unexpected chat creation"),
          findWorkspaceByPlatformId: () => Effect.die("unexpected workspace lookup"),
          findChatByPlatformId: () => Effect.die("unexpected chat lookup"),
          findChatPlatformBinding: () => Effect.die("unexpected chat binding lookup"),
          transcript: () => Effect.die("unexpected transcript read"),
          sendMessage: () => Effect.die("unexpected message send"),
          abort: () => Effect.die("unexpected chat abort"),
          contextUsage: () => Effect.die("unexpected context read"),
          shake: () => Effect.die("unexpected chat shake"),
          closeChat: () => Effect.die("unexpected chat close"),
          availableSkills: () => Effect.die("unexpected skill command discovery"),
        });

        yield* install(bot, config, acknowledgeBind).pipe(
          Effect.provideService(Application, application),
          Effect.provide(BunCrypto.layer),
        );
        const handleInteraction = interactionHandlerFor(bot);
        handleInteraction(
          interaction({
            data: { name: "bind", options: bindOptions("/first") },
            edit: async (response) => {
              assert.include(response.content, "/first");
              Effect.runSync(Deferred.succeed(firstEditStarted, undefined));
              await releaseFirstEdit.promise;
              order.push("reply:/first");
            },
          }),
        );
        yield* Deferred.await(firstEditStarted);

        handleInteraction(
          interaction({
            data: { name: "bind", options: bindOptions("/second") },
            edit: async (response) => {
              assert.include(response.content, "/second");
              order.push("reply:/second");
              Effect.runSync(Deferred.succeed(secondEdited, undefined));
            },
          }),
        );
        yield* Deferred.await(secondDeferred);
        yield* TestClock.adjust("1 millis");
        assert.strictEqual(workspace.defaultCwd, "/first");
        assert.deepStrictEqual(order, ["bind:/first"]);
        assert.isFalse(yield* Deferred.isDone(secondEdited));

        releaseFirstEdit.resolve();
        yield* Deferred.await(secondEdited);
        assert.strictEqual(workspace.defaultCwd, "/second");
        assert.deepStrictEqual(order, [
          "bind:/first",
          "reply:/first",
          "bind:/second",
          "reply:/second",
        ]);
      }),
    ),
  );

  it.effect("accepts parent messages while bind is pending", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const bindStarted = yield* Deferred.make<void>();
        const releaseBind = yield* Deferred.make<void>();
        const messageSent = yield* Deferred.make<void>();
        const interactionEdited = yield* Deferred.make<void>();
        const sent: AgentMessage.AgentPrompt[] = [];
        const workspace: Workspace.Workspace = {
          id: workspaceId,
          name: "general",
          platform: "discord",
          externalId: "1.10",
          defaultCwd,
          worktree: null,
          modelOverride: null,
          createdAt: 0,
        };
        const bot = {
          id: 999n,
          events: {},
          helpers: {
            addReaction: async () => undefined,
            deleteOwnReaction: async () => undefined,
            getChannel: async () => ({
              id: 10n,
              guildId: 1n,
              type: ChannelTypes.GuildText,
              name: "general",
            }),
            sendMessage: async () => undefined,
            editChannel: async () => undefined,
            startThreadWithoutMessage: async () => {
              throw new Error("unexpected schedule");
            },
            deleteChannel: async () => {
              throw new Error("unexpected schedule cleanup");
            },
            startThreadWithMessage: async () => ({ id: 20n }),
          },
        } satisfies DiscordInputBot;
        const application = Application.of({
          deleteWorkspace: () => Effect.die("unexpected workspace deletion"),
          updateWorkspace: () => Effect.die("unexpected workspace update"),
          availableWorkspaceModels: () => Effect.die("unexpected workspace model discovery"),
          setWorkspaceModel: () => Effect.die("unexpected workspace model update"),
          availableModels: () => Effect.die("unexpected model discovery"),
          switchModel: () => Effect.die("unexpected model switch"),
          askBtw: () => Effect.die("unexpected side question"),
          listWorkspaces: () => Effect.die("unexpected workspace list"),
          createWorkspace: () => Effect.die("unexpected explicit workspace creation"),
          getOrCreateWorkspaceByBinding: () => Effect.succeed(workspace),
          bindWorkspace: () =>
            Effect.gen(function* () {
              yield* Deferred.succeed(bindStarted, undefined);
              yield* Deferred.await(releaseBind);
              return workspace;
            }),
          listChats: () => Effect.die("unexpected chat list"),
          createChat: () =>
            Effect.succeed({
              id: chatId,
              workspaceId,
              cwd: defaultCwd,
              externalId: "20",
              createdAt: 0,
              archivedAt: null,
            }),
          findWorkspaceByPlatformId: () => Effect.succeed(Option.some(workspace)),
          findChatByPlatformId: () => Effect.die("unexpected chat lookup"),
          findChatPlatformBinding: () => Effect.die("unexpected chat binding lookup"),
          transcript: () => Effect.die("unexpected transcript read"),
          sendMessage: (_id, prompt) =>
            Effect.gen(function* () {
              sent.push(prompt);
              yield* Deferred.succeed(messageSent, undefined);
              return startedDelivery;
            }),
          abort: () => Effect.die("unexpected chat abort"),
          contextUsage: () => Effect.die("unexpected context read"),
          shake: () => Effect.die("unexpected chat shake"),
          closeChat: () => Effect.die("unexpected chat close"),
          availableSkills: () => Effect.die("unexpected skill command discovery"),
        });

        yield* install(bot, config, acknowledgeInteraction).pipe(
          Effect.provideService(Application, application),
          Effect.provide(BunCrypto.layer),
        );
        interactionHandlerFor(bot)(
          interaction({
            edit: async () => {
              Effect.runSync(Deferred.succeed(interactionEdited, undefined));
            },
          }),
        );
        yield* Deferred.await(bindStarted);

        handlerFor(bot)(message());
        yield* Deferred.await(messageSent);
        assert.deepStrictEqual(sent, [
          AgentMessage.AgentPrompt.make({ text: "hello", attachments: [] }),
        ]);
        assert.isFalse(yield* Deferred.isDone(interactionEdited));

        yield* Deferred.succeed(releaseBind, undefined);
        yield* Deferred.await(interactionEdited);
      }),
    ),
  );

  it.effect("starts another thread in the same parent while the first send is blocked", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const firstStarted = yield* Deferred.make<void>();
        const releaseFirst = yield* Deferred.make<void>();
        const firstSent = yield* Deferred.make<void>();
        const secondSent = yield* Deferred.make<void>();
        const unsupportedEdited = yield* Deferred.make<void>();
        const secondChatId = Chat.ChatId.make("018f47a0-0000-7000-8000-000000000004");
        const completed: Array<{ readonly id: Chat.ChatId; readonly text: string }> = [];
        const bot = {
          id: 999n,
          events: {},
          helpers: {
            addReaction: async () => undefined,
            deleteOwnReaction: async () => undefined,
            getChannel: async () => ({
              id: 10n,
              guildId: 1n,
              type: ChannelTypes.GuildText,
              name: "general",
            }),
            sendMessage: async () => undefined,
            editChannel: async () => undefined,
            startThreadWithoutMessage: async () => {
              throw new Error("unexpected schedule");
            },
            deleteChannel: async () => {
              throw new Error("unexpected schedule cleanup");
            },
            startThreadWithMessage: async (_parentId, messageId) => ({
              id: messageId === 11n ? 20n : 21n,
            }),
          },
        } satisfies DiscordInputBot;
        const application = Application.of({
          deleteWorkspace: () => Effect.die("unexpected workspace deletion"),
          updateWorkspace: () => Effect.die("unexpected workspace update"),
          availableWorkspaceModels: () => Effect.die("unexpected workspace model discovery"),
          setWorkspaceModel: () => Effect.die("unexpected workspace model update"),
          availableModels: () => Effect.die("unexpected model discovery"),
          switchModel: () => Effect.die("unexpected model switch"),
          askBtw: () => Effect.die("unexpected side question"),
          listWorkspaces: () => Effect.die("unexpected workspace list"),
          createWorkspace: () => Effect.die("unexpected explicit workspace creation"),
          getOrCreateWorkspaceByBinding: () =>
            Effect.succeed({
              id: workspaceId,
              name: "general",
              platform: "discord",
              externalId: "1.10",
              defaultCwd,
              worktree: null,
              modelOverride: null,
              createdAt: 0,
            }),
          bindWorkspace: () => Effect.die("unexpected workspace binding"),
          listChats: () => Effect.die("unexpected chat list"),
          createChat: (input) =>
            Effect.succeed({
              id: input.externalId === "20" ? chatId : secondChatId,
              workspaceId: input.workspaceId,
              cwd: defaultCwd,
              externalId: input.externalId,
              createdAt: 0,
              archivedAt: null,
            }),
          findWorkspaceByPlatformId: () => Effect.succeed(Option.none()),
          findChatByPlatformId: () => Effect.die("unexpected chat lookup"),
          findChatPlatformBinding: () => Effect.die("unexpected chat binding lookup"),
          transcript: () => Effect.die("unexpected transcript read"),
          sendMessage: (id, prompt) =>
            Effect.gen(function* () {
              if (id === chatId) {
                yield* Deferred.succeed(firstStarted, undefined);
                yield* Deferred.await(releaseFirst);
              }
              completed.push({ id, text: prompt.text });
              yield* Deferred.succeed(id === chatId ? firstSent : secondSent, undefined);
              return startedDelivery;
            }),
          abort: () => Effect.die("unexpected chat abort"),
          contextUsage: () => Effect.die("unexpected context read"),
          shake: () => Effect.die("unexpected chat shake"),
          closeChat: () => Effect.die("unexpected chat close"),
          availableSkills: () => Effect.die("unexpected skill command discovery"),
        });

        yield* install(bot, config, acknowledgeInteraction).pipe(
          Effect.provideService(Application, application),
          Effect.provide(BunCrypto.layer),
        );
        interactionHandlerFor(bot)(
          interaction({
            data: { name: "context" },
            edit: async () => {
              Effect.runSync(Deferred.succeed(unsupportedEdited, undefined));
            },
          }),
        );
        yield* Deferred.await(unsupportedEdited);
        const handleMessage = handlerFor(bot);
        handleMessage(message({ content: "first" }));
        yield* Deferred.await(firstStarted);
        handleMessage(message({ id: 12n, content: "second" }));
        yield* Deferred.await(secondSent);
        assert.deepStrictEqual(completed, [{ id: secondChatId, text: "second" }]);

        yield* Deferred.succeed(releaseFirst, undefined);
        yield* Deferred.await(firstSent);
        assert.deepStrictEqual(completed, [
          { id: secondChatId, text: "second" },
          { id: chatId, text: "first" },
        ]);
      }),
    ),
  );

  it.effect(
    "keeps the opening prompt first after publication and releases its lock on failure",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const published = yield* Deferred.make<void>();
          const releaseCreation = yield* Deferred.make<void>();
          const firstStarted = yield* Deferred.make<void>();
          const releaseFirst = yield* Deferred.make<void>();
          const followupSent = yield* Deferred.make<void>();
          const interactionEdited = yield* Deferred.make<void>();
          const failureReplyStarted = Promise.withResolvers<void>();
          const releaseFailureReply = Promise.withResolvers<void>();
          const replies: Array<{ readonly channelId: bigint; readonly content: string }> = [];
          const received: string[] = [];
          const contextPrompts: string[][] = [];
          let attachmentRequested = false;
          let persisted: Option.Option<Chat.Chat> = Option.none();
          const chat: Chat.Chat = {
            id: chatId,
            workspaceId,
            cwd: defaultCwd,
            externalId: "20",
            createdAt: 0,
            archivedAt: null,
          };
          const httpClient = HttpClient.make((request) => {
            attachmentRequested = true;
            return Effect.succeed(
              HttpClientResponse.fromWeb(request, new Response(Buffer.from(pngBytes))),
            );
          });
          const bot = {
            id: 999n,
            events: {},
            helpers: {
              addReaction: async () => undefined,
              deleteOwnReaction: async () => undefined,
              getChannel: async (channelId) =>
                channelId === 10n
                  ? { id: 10n, guildId: 1n, type: ChannelTypes.GuildText, name: "general" }
                  : { id: 20n, guildId: 1n, type: ChannelTypes.PublicThread, parentId: 10n },
              sendMessage: async (channelId, options) => {
                replies.push({ channelId, content: options.content });
                failureReplyStarted.resolve();
                await releaseFailureReply.promise;
              },
              editChannel: async () => undefined,
              startThreadWithoutMessage: async () => {
                throw new Error("unexpected schedule");
              },
              deleteChannel: async () => {
                throw new Error("unexpected schedule cleanup");
              },
              startThreadWithMessage: async () => ({ id: 20n }),
            },
          } satisfies DiscordInputBot;
          const application = Application.of({
            deleteWorkspace: () => Effect.die("unexpected workspace deletion"),
            updateWorkspace: () => Effect.die("unexpected workspace update"),
            availableWorkspaceModels: () => Effect.die("unexpected workspace model discovery"),
            setWorkspaceModel: () => Effect.die("unexpected workspace model update"),
            availableModels: () => Effect.die("unexpected model discovery"),
            switchModel: () => Effect.die("unexpected model switch"),
            askBtw: () => Effect.die("unexpected side question"),
            listWorkspaces: () => Effect.die("unexpected workspace list"),
            createWorkspace: () => Effect.die("unexpected explicit workspace creation"),
            getOrCreateWorkspaceByBinding: () =>
              Effect.succeed({
                id: workspaceId,
                name: "general",
                platform: "discord",
                externalId: "1.10",
                defaultCwd,
                worktree: null,
                modelOverride: null,
                createdAt: 0,
              }),
            bindWorkspace: () => Effect.die("unexpected workspace binding"),
            listChats: () => Effect.die("unexpected chat list"),
            createChat: () =>
              Effect.gen(function* () {
                persisted = Option.some(chat);
                yield* Deferred.succeed(published, undefined);
                yield* Deferred.await(releaseCreation);
                return chat;
              }),
            findWorkspaceByPlatformId: () => Effect.succeed(Option.none()),
            findChatByPlatformId: () => Effect.sync(() => persisted),
            findChatPlatformBinding: () => Effect.die("unexpected chat binding lookup"),
            transcript: () => Effect.die("unexpected transcript read"),
            sendMessage: (_id, prompt) =>
              Effect.gen(function* () {
                received.push(prompt.text);
                if (prompt.text === "opening") {
                  yield* Deferred.succeed(firstStarted, undefined);
                  yield* Deferred.await(releaseFirst);
                  return yield* new ApplicationError({
                    reason: "operation",
                    message: "private-opening-send-failure",
                  });
                }
                yield* Deferred.succeed(followupSent, undefined);
                return startedDelivery;
              }),
            abort: () => Effect.die("unexpected chat abort"),
            contextUsage: () =>
              Effect.sync(() => {
                contextPrompts.push([...received]);
                return { kind: "unavailable" } satisfies ContextUsage;
              }),
            shake: () => Effect.die("unexpected chat shake"),
            closeChat: () => Effect.die("unexpected chat close"),
            availableSkills: () => Effect.die("unexpected skill command discovery"),
          });

          yield* install(bot, config, acknowledgeInteraction, () => Effect.void, httpClient).pipe(
            Effect.provideService(Application, application),
            Effect.provide(BunCrypto.layer),
          );
          const handleMessage = handlerFor(bot);
          handleMessage(message({ content: "opening" }));
          yield* Deferred.await(published);
          handleMessage(
            message({
              channelId: 20n,
              id: 12n,
              content: "follow-up",
              attachments: [
                {
                  filename: "image.png",
                  size: pngBytes.byteLength,
                  url: "https://cdn.discordapp.com/attachments/1/2/image.png",
                },
              ],
            }),
          );
          interactionHandlerFor(bot)(
            interaction({
              channelId: 20n,
              data: { name: "context" },
              edit: async () => {
                Effect.runSync(Deferred.succeed(interactionEdited, undefined));
              },
            }),
          );
          yield* TestClock.adjust("1 millis");
          assert.deepStrictEqual(received, []);
          assert.deepStrictEqual(contextPrompts, []);
          assert.isFalse(attachmentRequested);

          yield* Deferred.succeed(releaseCreation, undefined);
          yield* Deferred.await(firstStarted);
          assert.deepStrictEqual(received, ["opening"]);
          assert.deepStrictEqual(contextPrompts, []);
          assert.isFalse(attachmentRequested);

          yield* Deferred.succeed(releaseFirst, undefined);
          yield* Deferred.await(followupSent);
          yield* Deferred.await(interactionEdited);
          yield* Effect.promise(() => failureReplyStarted.promise);
          assert.deepStrictEqual(
            replies.map(({ channelId }) => channelId),
            [20n],
          );
          assert.notInclude(replies[0]?.content ?? "", "private-opening-send-failure");
          releaseFailureReply.resolve();
          assert.deepStrictEqual(received, ["opening", "follow-up"]);
          assert.deepStrictEqual(contextPrompts, [["opening", "follow-up"]]);
          assert.isTrue(attachmentRequested);
        }),
      ),
  );

  it.effect("supervises immediate deferral, continuation defects, and canceled requests", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const logs: Array<ReturnType<typeof Logger.formatStructured.log>> = [];
        let expectedLogCount = 1;
        let logged = Promise.withResolvers<void>();
        const logger = Logger.make((options) => {
          logs.push(Logger.formatStructured.log(options));
          if (logs.length === expectedLogCount) logged.resolve();
        });
        const pending = Promise.withResolvers<void>();
        let edited = 0;
        const bot: DiscordInputBot = {
          id: 999n,
          events: {},
          helpers: {
            addReaction: async () => undefined,
            deleteOwnReaction: async () => undefined,
            getChannel: async () => {
              throw new Error("unexpected channel lookup");
            },
            sendMessage: async () => undefined,
            editChannel: async () => undefined,
            startThreadWithoutMessage: async () => {
              throw new Error("unexpected schedule");
            },
            deleteChannel: async () => {
              throw new Error("unexpected schedule cleanup");
            },
            startThreadWithMessage: async () => {
              throw new Error("unexpected thread creation");
            },
          },
        };
        const application = Application.of({
          deleteWorkspace: () => Effect.die("unexpected workspace deletion"),
          updateWorkspace: () => Effect.die("unexpected workspace update"),
          availableWorkspaceModels: () => Effect.die("unexpected workspace model discovery"),
          setWorkspaceModel: () => Effect.die("unexpected workspace model update"),
          availableModels: () => Effect.die("unexpected model discovery"),
          switchModel: () => Effect.die("unexpected model switch"),
          askBtw: () => Effect.die("unexpected side question"),
          listWorkspaces: () => Effect.die("unexpected workspace list"),
          createWorkspace: () => Effect.die("unexpected workspace creation"),
          getOrCreateWorkspaceByBinding: () => Effect.die("unexpected workspace creation"),
          bindWorkspace: () => Effect.die("unexpected workspace binding"),
          listChats: () => Effect.die("unexpected chat list"),
          createChat: () => Effect.die("unexpected chat creation"),
          findWorkspaceByPlatformId: () => Effect.die("unexpected workspace lookup"),
          findChatByPlatformId: () => Effect.die("unexpected chat lookup"),
          findChatPlatformBinding: () => Effect.die("unexpected binding lookup"),
          transcript: () => Effect.die("unexpected transcript read"),
          sendMessage: () => Effect.die("unexpected message send"),
          abort: () => Effect.die("unexpected abort"),
          contextUsage: () => Effect.die("unexpected context read"),
          shake: () => Effect.die("unexpected shake"),
          closeChat: () => Effect.die("unexpected close"),
          availableSkills: () => Effect.die("unexpected skill command discovery"),
        });
        const testAcknowledgement = DiscordAcknowledgement.make((_id, token) => {
          if (token === "sync-failure") {
            throw { status: 403, body: '{"code":50013,"message":"private-defer"}' };
          }
          if (token === "async-failure") {
            return Promise.reject(new Error("private-defer-rejection"));
          }
          if (token === "pending") return pending.promise;
          return Promise.resolve(undefined);
        });
        const installed = install(bot, config, testAcknowledgement).pipe(
          Effect.provideService(Application, application),
          Effect.provide(BunCrypto.layer),
          Effect.provide(Logger.layer([logger])),
        );
        yield* installed;
        const invoke = interactionHandlerFor(bot);
        const rejected = interaction({
          id: 51n,
          token: "sync-failure",
          edit: async () => {
            edited++;
          },
        });
        invoke(rejected);
        assert.isTrue(rejected.acknowledged);
        yield* Effect.promise(() => logged.promise);
        assert.strictEqual(logs.length, 1);
        assert.strictEqual(logs[0]?.level, "ERROR");
        assert.strictEqual(logs[0]?.annotations.phase, "defer");
        assert.strictEqual(logs[0]?.annotations.interactionId, "51");
        assert.strictEqual(logs[0]?.annotations.status, 403);
        assert.strictEqual(logs[0]?.annotations.discordCode, 50_013);
        assert.strictEqual(logs[0]?.annotations.acknowledgementDecision, "rejected");
        expectedLogCount = 2;
        logged = Promise.withResolvers<void>();
        invoke(
          interaction({
            token: "async-failure",
            edit: async () => {
              edited++;
            },
          }),
        );
        yield* Effect.promise(() => logged.promise);
        assert.strictEqual(logs.length, 2);
        expectedLogCount = 3;
        logged = Promise.withResolvers<void>();
        invoke(
          interaction({
            data: {
              name: "bind",
              get options(): never {
                throw new Error("private-continuation");
              },
            },
            edit: async () => {
              edited++;
            },
          }),
        );
        yield* Effect.promise(() => logged.promise);
        assert.strictEqual(logs.length, 3);
        assert.strictEqual(logs[2]?.annotations.phase, "request");
        assert.strictEqual(edited, 0);
        assert.notInclude(JSON.stringify(logs), "private-");

        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* installed;
            interactionHandlerFor(bot)(
              interaction({
                token: "pending",
                edit: async () => {
                  edited++;
                },
              }),
            );
          }),
        );
        pending.resolve(undefined);
        yield* Effect.yieldNow;
        assert.strictEqual(logs.length, 3);
        assert.strictEqual(edited, 0);
      }),
    ),
  );

  it.effect("retains message context across failed sends and independent attachment replies", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const logs: Array<ReturnType<typeof Logger.formatStructured.log>> = [];
        const sendStarted = yield* Deferred.make<void>();
        const releaseSend = yield* Deferred.make<void>();
        const sendReported = Promise.withResolvers<void>();
        const replyReported = Promise.withResolvers<void>();
        const logger = Logger.make((options) => {
          const entry = Logger.formatStructured.log(options);
          logs.push(entry);
          if (entry.annotations.operation !== "message-request") return;
          if (entry.annotations.messageId === "101") sendReported.resolve();
          if (entry.annotations.messageId === "102") replyReported.resolve();
        });
        const bot: DiscordInputBot = {
          id: 999n,
          events: {},
          helpers: {
            addReaction: async () => undefined,
            deleteOwnReaction: async () => undefined,
            getChannel: async () => ({
              id: 20n,
              guildId: 1n,
              parentId: 10n,
              type: ChannelTypes.PublicThread,
            }),
            sendMessage: () => Promise.reject({ status: 403, body: "private-reply" }),
            editChannel: async () => undefined,
            startThreadWithoutMessage: async () => {
              throw new Error("unexpected schedule");
            },
            deleteChannel: async () => {
              throw new Error("unexpected schedule cleanup");
            },
            startThreadWithMessage: async () => {
              throw new Error("unexpected thread creation");
            },
          },
        };
        const application = Application.of({
          deleteWorkspace: () => Effect.die("unexpected workspace deletion"),
          updateWorkspace: () => Effect.die("unexpected workspace update"),
          availableWorkspaceModels: () => Effect.die("unexpected workspace model discovery"),
          setWorkspaceModel: () => Effect.die("unexpected workspace model update"),
          availableModels: () => Effect.die("unexpected model discovery"),
          switchModel: () => Effect.die("unexpected model switch"),
          askBtw: () => Effect.die("unexpected side question"),
          listWorkspaces: () => Effect.die("unexpected workspace list"),
          createWorkspace: () => Effect.die("unexpected workspace creation"),
          getOrCreateWorkspaceByBinding: () => Effect.succeed(boundWorkspace),
          bindWorkspace: () => Effect.die("unexpected workspace binding"),
          listChats: () => Effect.die("unexpected chat list"),
          createChat: () => Effect.die("unexpected chat creation"),
          findWorkspaceByPlatformId: () => Effect.die("unexpected workspace lookup"),
          findChatByPlatformId: () =>
            Effect.succeed(
              Option.some({
                id: chatId,
                workspaceId,
                cwd: defaultCwd,
                externalId: "20",
                createdAt: 0,
                archivedAt: null,
              }),
            ),
          findChatPlatformBinding: () => Effect.die("unexpected binding lookup"),
          transcript: () => Effect.die("unexpected transcript read"),
          sendMessage: () =>
            Effect.gen(function* () {
              yield* Deferred.succeed(sendStarted, undefined);
              yield* Deferred.await(releaseSend);
              return yield* Effect.fail(
                new ApplicationError({ reason: "operation", message: "Message send failed" }),
              );
            }),
          abort: () => Effect.die("unexpected abort"),
          contextUsage: () => Effect.die("unexpected context read"),
          shake: () => Effect.die("unexpected shake"),
          closeChat: () => Effect.die("unexpected close"),
          availableSkills: () => Effect.die("unexpected skill command discovery"),
        });
        const httpClient = HttpClient.make((request) =>
          Effect.succeed(HttpClientResponse.fromWeb(request, new Response(null, { status: 500 }))),
        );
        yield* install(bot, config, acknowledgeInteraction, () => Effect.void, httpClient).pipe(
          Effect.provideService(Application, application),
          Effect.provide(BunCrypto.layer),
          Effect.provide(Logger.layer([logger])),
        );
        const invoke = handlerFor(bot);
        invoke(message({ id: 101n, channelId: 20n, content: "private-prompt" }));
        yield* Deferred.await(sendStarted);
        invoke(
          message({
            id: 102n,
            channelId: 30n,
            content: "private-attachment-prompt",
            attachments: [
              {
                filename: "private-image.png",
                size: 1,
                url: "https://cdn.discordapp.com/private-image",
              },
            ],
          }),
        );
        yield* Effect.promise(() => replyReported.promise);
        yield* Deferred.succeed(releaseSend, undefined);
        yield* Effect.promise(() => sendReported.promise);
        assert.deepStrictEqual(
          logs.map((entry) => entry.annotations.operation),
          ["download-attachment", "message-request", "message-request"],
        );
        assert.deepStrictEqual(
          logs.slice(1).map(({ annotations }) => ({
            phase: annotations.phase,
            chatId: annotations.chatId,
            workspaceId: annotations.workspaceId,
            threadId: annotations.threadId,
            guildId: annotations.guildId,
            channelId: annotations.channelId,
            messageId: annotations.messageId,
          })),
          [
            {
              phase: "reject-attachments",
              chatId: undefined,
              workspaceId: undefined,
              threadId: undefined,
              guildId: "1",
              channelId: "30",
              messageId: "102",
            },
            {
              phase: "send-prompt",
              chatId,
              workspaceId,
              threadId: "20",
              guildId: "1",
              channelId: "20",
              messageId: "101",
            },
          ],
        );
        assert.isTrue(logs.every((entry) => entry.level === "ERROR"));
        assert.notInclude(JSON.stringify(logs), "private-");
      }),
    ),
  );

  it.effect("reports request failure separately from failed interaction reply delivery", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const logs: Array<ReturnType<typeof Logger.formatStructured.log>> = [];
        const delivered = Promise.withResolvers<void>();
        const logger = Logger.make((options) => {
          logs.push(Logger.formatStructured.log(options));
          if (logs.length === 2) delivered.resolve();
        });
        const bot: DiscordInputBot = {
          id: 999n,
          events: {},
          helpers: {
            addReaction: async () => undefined,
            deleteOwnReaction: async () => undefined,
            getChannel: async () => ({
              id: 20n,
              guildId: 1n,
              parentId: 10n,
              type: ChannelTypes.PublicThread,
            }),
            sendMessage: async () => undefined,
            editChannel: async () => undefined,
            startThreadWithoutMessage: async () => {
              throw new Error("unexpected schedule");
            },
            deleteChannel: async () => {
              throw new Error("unexpected schedule cleanup");
            },
            startThreadWithMessage: async () => {
              throw new Error("unexpected thread creation");
            },
          },
        };
        const application = Application.of({
          deleteWorkspace: () => Effect.die("unexpected workspace deletion"),
          updateWorkspace: () => Effect.die("unexpected workspace update"),
          availableWorkspaceModels: () => Effect.die("unexpected workspace model discovery"),
          setWorkspaceModel: () => Effect.die("unexpected workspace model update"),
          availableModels: () => Effect.die("unexpected model discovery"),
          switchModel: () => Effect.die("unexpected model switch"),
          askBtw: () => Effect.die("unexpected side question"),
          listWorkspaces: () => Effect.die("unexpected workspace list"),
          createWorkspace: () => Effect.die("unexpected workspace creation"),
          getOrCreateWorkspaceByBinding: () => Effect.succeed(boundWorkspace),
          bindWorkspace: () => Effect.die("unexpected workspace binding"),
          listChats: () => Effect.die("unexpected chat list"),
          createChat: () => Effect.die("unexpected chat creation"),
          findWorkspaceByPlatformId: () => Effect.die("unexpected workspace lookup"),
          findChatByPlatformId: () =>
            Effect.succeed(
              Option.some({
                id: chatId,
                workspaceId,
                cwd: defaultCwd,
                externalId: "20",
                createdAt: 0,
                archivedAt: null,
              }),
            ),
          findChatPlatformBinding: () => Effect.die("unexpected binding lookup"),
          transcript: () => Effect.die("unexpected transcript read"),
          sendMessage: () => Effect.die("unexpected message send"),
          abort: () => Effect.die("unexpected abort"),
          contextUsage: () => Effect.die("unexpected context read"),
          shake: () =>
            Effect.fail(new ApplicationError({ reason: "operation", message: "Shake failed" })),
          closeChat: () => Effect.die("unexpected close"),
          availableSkills: () => Effect.die("unexpected skill command discovery"),
        });
        yield* install(bot, config, acknowledgeInteraction).pipe(
          Effect.provideService(Application, application),
          Effect.provide(BunCrypto.layer),
          Effect.provide(Logger.layer([logger])),
        );
        interactionHandlerFor(bot)(
          interaction({
            channelId: 20n,
            data: { name: "shake", options: [] },
            edit: () => Promise.reject({ status: 500, body: "private-response" }),
          }),
        );
        yield* Effect.promise(() => delivered.promise);
        assert.deepStrictEqual(
          logs.map((entry) => entry.annotations.operation),
          ["shake-chat", "edit-interaction"],
        );
        assert.isTrue(logs.every((entry) => entry.annotations.chatId === chatId));
        assert.isTrue(logs.every((entry) => entry.annotations.workspaceId === workspaceId));
        assert.deepStrictEqual(
          logs.map((entry) => entry.annotations.phase),
          ["shake-chat", "edit-interaction"],
        );
        assert.notInclude(JSON.stringify(logs), "private-response");
      }),
    ),
  );
});
