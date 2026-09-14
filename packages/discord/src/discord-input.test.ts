import * as BunCrypto from "@effect/platform-bun/BunCrypto";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import * as BunPath from "@effect/platform-bun/BunPath";
import { assert, describe, it } from "@effect/vitest";
import type { AgentEventEnvelope } from "@pico/contract/agent-event";
import * as AgentMessage from "@pico/contract/agent-message";
import type { ContextUsage } from "@pico/contract/agent-runtime";
import { Application } from "@pico/contract/application";
import * as Chat from "@pico/contract/chat-model";
import { ChatRepository } from "@pico/contract/chat-repository";
import { ApplicationError, ChatClosed } from "@pico/contract/errors";
import { EventRouter } from "@pico/contract/event-router";
import { AbsolutePath } from "@pico/contract/path";
import * as Workspace from "@pico/contract/workspace-model";
import { WorkspaceRepository } from "@pico/contract/workspace-repository";
import * as Persistence from "@pico/persistence/layer";
import { ChannelTypes } from "discordeno";
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
import {
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
import { type DiscordInputBot, install } from "./discord-input.ts";
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
            startThreadWithMessage: async (_channelId, _messageId, options) => {
              order.push("create-thread");
              assert.strictEqual(options.name, "hello from pico");
              return { id: 20n };
            },
          },
        } satisfies DiscordInputBot;

        const application = Application.of({
          getOrCreateBotChat: () => Effect.die("unexpected bot chat creation"),
          sendBotMessage: () => Effect.die("unexpected bot message"),
          askBtw: () => Effect.die("unexpected side question"),
          listWorkspaces: () => Effect.die("unexpected workspace list"),
          createWorkspace: () => Effect.die("unexpected explicit workspace creation"),
          getOrCreateWorkspaceByBinding: () =>
            Effect.sync(() => {
              order.push("create-workspace");
              return {
                id: workspaceId,
                name: "general",
                binding: { platform: "discord", externalId: "10" },
                defaultCwd,
                worktree: null,
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
        });
        resolveThreadId = yield* install(bot, config).pipe(
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
    "observes guild input after cold output lookup and caches only successful observation",
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
          const legacyWorkspace = {
            ...boundWorkspace,
            binding: { platform: "discord", externalId: "10" },
            worktree: { branch: "main", prefix: "retained/" },
          } satisfies Workspace.Workspace;
          yield* workspaces.create(legacyWorkspace);
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
          let observations = 0;
          let inputLookups = 0;
          let failObservation = true;
          const observationFailure = Promise.withResolvers<void>();
          const logger = Logger.make((options) => {
            if (Logger.formatStructured.log(options).annotations.operation === "message-request") {
              observationFailure.resolve();
            }
          });
          const firstInput = yield* Deferred.make<void>();
          const secondInput = yield* Deferred.make<void>();
          const unknownLookup = yield* Deferred.make<void>();
          const admittedGuildIds: Array<string | undefined> = [];
          const commandGuildIds: Array<string | undefined> = [];
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
              startThreadWithMessage: async () => {
                throw new Error("cold output must not create Discord threads");
              },
            },
          } satisfies DiscordInputBot;
          const application = Application.of({
            getOrCreateBotChat: () => Effect.die("unexpected bot chat creation"),
            sendBotMessage: () => Effect.die("unexpected bot message"),
            askBtw: () => Effect.die("unexpected side question"),
            listWorkspaces: () => Effect.die("unexpected workspace list"),
            createWorkspace: () => Effect.die("unexpected explicit workspace creation"),
            getOrCreateWorkspaceByBinding: (input) =>
              Effect.gen(function* () {
                observations += 1;
                if (failObservation) {
                  return yield* new ApplicationError({
                    reason: "operation",
                    message: "Observation unavailable",
                  });
                }
                return yield* workspaces.getOrCreateByBinding({
                  ...input,
                  id: Workspace.WorkspaceId.make("018f47a0-0000-7000-8000-000000000099"),
                  createdAt: 1,
                });
              }).pipe(Effect.mapError(persistenceFailure)),
            bindWorkspace: () => Effect.die("unexpected workspace binding"),
            listChats: () => Effect.die("unexpected chat list"),
            createChat: () => Effect.die("unexpected chat creation"),
            findWorkspaceByPlatformId: () => Effect.die("unexpected workspace lookup"),
            findChatByPlatformId: (platform, parentId, externalId) =>
              Effect.gen(function* () {
                inputLookups += 1;
                const workspace = yield* workspaces.findByBinding({
                  platform,
                  externalId: parentId,
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
            sendMessage: () =>
              Effect.gen(function* () {
                const workspace = Option.getOrThrow(yield* workspaces.findById(workspaceId));
                admittedGuildIds.push(workspace.binding?.guildId);
                yield* Deferred.succeed(
                  admittedGuildIds.length === 1 ? firstInput : secondInput,
                  undefined,
                );
                return startedDelivery;
              }).pipe(Effect.mapError(persistenceFailure)),
            abort: () => Effect.die("unexpected chat abort"),
            contextUsage: (id) =>
              Effect.gen(function* () {
                const chat = Option.getOrThrow(yield* chats.findById(id));
                const workspace = Option.getOrThrow(yield* workspaces.findById(chat.workspaceId));
                commandGuildIds.push(workspace.binding?.guildId);
                return { kind: "unavailable" } satisfies ContextUsage;
              }).pipe(Effect.mapError(persistenceFailure)),
            shake: () => Effect.die("unexpected chat shake"),
            closeChat: () => Effect.die("unexpected chat close"),
          });
          const resolveThreadId = yield* install(bot, config).pipe(
            Effect.provideService(Application, application),
            Effect.provide(BunCrypto.layer),
            Effect.provide(Logger.layer([logger])),
          );
          const envelopes: ReadonlyArray<AgentEventEnvelope> = [
            {
              chatId: failingChatId,
              event: { type: "notice", level: "error", message: "invalid persisted binding" },
            },
            { chatId, event: { type: "run-started" } },
            {
              chatId,
              event: {
                type: "message-settled",
                message: {
                  role: "assistant",
                  status: "completed",
                  stopReason: "stop",
                  content: [{ type: "text", text: "scheduled after restart" }],
                  model: "pico/schedule",
                  timestamp: 0,
                },
              },
            },
            { chatId, event: { type: "run-finished", outcome: "completed" } },
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
          assert.strictEqual(observations, 0);
          const handleMessage = handlerFor(bot);
          handleMessage(message({ channelId: 20n }));
          yield* Effect.promise(() => observationFailure.promise);
          assert.deepStrictEqual(admittedGuildIds, []);
          assert.deepStrictEqual(
            Option.getOrThrow(yield* workspaces.findById(workspaceId)),
            legacyWorkspace,
          );

          failObservation = false;
          handleMessage(message({ channelId: 20n, id: 12n }));
          yield* Deferred.await(firstInput);
          assert.deepStrictEqual(admittedGuildIds, ["1"]);
          assert.deepStrictEqual(Option.getOrThrow(yield* workspaces.findById(workspaceId)), {
            ...legacyWorkspace,
            binding: { ...legacyWorkspace.binding, guildId: "1" },
          });
          handleMessage(message({ channelId: 20n, id: 13n }));
          yield* Deferred.await(secondInput);
          assert.deepStrictEqual(admittedGuildIds, ["1", "1"]);
          assert.strictEqual(observations, 2);
          assert.strictEqual(inputLookups, 2);
          assert.strictEqual(channelReads, 2);

          handleMessage(message({ channelId: 21n }));
          yield* Deferred.await(unknownLookup);
          assert.strictEqual(observations, 2);
          assert.isTrue(
            Option.isNone(
              yield* workspaces.findByBinding({
                platform: "discord",
                externalId: "30",
              }),
            ),
          );

          const commandWorkspaceId = Workspace.WorkspaceId.make(
            "018f47a0-0000-7000-8000-000000000004",
          );
          yield* workspaces.create({
            ...legacyWorkspace,
            id: commandWorkspaceId,
            binding: { platform: "discord", externalId: "30" },
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
          assert.deepStrictEqual(commandGuildIds, ["1"]);
          assert.strictEqual(observations, 3);
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
            startThreadWithMessage: async () => {
              throw new Error("abort must not create a thread");
            },
          },
        } satisfies DiscordInputBot;
        const application = Application.of({
          getOrCreateBotChat: () => Effect.die("unexpected bot chat creation"),
          sendBotMessage: () => Effect.die("unexpected bot message"),
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
        });
        yield* install(bot, config).pipe(
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
            defer: async (isPrivate) => {
              assert.isTrue(isPrivate);
              order.push("private-defer");
            },
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
            startThreadWithMessage: async () => {
              throw new Error("unexpected thread creation");
            },
          },
        } satisfies DiscordInputBot;
        const application = Application.of({
          getOrCreateBotChat: () => Effect.die("unexpected bot chat creation"),
          sendBotMessage: () => Effect.die("unexpected bot message"),
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
        });

        yield* install(bot, config).pipe(
          Effect.provideService(Application, application),
          Effect.provide(BunCrypto.layer),
        );
        handlerFor(bot)(message({ channelId: 20n, content: "arrived before close" }));
        yield* Deferred.await(lookupStarted);
        interactionHandlerFor(bot)(
          interaction({
            channelId: 20n,
            data: { name: "close" },
            defer: async () => {
              Effect.runSync(Deferred.succeed(closeDeferred, undefined));
            },
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
            startThreadWithMessage: async () => {
              throw new Error("unexpected thread creation");
            },
          },
        } satisfies DiscordInputBot;
        const application = Application.of({
          getOrCreateBotChat: () => Effect.die("unexpected bot chat creation"),
          sendBotMessage: () => Effect.die("unexpected bot message"),
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
        });

        yield* install(bot, config).pipe(
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
            startThreadWithMessage: async () => {
              throw new Error("unexpected thread creation");
            },
          },
        } satisfies DiscordInputBot;
        const application = Application.of({
          getOrCreateBotChat: () => Effect.die("unexpected bot chat creation"),
          sendBotMessage: () => Effect.die("unexpected bot message"),
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
        });

        yield* install(bot, config).pipe(
          Effect.provideService(Application, application),
          Effect.provide(BunCrypto.layer),
        );
        interactionHandlerFor(bot)(
          interaction({
            channelId: 20n,
            data: { name: "context" },
            defer: async (isPrivate) => {
              assert.isTrue(isPrivate);
            },
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
        let workspace: Workspace.Workspace = {
          id: workspaceId,
          name: "general",
          binding: { platform: "discord", externalId: "10" },
          defaultCwd,
          worktree: null,
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
            startThreadWithMessage: async () => {
              throw new Error("unexpected thread creation");
            },
          },
        } satisfies DiscordInputBot;
        const application = Application.of({
          getOrCreateBotChat: () => Effect.die("unexpected bot chat creation"),
          sendBotMessage: () => Effect.die("unexpected bot message"),
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
        });

        yield* install(bot, config).pipe(
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
            defer: async () => {
              Effect.runSync(Deferred.succeed(secondDeferred, undefined));
            },
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
          binding: { platform: "discord", externalId: "10" },
          defaultCwd,
          worktree: null,
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
            startThreadWithMessage: async () => ({ id: 20n }),
          },
        } satisfies DiscordInputBot;
        const application = Application.of({
          getOrCreateBotChat: () => Effect.die("unexpected bot chat creation"),
          sendBotMessage: () => Effect.die("unexpected bot message"),
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
        });

        yield* install(bot, config).pipe(
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
            startThreadWithMessage: async (_parentId, messageId) => ({
              id: messageId === 11n ? 20n : 21n,
            }),
          },
        } satisfies DiscordInputBot;
        const application = Application.of({
          getOrCreateBotChat: () => Effect.die("unexpected bot chat creation"),
          sendBotMessage: () => Effect.die("unexpected bot message"),
          askBtw: () => Effect.die("unexpected side question"),
          listWorkspaces: () => Effect.die("unexpected workspace list"),
          createWorkspace: () => Effect.die("unexpected explicit workspace creation"),
          getOrCreateWorkspaceByBinding: () =>
            Effect.succeed({
              id: workspaceId,
              name: "general",
              binding: { platform: "discord", externalId: "10" },
              defaultCwd,
              worktree: null,
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
        });

        yield* install(bot, config).pipe(
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
              startThreadWithMessage: async () => ({ id: 20n }),
            },
          } satisfies DiscordInputBot;
          const application = Application.of({
            getOrCreateBotChat: () => Effect.die("unexpected bot chat creation"),
            sendBotMessage: () => Effect.die("unexpected bot message"),
            askBtw: () => Effect.die("unexpected side question"),
            listWorkspaces: () => Effect.die("unexpected workspace list"),
            createWorkspace: () => Effect.die("unexpected explicit workspace creation"),
            getOrCreateWorkspaceByBinding: () =>
              Effect.succeed({
                id: workspaceId,
                name: "general",
                binding: { platform: "discord", externalId: "10" },
                defaultCwd,
                worktree: null,
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
          });

          yield* install(bot, config, () => Effect.void, httpClient).pipe(
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
        let logged = Promise.withResolvers<void>();
        const logger = Logger.make((options) => {
          logs.push(Logger.formatStructured.log(options));
          logged.resolve();
        });
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
            startThreadWithMessage: async () => {
              throw new Error("unexpected thread creation");
            },
          },
        };
        const application = Application.of({
          getOrCreateBotChat: () => Effect.die("unexpected bot chat creation"),
          sendBotMessage: () => Effect.die("unexpected bot message"),
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
        });
        const installed = install(bot, config).pipe(
          Effect.provideService(Application, application),
          Effect.provide(BunCrypto.layer),
          Effect.provide(Logger.layer([logger])),
        );
        yield* installed;
        const invoke = interactionHandlerFor(bot);
        let acknowledged = false;
        invoke(
          interaction({
            id: 51n,
            defer: () => {
              acknowledged = true;
              throw { status: 403, body: '{"code":50013,"message":"private-defer"}' };
            },
            edit: async () => {
              edited++;
            },
          }),
        );
        assert.isTrue(acknowledged);
        yield* Effect.promise(() => logged.promise);
        assert.strictEqual(logs.length, 1);
        assert.strictEqual(logs[0]?.annotations.phase, "defer");
        assert.strictEqual(logs[0]?.annotations.interactionId, "51");
        logged = Promise.withResolvers<void>();
        invoke(
          interaction({
            defer: () => Promise.reject(new Error("private-defer-rejection")),
            edit: async () => {
              edited++;
            },
          }),
        );
        yield* Effect.promise(() => logged.promise);
        assert.strictEqual(logs.length, 2);
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

        const pending = Promise.withResolvers<unknown>();
        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* installed;
            interactionHandlerFor(bot)(
              interaction({
                defer: () => pending.promise,
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
            startThreadWithMessage: async () => {
              throw new Error("unexpected thread creation");
            },
          },
        };
        const application = Application.of({
          getOrCreateBotChat: () => Effect.die("unexpected bot chat creation"),
          sendBotMessage: () => Effect.die("unexpected bot message"),
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
        });
        const httpClient = HttpClient.make((request) =>
          Effect.succeed(HttpClientResponse.fromWeb(request, new Response(null, { status: 500 }))),
        );
        yield* install(bot, config, () => Effect.void, httpClient).pipe(
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
            startThreadWithMessage: async () => {
              throw new Error("unexpected thread creation");
            },
          },
        };
        const application = Application.of({
          getOrCreateBotChat: () => Effect.die("unexpected bot chat creation"),
          sendBotMessage: () => Effect.die("unexpected bot message"),
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
        });
        yield* install(bot, config).pipe(
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
