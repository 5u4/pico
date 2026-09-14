import * as BunCrypto from "@effect/platform-bun/BunCrypto";
import { assert, describe, it } from "@effect/vitest";
import type { AgentEvent } from "@pico/contract/agent-event";
import type { AgentPrompt } from "@pico/contract/agent-message";
import type { ContextUsage, ModelInfo, ShakeResult } from "@pico/contract/agent-runtime";
import { Application } from "@pico/contract/application";
import type * as Chat from "@pico/contract/chat-model";
import { ApplicationError } from "@pico/contract/errors";
import { AbsolutePath } from "@pico/contract/path";
import type { ReplyTarget } from "@pico/contract/reply-target";
import { ApplicationCommandOptionTypes, InteractionTypes } from "discordeno";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import {
  chatId,
  config,
  handlerFor,
  interaction,
  interactionHandlerFor,
  message,
  modelOptions,
  modelSuggestions,
  privateCommandReply,
  workspaceId,
} from "./discord-input.fixture.ts";
import { type DiscordInputBot, type DiscordInteraction, install } from "./discord-input.ts";
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
const directInteraction = (
  overrides: Partial<Omit<DiscordInteraction, "guildId">> = {},
): DiscordInteraction => {
  const command = interaction(overrides);
  Reflect.deleteProperty(command, "guildId");
  return command;
};
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
  readonly contextUsage?: Application["Service"]["contextUsage"];
  readonly shake?: Application["Service"]["shake"];
  readonly availableModels?: Application["Service"]["availableModels"];
  readonly switchModel?: Application["Service"]["switchModel"];
  readonly botStorage?: boolean;
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
    askBtw: () => Effect.die("unexpected side question"),
    abort: () => Effect.die("DM commands must not abort a shared bot chat"),
    contextUsage: options.contextUsage ?? (() => Effect.die("unexpected context read")),
    availableModels: options.availableModels ?? (() => Effect.die("unexpected model discovery")),
    switchModel: options.switchModel ?? (() => Effect.die("unexpected model switch")),
    shake: options.shake ?? (() => Effect.die("unexpected chat shake")),
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
    options.botStorage === false ? undefined : { botRoot, outputClient },
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
    "discovers models before a DM exists and resolves bounded choices without truncating identities",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const longId = "family/".repeat(20);
          const longA = { provider: "custom", id: `${longId}a`, name: "A".repeat(120) };
          const longB = { provider: "custom", id: `${longId}b`, name: "B".repeat(120) };
          const short = {
            provider: "native",
            id: "nested/sonnet",
            name: `Swift model ${"\u{1D440}".repeat(120)}`,
          };
          let catalog: readonly ModelInfo[] = [
            longA,
            longB,
            short,
            ...Array.from({ length: 25 }, (_, index) => ({
              provider: "other",
              id: `model-${index}`,
              name: `Model ${index}`,
            })),
          ];
          const selected: ModelInfo[] = [];
          const harness = yield* fixture({
            sendBotMessage: () => Effect.die("autocomplete must not prompt"),
            availableModels: (target) => {
              assert.deepStrictEqual(target, {
                kind: "bot",
                bot: { botRoot, platform: "discord" },
              });
              return Effect.succeed(catalog);
            },
            switchModel: (id, ref) =>
              Effect.gen(function* () {
                assert.strictEqual(id, chatId);
                const model = catalog.find(
                  (model) => model.provider === ref.provider && model.id === ref.id,
                );
                if (model === undefined) return yield* Effect.die("selection was not resolved");
                selected.push(model);
                return model;
              }),
          });
          const suggestions = yield* modelSuggestions(
            harness.bot,
            directInteraction({ data: { name: "switch", options: modelOptions("", true) } }),
          );
          assert.strictEqual(suggestions.length, 25);
          for (const choice of suggestions) {
            assert.isAtMost(choice.name.length, 100);
            assert.isAtMost(String(choice.value).length, 100);
          }
          assert.notStrictEqual(suggestions[0]?.value, suggestions[1]?.value);
          assert.strictEqual(suggestions[2]?.value, "native/nested/sonnet");
          for (const query of ["NATIVE", "nested/sonnet", "swift"]) {
            const matches = yield* modelSuggestions(
              harness.bot,
              directInteraction({ data: { name: "switch", options: modelOptions(query, true) } }),
            );
            assert.deepStrictEqual(
              matches.map(({ value }) => value),
              ["native/nested/sonnet"],
            );
          }
          assert.deepStrictEqual(harness.resolvedRoots, []);
          const token = suggestions[1]?.value;
          if (typeof token !== "string") return yield* Effect.die("missing string choice");
          yield* privateCommandReply(
            harness.bot,
            directInteraction({ data: { name: "switch", options: modelOptions(token) } }),
          );
          assert.deepStrictEqual(selected, [longB]);
          assert.deepStrictEqual(harness.resolvedRoots, [botRoot]);
          catalog = [short];
          yield* privateCommandReply(
            harness.bot,
            directInteraction({ data: { name: "switch", options: modelOptions(token) } }),
          );
          assert.deepStrictEqual(selected, [longB]);
          assert.deepStrictEqual(harness.resolvedRoots, [botRoot]);
        }),
      ),
  );

  it.effect(
    "answers autocomplete during a DM turn while a submitted switch keeps shared bot ordering",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const firstStarted = yield* Deferred.make<void>();
          const releaseFirst = yield* Deferred.make<void>();
          const switched = yield* Deferred.make<string>();
          const acknowledged = yield* Deferred.make<void>();
          const laterSent = yield* Deferred.make<void>();
          const model = { provider: "native", id: "next", name: "Next model" };
          let activeModel = "original";
          const seen: string[] = [];
          const harness = yield* fixture({
            availableModels: () => Effect.succeed([model]),
            switchModel: () =>
              Effect.sync(() => {
                activeModel = model.id;
                return model;
              }),
            sendBotMessage: (_id, prompt) =>
              Effect.gen(function* () {
                seen.push(activeModel);
                if (prompt.text === "first") {
                  yield* Deferred.succeed(firstStarted, undefined);
                  yield* Deferred.await(releaseFirst);
                } else {
                  yield* Deferred.succeed(laterSent, undefined);
                }
              }),
          });
          handlerFor(harness.bot)(directMessage({ content: "first" }));
          yield* Deferred.await(firstStarted);
          const choices = yield* modelSuggestions(
            harness.bot,
            directInteraction({
              channelId: 202n,
              user: { id: 22n },
              data: { name: "switch", options: modelOptions("", true) },
            }),
          );
          assert.deepStrictEqual(
            choices.map(({ value }) => value),
            ["native/next"],
          );
          assert.deepStrictEqual(harness.resolvedRoots, [botRoot]);
          interactionHandlerFor(harness.bot)(
            directInteraction({
              channelId: 202n,
              user: { id: 22n },
              data: { name: "switch", options: modelOptions("native/next") },
              defer: async (isPrivate) => {
                assert.isTrue(isPrivate);
                Deferred.doneUnsafe(acknowledged, Effect.void);
              },
              edit: async (response) => {
                assert.deepStrictEqual(response.allowedMentions, { parse: [], repliedUser: false });
                Deferred.doneUnsafe(switched, Effect.succeed(response.content ?? ""));
              },
            }),
          );
          yield* Deferred.await(acknowledged);
          assert.strictEqual(activeModel, "original");
          yield* Deferred.succeed(releaseFirst, undefined);
          assert.include(yield* Deferred.await(switched), "native/next");
          handlerFor(harness.bot)(
            directMessage({ channelId: 303n, author: { id: 33n }, content: "later" }),
          );
          yield* Deferred.await(laterSent);
          assert.deepStrictEqual(seen, ["original", "next"]);
          assert.deepStrictEqual(harness.resolvedRoots, [botRoot, botRoot, botRoot]);
        }),
      ),
  );

  it.effect("rejects malformed, unknown and ambiguous selections before provisioning a DM", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* fixture({
          sendBotMessage: () => Effect.die("a model command must not prompt"),
          availableModels: () =>
            Effect.succeed([
              { provider: "one", id: "shared", name: "First" },
              { provider: "two", id: "shared", name: "Second" },
              { provider: "one/shared", id: "nested", name: "Nested provider" },
              { provider: "one", id: "shared/nested", name: "Nested model" },
            ]),
        });
        for (const options of [
          [],
          modelOptions(""),
          modelOptions("shared"),
          modelOptions("one/missing"),
          modelOptions("one/shared/nested"),
          modelOptions("x".repeat(101)),
        ]) {
          yield* privateCommandReply(
            harness.bot,
            directInteraction({ data: { name: "switch", options } }),
          );
        }
        assert.deepStrictEqual(harness.resolvedRoots, []);
        assert.deepStrictEqual(harness.sent, []);
      }),
    ),
  );

  it.effect(
    "returns empty autocomplete on catalog failure and bounds slow cancellation below Discord's deadline",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const requested = yield* Deferred.make<void>();
          const releaseCleanup = yield* Deferred.make<void>();
          const cleanupFinished = yield* Deferred.make<void>();
          let slow = false;
          const harness = yield* fixture({
            sendBotMessage: () => Effect.die("autocomplete must not prompt"),
            availableModels: () =>
              slow
                ? Deferred.succeed(requested, undefined).pipe(
                    Effect.andThen(Effect.never),
                    Effect.onInterrupt(() =>
                      Deferred.await(releaseCleanup).pipe(
                        Effect.andThen(Deferred.succeed(cleanupFinished, undefined)),
                      ),
                    ),
                  )
                : Effect.fail(
                    new ApplicationError({ reason: "operation", message: "secret-provider" }),
                  ),
          });
          const command = directInteraction({
            data: { name: "switch", options: modelOptions("", true) },
          });
          assert.deepStrictEqual(yield* modelSuggestions(harness.bot, command), []);
          const error = yield* privateCommandReply(
            harness.bot,
            directInteraction({ data: { name: "switch", options: modelOptions("one/model") } }),
          );
          assert.notInclude(error, "secret-provider");
          assert.deepStrictEqual(harness.resolvedRoots, []);
          slow = true;
          const suggestions = yield* modelSuggestions(harness.bot, command).pipe(Effect.forkChild);
          yield* Deferred.await(requested);
          yield* TestClock.adjust("2 seconds");
          assert.deepStrictEqual(yield* Fiber.join(suggestions), []);
          assert.deepStrictEqual(harness.resolvedRoots, []);
          yield* Deferred.succeed(releaseCleanup, undefined);
          yield* Deferred.await(cleanupFinished);
        }),
      ),
  );
  it.effect("keeps model discovery empty and submissions private without bot storage", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* fixture({
          botStorage: false,
          sendBotMessage: () => Effect.die("a model command must not prompt"),
        });
        assert.deepStrictEqual(
          yield* modelSuggestions(
            harness.bot,
            directInteraction({ data: { name: "switch", options: modelOptions("", true) } }),
          ),
          [],
        );
        yield* privateCommandReply(
          harness.bot,
          directInteraction({ data: { name: "switch", options: modelOptions("native/model") } }),
        );
        assert.deepStrictEqual(harness.resolvedRoots, []);
      }),
    ),
  );

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

  it.effect("shares message context across DM commands but keeps their replies separate", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const transcripts = new Map<Chat.ChatId, string>();
        const messageReceived = yield* Deferred.make<void>();
        const harness = yield* fixture({
          sendBotMessage: (id, prompt) =>
            Effect.sync(() => {
              transcripts.set(id, prompt.text);
              Deferred.doneUnsafe(messageReceived, Effect.void);
            }),
          contextUsage: (id) =>
            Effect.sync(() => {
              const tokens = transcripts.get(id)?.length ?? 0;
              return {
                kind: "available",
                contextWindow: 100,
                usedTokens: tokens,
                systemPromptTokens: 0,
                systemToolsTokens: 0,
                systemContextTokens: 0,
                skillsTokens: 0,
                messagesTokens: tokens,
              } satisfies ContextUsage;
            }),
          shake: (id, mode) =>
            Effect.sync(() => {
              assert.strictEqual(mode, "thinking");
              const tokens = transcripts.get(id)?.length ?? 0;
              const dropped = transcripts.delete(id);
              return {
                mode: "thinking",
                thinkingBlocksDropped: dropped ? 1 : 0,
                tokensFreed: tokens,
              } satisfies ShakeResult;
            }),
        });
        handlerFor(harness.bot)(
          directMessage({ channelId: 101n, author: { id: 11n }, content: "remember this" }),
        );
        yield* Deferred.await(messageReceived);
        const readReply = yield* Deferred.make<string>();
        const shakeReply = yield* Deferred.make<string>();
        const rereadReply = yield* Deferred.make<string>();
        const handle = interactionHandlerFor(harness.bot);
        handle(
          directInteraction({
            channelId: 202n,
            user: { id: 22n },
            data: { name: "context" },
            edit: async ({ content }) => {
              Deferred.doneUnsafe(readReply, Effect.succeed(content ?? ""));
            },
          }),
        );
        assert.match(yield* Deferred.await(readReply), /13 \/ 100 tokens/);
        handle(
          directInteraction({
            channelId: 101n,
            user: { id: 11n },
            data: {
              name: "shake",
              options: [
                {
                  name: "mode",
                  type: ApplicationCommandOptionTypes.String,
                  value: "thinking",
                },
              ],
            },
            edit: async ({ content }) => {
              Deferred.doneUnsafe(shakeReply, Effect.succeed(content ?? ""));
            },
          }),
        );
        assert.match(yield* Deferred.await(shakeReply), /Dropped 1 thinking block/);
        handle(
          directInteraction({
            channelId: 202n,
            user: { id: 22n },
            data: { name: "context" },
            edit: async ({ content }) => {
              Deferred.doneUnsafe(rereadReply, Effect.succeed(content ?? ""));
            },
          }),
        );
        assert.match(yield* Deferred.await(rereadReply), /0 \/ 100 tokens/);
        assert.deepStrictEqual(harness.resolvedRoots, [botRoot, botRoot, botRoot, botRoot]);
        assert.deepStrictEqual(harness.sent, []);
        assert.deepStrictEqual(harness.replies, []);
        assert.isTrue(Option.isNone(yield* harness.resolveThreadId(chatId)));
      }),
    ),
  );

  it.effect("acknowledges DM commands before serializing context and shake across senders", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const firstStarted = yield* Deferred.make<void>();
        const releaseFirst = yield* Deferred.make<void>();
        const contextDeferred = yield* Deferred.make<void>();
        const shakeDeferred = yield* Deferred.make<void>();
        const contextStarted = yield* Deferred.make<void>();
        const releaseContext = yield* Deferred.make<void>();
        const editStarted = yield* Deferred.make<void>();
        const releaseEdit = Promise.withResolvers<void>();
        const shakeStarted = yield* Deferred.make<void>();
        const releaseShake = yield* Deferred.make<void>();
        const laterSent = yield* Deferred.make<void>();
        const order: Array<string> = [];
        const harness = yield* fixture({
          sendBotMessage: (_id, prompt) =>
            Effect.gen(function* () {
              order.push(prompt.text);
              if (prompt.text === "first") {
                yield* Deferred.succeed(firstStarted, undefined);
                yield* Deferred.await(releaseFirst);
              } else {
                yield* Deferred.succeed(laterSent, undefined);
              }
            }),
          contextUsage: () =>
            Effect.gen(function* () {
              order.push("context");
              yield* Deferred.succeed(contextStarted, undefined);
              yield* Deferred.await(releaseContext);
              return { kind: "unavailable" } satisfies ContextUsage;
            }),
          shake: () =>
            Effect.gen(function* () {
              order.push("shake");
              yield* Deferred.succeed(shakeStarted, undefined);
              yield* Deferred.await(releaseShake);
              return {
                mode: "elide",
                toolResultsDropped: 0,
                blocksDropped: 0,
                tokensFreed: 0,
              } satisfies ShakeResult;
            }),
        });
        handlerFor(harness.bot)(
          directMessage({ channelId: 101n, author: { id: 11n }, content: "first" }),
        );
        yield* Deferred.await(firstStarted);
        const handle = interactionHandlerFor(harness.bot);
        handle(
          directInteraction({
            channelId: 202n,
            user: { id: 22n },
            data: { name: "context" },
            defer: async () => {
              Deferred.doneUnsafe(contextDeferred, Effect.void);
            },
            edit: async () => {
              order.push("context-edit");
              Deferred.doneUnsafe(editStarted, Effect.void);
              await releaseEdit.promise;
              order.push("context-replied");
            },
          }),
        );
        yield* Deferred.await(contextDeferred);
        yield* Effect.yieldNow;
        handle(
          directInteraction({
            channelId: 303n,
            user: { id: 33n },
            data: { name: "shake" },
            defer: async () => {
              Deferred.doneUnsafe(shakeDeferred, Effect.void);
            },
            edit: async () => {
              order.push("shake-replied");
            },
          }),
        );
        yield* Deferred.await(shakeDeferred);
        yield* Effect.yieldNow;
        assert.deepStrictEqual(order, ["first"]);
        yield* Deferred.succeed(releaseFirst, undefined);
        yield* Deferred.await(contextStarted);
        handlerFor(harness.bot)(
          directMessage({ channelId: 404n, author: { id: 44n }, content: "later" }),
        );
        yield* Effect.yieldNow;
        assert.deepStrictEqual(order, ["first", "context"]);
        yield* Deferred.succeed(releaseContext, undefined);
        yield* Deferred.await(editStarted);
        yield* Effect.yieldNow;
        assert.deepStrictEqual(order, ["first", "context", "context-edit"]);
        releaseEdit.resolve();
        yield* Deferred.await(shakeStarted);
        assert.deepStrictEqual(order, [
          "first",
          "context",
          "context-edit",
          "context-replied",
          "shake",
        ]);
        yield* Deferred.succeed(releaseShake, undefined);
        yield* Deferred.await(laterSent);
        assert.deepStrictEqual(order, [
          "first",
          "context",
          "context-edit",
          "context-replied",
          "shake",
          "shake-replied",
          "later",
        ]);
      }),
    ),
  );

  it.effect("rejects DM commands cleanly when bot storage is not configured", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* fixture({
          botStorage: false,
          sendBotMessage: () => Effect.die("a command must not prompt the bot"),
        });
        const handle = interactionHandlerFor(harness.bot);
        for (const name of ["context", "shake"]) {
          const responded = yield* Deferred.make<string>();
          handle(
            directInteraction({
              data: { name },
              defer: async () => {
                throw new Error("unconfigured DM command must be rejected immediately");
              },
              respond: async ({ content }) => {
                Deferred.doneUnsafe(responded, Effect.succeed(content ?? ""));
              },
            }),
          );
          assert.match(yield* Deferred.await(responded), /bot storage is not configured/);
        }
        assert.deepStrictEqual(harness.resolvedRoots, []);
      }),
    ),
  );

  it.effect("rejects malformed DM shake commands before creating a bot chat", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* fixture({
          sendBotMessage: () => Effect.die("a command must not prompt the bot"),
        });
        const handle = interactionHandlerFor(harness.bot);
        const edited = yield* Deferred.make<string>();
        handle(
          directInteraction({
            data: {
              name: "shake",
              options: [
                { name: "mode", type: ApplicationCommandOptionTypes.String, value: "unknown" },
              ],
            },
            edit: async ({ content }) => {
              Deferred.doneUnsafe(edited, Effect.succeed(content ?? ""));
            },
          }),
        );
        assert.match(yield* Deferred.await(edited), /accepts one mode/);
        assert.deepStrictEqual(harness.resolvedRoots, []);
      }),
    ),
  );

  it.effect("finishes DM command replies when bot chat resolution fails", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* fixture({
          getOrCreateBotChat: () =>
            Effect.fail(
              new ApplicationError({ reason: "operation", message: "private storage path" }),
            ),
          sendBotMessage: () => Effect.die("a command must not prompt the bot"),
        });
        const handle = interactionHandlerFor(harness.bot);
        for (const name of ["context", "shake"]) {
          const edited = yield* Deferred.make<string>();
          handle(
            directInteraction({
              data: { name },
              edit: async ({ content }) => {
                Deferred.doneUnsafe(edited, Effect.succeed(content ?? ""));
              },
            }),
          );
          const response = yield* Deferred.await(edited);
          assert.match(response, /could not/);
          assert.notInclude(response, "private storage path");
        }
        assert.deepStrictEqual(harness.sent, []);
        assert.deepStrictEqual(harness.replies, []);
      }),
    ),
  );

  it.effect(
    "rejects guild-only commands and close confirmations before thread control effects",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const harness = yield* fixture({
            sendBotMessage: () => Effect.die("a command must not prompt the bot"),
          });
          const handle = interactionHandlerFor(harness.bot);
          for (const data of [
            { name: "close" },
            { name: "abort" },
            { name: "bind" },
            { name: "btw" },
            { customId: "pico:close:confirmation" },
          ]) {
            const responded = yield* Deferred.make<string>();
            const command = directInteraction({
              channelId: 202n,
              type:
                "customId" in data
                  ? InteractionTypes.MessageComponent
                  : InteractionTypes.ApplicationCommand,
              data,
              defer: async () => {
                throw new Error("DM command must not enter thread defer flow");
              },
              respond: async (options) => {
                Deferred.doneUnsafe(responded, Effect.succeed(options.content ?? ""));
              },
            });
            handle(command);
            assert.match(yield* Deferred.await(responded), /server channels and threads/);
          }
          assert.deepStrictEqual(harness.resolvedRoots, []);
          assert.deepStrictEqual(harness.sent, []);
        }),
      ),
  );
});
