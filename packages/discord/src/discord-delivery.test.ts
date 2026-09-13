import * as BunCrypto from "@effect/platform-bun/BunCrypto";
import { assert, describe, it } from "@effect/vitest";
import type { MessageDelivery } from "@pico/contract/agent-runtime";
import { Application } from "@pico/contract/application";
import * as Chat from "@pico/contract/chat-model";
import { ApplicationError } from "@pico/contract/errors";
import { AbsolutePath } from "@pico/contract/path";
import * as Workspace from "@pico/contract/workspace-model";
import { ChannelTypes } from "discordeno";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as TestClock from "effect/testing/TestClock";
import { type DiscordInputBot, install } from "./discord-input.ts";
import type { DiscordMessage } from "./discord-prompt.ts";

const workspaceId = Workspace.WorkspaceId.make("018f47a0-0000-7000-8000-000000000001");
const chatId = Chat.ChatId.make("018f47a0-0000-7000-8000-000000000002");
const cwd = AbsolutePath.make("/tmp/pico-discord-delivery");
const chat: Chat.Chat = {
  id: chatId,
  workspaceId,
  cwd,
  externalId: "20",
  createdAt: 0,
  archivedAt: null,
};
const message = (id: bigint, channelId = 20n): DiscordMessage => ({
  id,
  channelId,
  guildId: 1n,
  author: { id: 100n },
  content: "same message",
  attachments: [],
});

const installInput = Effect.fn("test.installDeliveryInput")(function* (options: {
  readonly sendMessage: Application["Service"]["sendMessage"];
  readonly reactions: Pick<DiscordInputBot["helpers"], "addReaction" | "deleteOwnReaction">;
}) {
  const bot: DiscordInputBot = {
    id: 999n,
    events: {},
    helpers: {
      ...options.reactions,
      getChannel: async (channelId) =>
        channelId === 10n
          ? { id: 10n, guildId: 1n, type: ChannelTypes.GuildText, name: "general" }
          : { id: 20n, guildId: 1n, type: ChannelTypes.PublicThread, parentId: 10n },
      sendMessage: async () => undefined,
      editChannel: async () => undefined,
      startThreadWithMessage: async () => ({ id: 20n }),
    },
  };
  const application = Application.of({
    getOrCreateBotChat: () => Effect.die("unexpected bot chat creation"),
    sendBotMessage: () => Effect.die("unexpected bot message"),
    askBtw: () => Effect.die("unexpected side question"),
    createWorkspace: () => Effect.die("unexpected explicit workspace creation"),
    getOrCreateWorkspaceByBinding: () => Effect.die("unexpected workspace creation"),
    bindWorkspace: () => Effect.die("unexpected workspace binding"),
    createChat: () => Effect.succeed(chat),
    findWorkspaceByPlatformId: () =>
      Effect.succeed(
        Option.some({
          id: workspaceId,
          name: "general",
          binding: { platform: "discord", externalId: "10" },
          defaultCwd: cwd,
          worktree: null,
          createdAt: 0,
        }),
      ),
    findChatByPlatformId: () => Effect.succeed(Option.some(chat)),
    findChatPlatformBinding: () => Effect.die("unexpected chat binding lookup"),
    transcript: () => Effect.die("unexpected transcript read"),
    sendMessage: options.sendMessage,
    abort: () => Effect.die("unexpected chat abort"),
    contextUsage: () => Effect.die("unexpected context read"),
    shake: () => Effect.die("unexpected chat shake"),
    closeChat: () => Effect.die("unexpected chat close"),
  });
  yield* install(bot, {
    token: Redacted.make("test"),
    allowedGuildIds: ["1"],
    defaultCwd: cwd,
    showToolCalls: true,
    showThinking: false,
  }).pipe(Effect.provideService(Application, application), Effect.provide(BunCrypto.layer));
  const handle = bot.events.messageCreate;
  if (handle === undefined) return yield* Effect.die("Discord input handler was not installed");
  return handle;
});

describe("Discord message delivery", () => {
  it.effect("admits the next message before completion and retains the first failure context", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const completionObserved = yield* Deferred.make<void>();
        const completion = yield* Deferred.make<void, ApplicationError>();
        const secondAdmitted = yield* Deferred.make<void>();
        const reported = Promise.withResolvers<void>();
        const logs: Array<ReturnType<typeof Logger.formatStructured.log>> = [];
        const reactions: string[] = [];
        let admissions = 0;
        const logger = Logger.make((options) => {
          const entry = Logger.formatStructured.log(options);
          logs.push(entry);
          if (entry.annotations.operation === "message-request") reported.resolve();
        });
        const handle = yield* installInput({
          sendMessage: () =>
            Effect.gen(function* () {
              admissions += 1;
              if (admissions === 1) {
                return {
                  kind: "started",
                  completed: Deferred.succeed(completionObserved, undefined).pipe(
                    Effect.andThen(Deferred.await(completion)),
                  ),
                } satisfies MessageDelivery<ApplicationError>;
              }
              yield* Deferred.succeed(secondAdmitted, undefined);
              return { kind: "handled" } satisfies MessageDelivery<ApplicationError>;
            }),
          reactions: {
            addReaction: async (_channelId, _messageId, reaction) => {
              reactions.push(reaction);
            },
            deleteOwnReaction: async (_channelId, _messageId, reaction) => {
              reactions.push(reaction);
            },
          },
        }).pipe(Effect.provide(Logger.layer([logger])));

        handle(message(101n, 10n));
        yield* Deferred.await(completionObserved);
        handle(message(102n));
        yield* Deferred.await(secondAdmitted);
        assert.isFalse(yield* Deferred.isDone(completion));
        assert.deepStrictEqual(reactions, []);
        yield* Deferred.fail(
          completion,
          new ApplicationError({ reason: "operation", message: "Message send failed" }),
        );
        yield* Effect.promise(() => reported.promise);
        assert.strictEqual(logs.length, 1);
        assert.deepStrictEqual(
          {
            operation: logs[0]?.annotations.operation,
            phase: logs[0]?.annotations.phase,
            chatId: logs[0]?.annotations.chatId,
            threadId: logs[0]?.annotations.threadId,
            channelId: logs[0]?.annotations.channelId,
            messageId: logs[0]?.annotations.messageId,
          },
          {
            operation: "message-request",
            phase: "send-prompt",
            chatId,
            threadId: "20",
            channelId: "10",
            messageId: "101",
          },
        );
      }),
    ),
  );

  it.effect(
    "tracks equal messages separately and removes discarded input without a consumed mark",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const firstConsumed = yield* Deferred.make<"consumed" | "discarded">();
          const secondConsumed = yield* Deferred.make<"consumed" | "discarded">();
          const firstPending = Promise.withResolvers<void>();
          const secondPending = Promise.withResolvers<void>();
          const secondMarked = Promise.withResolvers<void>();
          const firstRemoved = Promise.withResolvers<void>();
          const actions: string[] = [];
          const prompts: string[] = [];
          const deliveries: Array<MessageDelivery<ApplicationError>> = [
            { kind: "steered", consumed: Deferred.await(firstConsumed), completed: Effect.void },
            { kind: "steered", consumed: Deferred.await(secondConsumed), completed: Effect.void },
          ];
          const handle = yield* installInput({
            sendMessage: (_chatId, prompt) =>
              Effect.sync(() => {
                prompts.push(prompt.text);
                const delivery = deliveries.shift();
                if (delivery === undefined) throw new Error("unexpected extra admission");
                return delivery;
              }),
            reactions: {
              addReaction: async (channelId, messageId, reaction) => {
                actions.push(`add:${channelId}:${messageId}:${reaction}`);
                if (reaction === "⏳") {
                  (messageId === 101n ? firstPending : secondPending).resolve();
                } else {
                  secondMarked.resolve();
                }
              },
              deleteOwnReaction: async (channelId, messageId, reaction) => {
                actions.push(`remove:${channelId}:${messageId}:${reaction}`);
                if (messageId === 101n) firstRemoved.resolve();
              },
            },
          });

          handle(message(101n, 10n));
          yield* Effect.promise(() => firstPending.promise);
          handle(message(102n));
          yield* Effect.promise(() => secondPending.promise);
          assert.deepStrictEqual(prompts, ["same message", "same message"]);
          assert.deepStrictEqual(actions, ["add:10:101:⏳", "add:20:102:⏳"]);
          yield* Deferred.succeed(secondConsumed, "consumed");
          yield* Effect.promise(() => secondMarked.promise);
          assert.deepStrictEqual(actions, [
            "add:10:101:⏳",
            "add:20:102:⏳",
            "remove:20:102:⏳",
            "add:20:102:↩️",
          ]);
          assert.isFalse(yield* Deferred.isDone(firstConsumed));
          yield* Deferred.succeed(firstConsumed, "discarded");
          yield* Effect.promise(() => firstRemoved.promise);
          yield* TestClock.adjust("1 millis");
          assert.deepStrictEqual(actions, [
            "add:10:101:⏳",
            "add:20:102:⏳",
            "remove:20:102:⏳",
            "add:20:102:↩️",
            "remove:10:101:⏳",
          ]);
        }),
      ),
  );

  it.effect(
    "serializes a delayed pending reaction after admission without blocking later messages",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const admissionStarted = yield* Deferred.make<void>();
          const releaseAdmission = yield* Deferred.make<void>();
          const consumed = yield* Deferred.make<"consumed" | "discarded">();
          const secondAdmitted = yield* Deferred.make<void>();
          const pendingStarted = Promise.withResolvers<void>();
          const releasePending = Promise.withResolvers<void>();
          const marked = Promise.withResolvers<void>();
          const actions: string[] = [];
          let admissions = 0;
          const handle = yield* installInput({
            sendMessage: () =>
              Effect.gen(function* () {
                admissions += 1;
                if (admissions === 1) {
                  yield* Deferred.succeed(admissionStarted, undefined);
                  yield* Deferred.await(releaseAdmission);
                  return {
                    kind: "steered",
                    consumed: Deferred.await(consumed),
                    completed: Effect.void,
                  } satisfies MessageDelivery<ApplicationError>;
                }
                yield* Deferred.succeed(secondAdmitted, undefined);
                return { kind: "handled" } satisfies MessageDelivery<ApplicationError>;
              }),
            reactions: {
              addReaction: async (_channelId, _messageId, reaction) => {
                if (reaction === "⏳") {
                  actions.push("pending-start");
                  pendingStarted.resolve();
                  await releasePending.promise;
                  actions.push("pending-end");
                } else {
                  actions.push("consumed");
                  marked.resolve();
                }
              },
              deleteOwnReaction: async () => {
                actions.push("remove-pending");
              },
            },
          });

          handle(message(101n));
          yield* Deferred.await(admissionStarted);
          handle(message(102n));
          yield* TestClock.adjust("1 millis");
          assert.strictEqual(admissions, 1);
          assert.deepStrictEqual(actions, []);
          yield* Deferred.succeed(releaseAdmission, undefined);
          yield* Effect.promise(() => pendingStarted.promise);
          yield* Deferred.await(secondAdmitted);
          yield* Deferred.succeed(consumed, "consumed");
          yield* TestClock.adjust("1 millis");
          assert.deepStrictEqual(actions, ["pending-start"]);
          releasePending.resolve();
          yield* Effect.promise(() => marked.promise);
          assert.deepStrictEqual(actions, [
            "pending-start",
            "pending-end",
            "remove-pending",
            "consumed",
          ]);
        }),
      ),
  );

  it.effect(
    "reports each reaction failure without canceling completion or suppressing later updates",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const consumed = yield* Deferred.make<"consumed" | "discarded">();
          const completed = yield* Deferred.make<void>();
          const completionObserved = yield* Deferred.make<void>();
          const completionFinished = yield* Deferred.make<void>();
          const pendingReported = Promise.withResolvers<void>();
          const finalReported = Promise.withResolvers<void>();
          const actions: string[] = [];
          const logs: Array<ReturnType<typeof Logger.formatStructured.log>> = [];
          const logger = Logger.make((options) => {
            const entry = Logger.formatStructured.log(options);
            logs.push(entry);
            if (entry.annotations.operation === "add-pending-reaction") pendingReported.resolve();
            if (entry.annotations.operation === "add-consumed-reaction") finalReported.resolve();
          });
          const handle = yield* installInput({
            sendMessage: () =>
              Effect.succeed({
                kind: "steered",
                consumed: Deferred.await(consumed),
                completed: Effect.gen(function* () {
                  yield* Deferred.succeed(completionObserved, undefined);
                  yield* Deferred.await(completed);
                  yield* Deferred.succeed(completionFinished, undefined);
                }),
              } satisfies MessageDelivery<ApplicationError>),
            reactions: {
              addReaction: async (_channelId, _messageId, reaction) => {
                actions.push(`add:${reaction}`);
                throw { status: 403, body: '{"code":50013}' };
              },
              deleteOwnReaction: async (_channelId, _messageId, reaction) => {
                actions.push(`remove:${reaction}`);
                throw { status: 500 };
              },
            },
          }).pipe(Effect.provide(Logger.layer([logger])));

          handle(message(101n));
          yield* Deferred.await(completionObserved);
          yield* Effect.promise(() => pendingReported.promise);
          assert.deepStrictEqual(actions, ["add:⏳"]);
          yield* Deferred.succeed(consumed, "consumed");
          yield* Effect.promise(() => finalReported.promise);
          assert.deepStrictEqual(actions, ["add:⏳", "remove:⏳", "add:↩️"]);
          assert.deepStrictEqual(
            logs.map(({ annotations }) => ({
              operation: annotations.operation,
              status: annotations.status,
              channelId: annotations.channelId,
              messageId: annotations.messageId,
            })),
            [
              { operation: "add-pending-reaction", status: 403, channelId: "20", messageId: "101" },
              {
                operation: "remove-pending-reaction",
                status: 500,
                channelId: "20",
                messageId: "101",
              },
              {
                operation: "add-consumed-reaction",
                status: 403,
                channelId: "20",
                messageId: "101",
              },
            ],
          );
          assert.isFalse(yield* Deferred.isDone(completionFinished));
          yield* Deferred.succeed(completed, undefined);
          yield* Deferred.await(completionFinished);
        }),
      ),
  );

  it.effect("stops observing receipts when the Discord service scope closes", () =>
    Effect.gen(function* () {
      const consumed = yield* Deferred.make<"consumed" | "discarded">();
      const consumptionObserved = yield* Deferred.make<void>();
      const completionObserved = yield* Deferred.make<void>();
      const consumptionInterrupted = yield* Deferred.make<void>();
      const completionInterrupted = yield* Deferred.make<void>();
      const actions: string[] = [];
      yield* Effect.scoped(
        Effect.gen(function* () {
          const handle = yield* installInput({
            sendMessage: () =>
              Effect.succeed({
                kind: "steered",
                consumed: Deferred.succeed(consumptionObserved, undefined).pipe(
                  Effect.andThen(Deferred.await(consumed)),
                  Effect.onInterrupt(() => Deferred.succeed(consumptionInterrupted, undefined)),
                ),
                completed: Deferred.succeed(completionObserved, undefined).pipe(
                  Effect.andThen(Effect.never),
                  Effect.onInterrupt(() => Deferred.succeed(completionInterrupted, undefined)),
                ),
              } satisfies MessageDelivery<ApplicationError>),
            reactions: {
              addReaction: async (_channelId, _messageId, reaction) => {
                actions.push(`add:${reaction}`);
              },
              deleteOwnReaction: async (_channelId, _messageId, reaction) => {
                actions.push(`remove:${reaction}`);
              },
            },
          });
          handle(message(101n));
          yield* Deferred.await(consumptionObserved);
          yield* Deferred.await(completionObserved);
          assert.isFalse(yield* Deferred.isDone(consumptionInterrupted));
          assert.isFalse(yield* Deferred.isDone(completionInterrupted));
        }),
      );
      assert.isTrue(yield* Deferred.isDone(consumptionInterrupted));
      assert.isTrue(yield* Deferred.isDone(completionInterrupted));
      yield* Deferred.succeed(consumed, "consumed");
      yield* TestClock.adjust("1 millis");
      assert.deepStrictEqual(actions, ["add:⏳"]);
    }),
  );
});
