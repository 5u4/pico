import * as BunCrypto from "@effect/platform-bun/BunCrypto";
import { assert, describe, it } from "@effect/vitest";
import type { AgentEvent } from "@pico/contract/agent-event";
import type { AgentPrompt } from "@pico/contract/agent-message";
import { Application } from "@pico/contract/application";
import type * as Chat from "@pico/contract/chat-model";
import { ApplicationError } from "@pico/contract/errors";
import { AbsolutePath } from "@pico/contract/path";
import type { ReplyTarget } from "@pico/contract/reply-target";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import {
  chatId,
  config,
  handlerFor,
  interaction,
  interactionHandlerFor,
  message,
  workspaceId,
} from "./discord-input.fixture.ts";
import { type DiscordInputBot, install } from "./discord-input.ts";
import {
  type DiscordOutputClient,
  makeReplyDelivery,
  type RenderedMessage,
} from "./discord-output.ts";
import type { DiscordMessage } from "./discord-prompt.ts";

const botRoot = AbsolutePath.make("/tmp/pico-discord-bot/agents/discord/bots/999");
const chat: Chat.Chat = {
  id: chatId,
  workspaceId,
  cwd: AbsolutePath.make(`${botRoot}/work`),
  externalId: null,
  createdAt: 0,
  archivedAt: null,
};
const directMessage = (
  overrides: Partial<Omit<DiscordMessage, "guildId">> = {},
): DiscordMessage => ({
  author: { id: 100n },
  channelId: 101n,
  id: 1001n,
  content: "hello",
  attachments: [],
  ...overrides,
});
const completed = (text: string): AgentEvent => ({
  type: "message-settled",
  message: {
    role: "assistant",
    status: "completed",
    stopReason: "stop",
    content: [{ type: "text", text }],
    model: "test",
    timestamp: 0,
  },
});
const pngBytes = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

const fixture = Effect.fn("DiscordBotTest.fixture")(function* (options: {
  readonly sendBotMessage: Application["Service"]["sendBotMessage"];
  readonly getOrCreateBotChat?: Application["Service"]["getOrCreateBotChat"];
  readonly httpClient?: HttpClient.HttpClient;
}) {
  const replies: Array<{
    readonly channelId: bigint;
    readonly content: string;
    readonly replyTo: bigint | undefined;
  }> = [];
  const sent: Array<{ readonly channelId: bigint; readonly message: RenderedMessage }> = [];
  const edits: Array<{ readonly channelId: bigint; readonly messageId: bigint }> = [];
  const resolvedRoots: Array<AbsolutePath> = [];
  const replyReceived = yield* Deferred.make<void>();
  const bot: DiscordInputBot = {
    id: 999n,
    events: {},
    helpers: {
      addReaction: async () => {
        throw new Error("DM must not apply thread delivery reactions");
      },
      deleteOwnReaction: async () => {
        throw new Error("DM must not apply thread delivery reactions");
      },
      getChannel: async () => {
        throw new Error("DM must not resolve a thread");
      },
      sendMessage: async (channelId, options) => {
        replies.push({
          channelId,
          content: options.content,
          replyTo: options.messageReference?.messageId,
        });
        Deferred.doneUnsafe(replyReceived, Effect.void);
      },
      editChannel: async () => {
        throw new Error("DM must not archive a thread");
      },
      startThreadWithMessage: async () => {
        throw new Error("DM must not create a thread");
      },
    },
  };
  const outputClient: DiscordOutputClient = {
    send: (channelId, message) =>
      Effect.sync(() => {
        sent.push({ channelId, message });
        return BigInt(sent.length);
      }),
    edit: (channelId, messageId) =>
      Effect.sync(() => {
        edits.push({ channelId, messageId });
      }),
    renameThread: () => Effect.die("DM must not rename a thread"),
    triggerTyping: () => Effect.void,
  };
  const application = Application.of({
    listWorkspaces: () => Effect.die("DM must not list workspaces"),
    createWorkspace: () => Effect.die("DM must not create a guild workspace"),
    getOrCreateWorkspaceByBinding: () => Effect.die("DM must not create a guild workspace"),
    bindWorkspace: () => Effect.die("DM must not bind a workspace"),
    listChats: () => Effect.die("DM must not list thread chats"),
    createChat: () => Effect.die("DM must not create a thread chat"),
    getOrCreateBotChat:
      options.getOrCreateBotChat ??
      ((descriptor) =>
        Effect.sync(() => {
          assert.strictEqual(descriptor.platform, "discord");
          resolvedRoots.push(descriptor.botRoot);
          return chat;
        })),
    sendBotMessage: options.sendBotMessage,
    findWorkspaceByPlatformId: () => Effect.die("DM must not look up a channel workspace"),
    findChatByPlatformId: () => Effect.die("DM must not look up a thread chat"),
    findChatPlatformBinding: () => Effect.succeed(Option.none()),
    transcript: () => Effect.die("unexpected transcript read"),
    closeChat: () => Effect.die("DM commands must not close a shared bot chat"),
    sendMessage: () => Effect.die("DM must not use thread message delivery"),
    askBtw: () => Effect.die("DM commands must not start a side turn"),
    abort: () => Effect.die("DM commands must not abort a shared bot chat"),
    contextUsage: () => Effect.die("DM commands must not inspect a thread chat"),
    shake: () => Effect.die("DM commands must not compact a thread chat"),
  });
  const httpClient =
    options.httpClient ??
    HttpClient.make((request) =>
      Effect.succeed(HttpClientResponse.fromWeb(request, new Response(pngBytes))),
    );
  const resolveThreadId = yield* install(
    bot,
    { ...config, allowedGuildIds: [], showToolCalls: true },
    undefined,
    httpClient,
    { botRoot, outputClient },
  ).pipe(Effect.provideService(Application, application), Effect.provide(BunCrypto.layer));
  return {
    bot,
    sent,
    edits,
    replies,
    replyReceived,
    resolvedRoots,
    resolveThreadId,
    replyDelivery: makeReplyDelivery(outputClient),
  };
});

describe("Discord bot direct messages", () => {
  it.effect(
    "keeps concurrent senders on one chat without sharing reply destinations or thread state",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const firstRunning = yield* Deferred.make<void>();
          const attachmentRequested = yield* Deferred.make<void>();
          const releaseAttachment = yield* Deferred.make<void>();
          const releaseFirst = yield* Deferred.make<void>();
          const allFinished = yield* Deferred.make<void>();
          const received: Array<{
            readonly id: Chat.ChatId;
            readonly prompt: AgentPrompt;
            readonly replyTarget: ReplyTarget | undefined;
          }> = [];
          const harness = yield* fixture({
            httpClient: HttpClient.make((request) =>
              Effect.gen(function* () {
                yield* Deferred.succeed(attachmentRequested, undefined);
                yield* Deferred.await(releaseAttachment);
                return HttpClientResponse.fromWeb(request, new Response(pngBytes));
              }),
            ),
            sendBotMessage: (id, prompt, onEvent, replyTarget) =>
              Effect.gen(function* () {
                received.push({ id, prompt, replyTarget });
                yield* onEvent({ type: "run-started" });
                yield* onEvent({ type: "title-changed", title: "Not a Discord thread" });
                yield* onEvent({
                  type: "tool-started",
                  toolCallId: "same-tool-id",
                  toolName: "read",
                  argumentsJson: "{}",
                });
                if (prompt.text === "first") {
                  yield* Deferred.succeed(firstRunning, undefined);
                  yield* Deferred.await(releaseFirst);
                }
                yield* onEvent({
                  type: "tool-finished",
                  toolCallId: "same-tool-id",
                  toolName: "read",
                  status: "succeeded",
                });
                yield* onEvent(completed(`reply to ${prompt.text}`));
                yield* onEvent({ type: "run-finished", outcome: "completed" });
                if (prompt.text === "second") yield* Deferred.succeed(allFinished, undefined);
              }).pipe(
                Effect.mapError(
                  () =>
                    new ApplicationError({ reason: "operation", message: "test output failed" }),
                ),
              ),
          });
          const handle = handlerFor(harness.bot);
          handle(directMessage({ author: { id: 999n } }));
          handle(directMessage({ author: { id: 500n, bot: true } }));
          handle(directMessage({ webhookId: 123n }));
          handle(message({ guildId: 1n }));
          handle(
            directMessage({
              channelId: 101n,
              id: 1001n,
              author: { id: 11n },
              content: "first",
              attachments: [
                {
                  filename: "diagram.png",
                  contentType: "image/png",
                  size: pngBytes.length,
                  url: "https://cdn.discordapp.com/attachments/1/2/diagram.png",
                },
              ],
            }),
          );
          yield* Deferred.await(attachmentRequested);
          handle(
            directMessage({ channelId: 202n, id: 2002n, author: { id: 22n }, content: "second" }),
          );
          yield* Effect.yieldNow;
          assert.deepStrictEqual(received, []);
          yield* Deferred.succeed(releaseAttachment, undefined);
          yield* Deferred.await(firstRunning);
          assert.deepStrictEqual(
            received.map(({ prompt }) => prompt.text),
            ["first"],
          );
          yield* Deferred.succeed(releaseFirst, undefined);
          yield* Deferred.await(allFinished);

          assert.deepStrictEqual(harness.resolvedRoots, [botRoot, botRoot]);
          assert.deepStrictEqual(
            received.map(({ id, prompt }) => [id, prompt.text]),
            [
              [chatId, "first"],
              [chatId, "second"],
            ],
          );
          assert.deepStrictEqual(
            received.map(({ replyTarget }) => replyTarget),
            [
              { platform: "discord", conversationId: "101", messageId: "1001" },
              { platform: "discord", conversationId: "202", messageId: "2002" },
            ],
          );
          assert.strictEqual(received[0]?.prompt.attachments[0]?.data, pngBytes.toString("base64"));
          assert.deepStrictEqual(
            harness.sent.filter(({ message }) => !message.silent),
            [
              {
                channelId: 101n,
                message: { content: "reply to first", silent: false, replyTo: 1001n },
              },
              {
                channelId: 202n,
                message: { content: "reply to second", silent: false, replyTo: 2002n },
              },
            ],
          );
          assert.deepStrictEqual(harness.edits, [
            { channelId: 101n, messageId: 1n },
            { channelId: 202n, messageId: 3n },
          ]);
          assert.deepStrictEqual(
            harness.sent.map(({ channelId, message }) => [channelId, message.replyTo]),
            [
              [101n, 1001n],
              [101n, 1001n],
              [202n, 2002n],
              [202n, 2002n],
            ],
          );
          assert.isTrue(Option.isNone(yield* harness.resolveThreadId(chatId)));
          assert.deepStrictEqual(harness.replies, []);
        }),
      ),
  );

  it.effect("delivers stored A and B routes then A again after an unrelated DM", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const liveFinished = yield* Deferred.make<void>();
        const received: Array<ReplyTarget | undefined> = [];
        const harness = yield* fixture({
          sendBotMessage: (_id, _prompt, onEvent, replyTarget) =>
            Effect.gen(function* () {
              received.push(replyTarget);
              yield* onEvent({ type: "run-started" });
              yield* onEvent(completed("unrelated live reply"));
              yield* onEvent({ type: "run-finished", outcome: "completed" });
              yield* Deferred.succeed(liveFinished, undefined);
            }).pipe(
              Effect.mapError(
                () => new ApplicationError({ reason: "operation", message: "test output failed" }),
              ),
            ),
        });
        const routeA: ReplyTarget = {
          platform: "discord",
          conversationId: "101",
          messageId: "1001",
        };
        const routeB: ReplyTarget = {
          platform: "discord",
          conversationId: "202",
          messageId: "2002",
        };
        yield* harness.replyDelivery.send(chatId, routeA, "scheduled A");
        yield* harness.replyDelivery.send(chatId, routeB, "| A | B |\n| --- | --- |\n| x | y |");
        handlerFor(harness.bot)(
          directMessage({ channelId: 303n, id: 3003n, content: "unrelated" }),
        );
        yield* Deferred.await(liveFinished);
        yield* harness.replyDelivery.send(chatId, routeA, "x".repeat(4_500));

        assert.deepStrictEqual(received, [
          { platform: "discord", conversationId: "303", messageId: "3003" },
        ]);
        assert.deepStrictEqual(harness.sent, [
          { channelId: 101n, message: { content: "scheduled A", silent: false, replyTo: 1001n } },
          {
            channelId: 202n,
            message: { content: "- **x**\n  - B: y", silent: false, replyTo: 2002n },
          },
          {
            channelId: 303n,
            message: { content: "unrelated live reply", silent: false, replyTo: 3003n },
          },
          {
            channelId: 101n,
            message: { content: "x".repeat(2_000), silent: false, replyTo: 1001n },
          },
          {
            channelId: 101n,
            message: { content: "x".repeat(2_000), silent: false, replyTo: 1001n },
          },
          { channelId: 101n, message: { content: "x".repeat(500), silent: false, replyTo: 1001n } },
        ]);
        assert.deepStrictEqual(harness.edits, []);
        assert.deepStrictEqual(harness.replies, []);
        assert.isTrue(Option.isNone(yield* harness.resolveThreadId(chatId)));
      }),
    ),
  );

  it.effect("replies to the triggering DM when chat resolution or rotation fails", () =>
    Effect.gen(function* () {
      for (const phase of ["resolve", "rotate"]) {
        yield* Effect.scoped(
          Effect.gen(function* () {
            const failure = new ApplicationError({
              reason: "operation",
              message: "private handoff path",
            });
            const harness = yield* fixture({
              getOrCreateBotChat: () =>
                phase === "resolve" ? Effect.fail(failure) : Effect.succeed(chat),
              sendBotMessage: () => Effect.fail(failure),
            });
            handlerFor(harness.bot)(directMessage({ channelId: 202n, id: 2002n }));
            yield* Deferred.await(harness.replyReceived);
            assert.deepStrictEqual(
              harness.replies.map(({ channelId, replyTo }) => ({ channelId, replyTo })),
              [{ channelId: 202n, replyTo: 2002n }],
            );
            assert.notInclude(harness.replies[0]?.content ?? "", "private handoff path");
            assert.match(harness.replies[0]?.content ?? "", /could not/i);
            assert.deepStrictEqual(harness.sent, []);
          }),
        );
      }
    }),
  );

  it.effect("rejects guild commands in DMs before any thread control effects", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* fixture({
          sendBotMessage: () => Effect.die("a command must not prompt the bot"),
        });
        const handle = interactionHandlerFor(harness.bot);
        for (const name of ["close", "abort", "btw", "bind", "shake", "context"]) {
          const responded = yield* Deferred.make<string>();
          const command = interaction({
            channelId: 202n,
            data: { name },
            defer: async () => {
              throw new Error("DM command must not enter thread defer flow");
            },
            respond: async (options) => {
              Deferred.doneUnsafe(responded, Effect.succeed(options.content ?? ""));
            },
          });
          Reflect.deleteProperty(command, "guildId");
          handle(command);
          assert.match(yield* Deferred.await(responded), /server channels and threads/);
        }
        assert.deepStrictEqual(harness.resolvedRoots, []);
        assert.deepStrictEqual(harness.sent, []);
      }),
    ),
  );
});
