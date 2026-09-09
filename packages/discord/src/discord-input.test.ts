import { assert, describe, it } from "@effect/vitest";
import type { ContextUsage } from "@pico/contract/agent-runtime";
import { Application, type BindWorkspace } from "@pico/contract/application";
import * as Chat from "@pico/contract/chat-model";
import { ApplicationError, WorkspaceCwdInvalid } from "@pico/contract/errors";
import { AbsolutePath } from "@pico/contract/path";
import * as Workspace from "@pico/contract/workspace-model";
import { ApplicationCommandOptionTypes, ChannelTypes, InteractionTypes } from "discordeno";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import {
  type DiscordInputBot,
  type DiscordInteraction,
  type DiscordMessage,
  install,
} from "./discord-input.ts";

const workspaceId = Workspace.WorkspaceId.make("018f47a0-0000-7000-8000-000000000001");
const chatId = Chat.ChatId.make("018f47a0-0000-7000-8000-000000000002");
const failingChatId = Chat.ChatId.make("018f47a0-0000-7000-8000-000000000003");
const defaultCwd = AbsolutePath.make("/tmp/pico-discord-input");
const config = {
  token: Redacted.make("test"),
  allowedGuildIds: ["1"],
  defaultCwd,
} as const;

const message = (overrides: Partial<DiscordMessage> = {}): DiscordMessage => ({
  guildId: 1n,
  author: { id: 100n },
  channelId: 10n,
  id: 11n,
  content: "hello",
  attachments: [],
  ...overrides,
});

const handlerFor = (bot: DiscordInputBot) => {
  const handler = bot.events.messageCreate;
  assert.isFunction(handler);
  if (handler === undefined) throw new Error("Discord input handler was not installed");
  return handler;
};

const bindOptions = (cwd: string) => [
  {
    name: "set",
    type: ApplicationCommandOptionTypes.SubCommand,
    options: [{ name: "cwd", type: ApplicationCommandOptionTypes.String, value: cwd }],
  },
];

const interaction = (overrides: Partial<DiscordInteraction> = {}): DiscordInteraction => ({
  type: InteractionTypes.ApplicationCommand,
  guildId: 1n,
  channelId: 10n,
  data: { name: "bind", options: bindOptions("/repo") },
  defer: async () => undefined,
  edit: async () => undefined,
  ...overrides,
});

const interactionHandlerFor = (bot: DiscordInputBot) => {
  const handler = bot.events.interactionCreate;
  assert.isFunction(handler);
  if (handler === undefined) throw new Error("Discord interaction handler was not installed");
  return handler;
};

describe("Discord input", () => {
  it.effect("owns channel creation, caching, ordering, and the output lookup", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const firstSent = yield* Deferred.make<void>();
        const secondSent = yield* Deferred.make<void>();
        const order: string[] = [];
        const sent: string[] = [];
        let channelReads = 0;
        let threadIdForChat: ((candidate: Chat.ChatId) => bigint | undefined) | undefined;

        const bot = {
          id: 999n,
          events: {},
          helpers: {
            getChannel: async () => {
              channelReads += 1;
              return { id: 10n, type: ChannelTypes.GuildText, name: "general" };
            },
            sendMessage: async () => undefined,
            startThreadWithMessage: async (_channelId, _messageId, options) => {
              order.push("create-thread");
              assert.strictEqual(options.name, "hello from pico");
              assert.strictEqual(options.autoArchiveDuration, 1_440);
              return { id: 20n };
            },
          },
        } satisfies DiscordInputBot;

        const application = Application.of({
          createWorkspace: () =>
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
          createChat: (input) =>
            Effect.sync(() => {
              order.push("create-chat");
              assert.strictEqual(input.workspaceId, workspaceId);
              assert.strictEqual(input.externalId, "20");
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
          transcript: () => Effect.die("unexpected transcript read"),
          sendMessage: (_chatId, content) =>
            Effect.gen(function* () {
              order.push("send");
              sent.push(content);
              assert.strictEqual(threadIdForChat?.(chatId), 20n);
              yield* Deferred.succeed(sent.length === 1 ? firstSent : secondSent, undefined);
            }),
          abort: () => Effect.die("unexpected chat abort"),
          contextUsage: () => Effect.die("unexpected context read"),
          shake: () => Effect.die("unexpected chat shake"),
        });

        threadIdForChat = yield* install(bot, config).pipe(
          Effect.provideService(Application, application),
        );
        const handleMessage = handlerFor(bot);

        handleMessage(message({ content: "  hello   from pico  " }));
        yield* Deferred.await(firstSent);
        assert.deepStrictEqual(order, [
          "find-workspace",
          "create-workspace",
          "create-thread",
          "create-chat",
          "send",
        ]);
        assert.deepStrictEqual(sent, ["  hello   from pico  "]);
        assert.strictEqual(channelReads, 1);
        assert.strictEqual(threadIdForChat(chatId), 20n);

        handleMessage(message({ channelId: 20n, id: 12n, content: "again" }));
        yield* Deferred.await(secondSent);
        assert.deepStrictEqual(sent, ["  hello   from pico  ", "again"]);
        assert.strictEqual(channelReads, 1);
      }),
    ),
  );

  it.effect("filters foreign input and preserves rejection precedence", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let resolveRejection: (() => void) | undefined;
        const rejected = new Promise<void>((resolve) => {
          resolveRejection = resolve;
        });
        const replies: string[] = [];
        const bot = {
          id: 999n,
          events: {},
          helpers: {
            getChannel: async () => ({ id: 10n, type: ChannelTypes.GuildText }),
            sendMessage: async (_channelId, options) => {
              replies.push(options.content);
              resolveRejection?.();
            },
            startThreadWithMessage: async () => ({ id: 20n }),
          },
        } satisfies DiscordInputBot;
        const application = Application.of({
          createWorkspace: () => Effect.die("unexpected workspace creation"),
          bindWorkspace: () => Effect.die("unexpected workspace binding"),
          createChat: () => Effect.die("unexpected chat creation"),
          findWorkspaceByPlatformId: () => Effect.die("unexpected workspace lookup"),
          findChatByPlatformId: () => Effect.die("unexpected chat lookup"),
          transcript: () => Effect.die("unexpected transcript read"),
          sendMessage: () => Effect.die("unexpected message send"),
          abort: () => Effect.die("unexpected chat abort"),
          contextUsage: () => Effect.die("unexpected context read"),
          shake: () => Effect.die("unexpected chat shake"),
        });

        yield* install(bot, config).pipe(Effect.provideService(Application, application));
        const handleMessage = handlerFor(bot);
        handleMessage(message({ guildId: 2n }));
        yield* Effect.yieldNow;
        assert.deepStrictEqual(replies, []);

        handleMessage(message({ content: "   ", attachments: [{}] }));
        yield* Effect.promise(() => rejected);
        assert.deepStrictEqual(replies, [
          "Attachments are not supported yet. Send the request as text.",
        ]);
      }),
    ),
  );

  it.effect("defers and completes bind interactions under guild and channel policy", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const bindings: Array<BindWorkspace> = [];
        let defers = 0;
        let edits = 0;
        const bot = {
          id: 999n,
          events: {},
          helpers: {
            getChannel: async (channelId: bigint) => {
              switch (channelId) {
                case 10n:
                  return {
                    id: channelId,
                    guildId: 1n,
                    type: ChannelTypes.GuildText,
                    name: "general",
                  };
                case 20n:
                  return {
                    id: channelId,
                    guildId: 1n,
                    type: ChannelTypes.PublicThread,
                    parentId: 10n,
                    name: "thread",
                  };
                case 30n:
                  return {
                    id: channelId,
                    guildId: 2n,
                    type: ChannelTypes.GuildText,
                    name: "foreign",
                  };
                default:
                  return {
                    id: channelId,
                    guildId: 1n,
                    type: ChannelTypes.GuildVoice,
                    name: "voice",
                  };
              }
            },
            sendMessage: async () => undefined,
            startThreadWithMessage: async () => ({ id: 50n }),
          },
        } satisfies DiscordInputBot;
        const application = Application.of({
          createWorkspace: () => Effect.die("unexpected workspace creation"),
          bindWorkspace: (input) => {
            bindings.push(input);
            if (input.cwd === "/missing") {
              return Effect.fail(new WorkspaceCwdInvalid({ cwd: input.cwd, reason: "not-found" }));
            }
            return Effect.succeed({
              id: workspaceId,
              name: "general",
              binding: input.binding,
              defaultCwd: AbsolutePath.make(input.cwd),
              worktree: null,
              createdAt: 0,
            });
          },
          createChat: () => Effect.die("unexpected chat creation"),
          findWorkspaceByPlatformId: () => Effect.die("unexpected workspace lookup"),
          findChatByPlatformId: () => Effect.die("unexpected chat lookup"),
          transcript: () => Effect.die("unexpected transcript read"),
          sendMessage: () => Effect.die("unexpected message send"),
          abort: () => Effect.die("unexpected chat abort"),
          contextUsage: () => Effect.die("unexpected context read"),
          shake: () => Effect.die("unexpected chat shake"),
        });

        yield* install(bot, config).pipe(Effect.provideService(Application, application));
        const handleInteraction = interactionHandlerFor(bot);
        const invoke = (
          overrides: Partial<DiscordInteraction> = {},
          omittedId?: "guildId" | "channelId",
        ) =>
          new Promise<string>((resolve) => {
            const candidate = interaction({
              defer: async (isPrivate) => {
                assert.isTrue(isPrivate);
                defers += 1;
              },
              edit: async (options) => {
                assert.deepStrictEqual(options.allowedMentions, {
                  parse: [],
                  repliedUser: false,
                });
                edits += 1;
                resolve(options.content);
              },
              ...overrides,
            });
            if (omittedId !== undefined) Reflect.deleteProperty(candidate, omittedId);
            handleInteraction(candidate);
          });

        const policyCopy = "This command can only be used in a configured server text channel.";
        assert.strictEqual(yield* Effect.promise(() => invoke({}, "guildId")), policyCopy);
        assert.strictEqual(yield* Effect.promise(() => invoke({}, "channelId")), policyCopy);
        assert.strictEqual(yield* Effect.promise(() => invoke({ guildId: 2n })), policyCopy);
        assert.strictEqual(yield* Effect.promise(() => invoke({ channelId: 30n })), policyCopy);
        assert.strictEqual(yield* Effect.promise(() => invoke({ channelId: 20n })), policyCopy);
        assert.strictEqual(yield* Effect.promise(() => invoke({ channelId: 40n })), policyCopy);
        assert.deepStrictEqual(bindings, []);

        assert.strictEqual(
          yield* Effect.promise(() => invoke({ data: { name: "bind", options: [] } })),
          "The /bind set command requires one cwd value.",
        );
        assert.strictEqual(
          yield* Effect.promise(() =>
            invoke({ data: { name: "bind", options: bindOptions("/missing") } }),
          ),
          "That working directory does not exist.",
        );
        assert.strictEqual(
          yield* Effect.promise(() =>
            invoke({ data: { name: "bind", options: bindOptions("/repo") } }),
          ),
          "Workspace binding updated to /repo.",
        );
        assert.deepStrictEqual(bindings, [
          {
            binding: { platform: "discord", externalId: "10" },
            workspaceName: "general",
            cwd: "/missing",
          },
          {
            binding: { platform: "discord", externalId: "10" },
            workspaceName: "general",
            cwd: "/repo",
          },
        ]);
        assert.strictEqual(defers, 9);
        assert.strictEqual(edits, 9);

        let ignoredDefers = 0;
        handleInteraction(
          interaction({
            type: InteractionTypes.Ping,
            defer: async () => {
              ignoredDefers += 1;
            },
          }),
        );
        handleInteraction(
          interaction({
            data: { name: "other", options: bindOptions("/repo") },
            defer: async () => {
              ignoredDefers += 1;
            },
          }),
        );
        assert.strictEqual(ignoredDefers, 0);
      }),
    ),
  );

  it.effect("resolves persisted shake chats and returns private mode-specific responses", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const lookups: Array<[string, string, string]> = [];
        const shakes: Array<[Chat.ChatId, string]> = [];
        let privateDefers = 0;
        const bot = {
          id: 999n,
          events: {},
          helpers: {
            getChannel: async (channelId: bigint) => {
              if (channelId === 10n) {
                return { id: channelId, guildId: 1n, type: ChannelTypes.GuildText };
              }
              if (channelId === 30n) {
                return {
                  id: channelId,
                  guildId: 2n,
                  type: ChannelTypes.PublicThread,
                  parentId: 10n,
                };
              }
              return {
                id: channelId,
                guildId: 1n,
                type: ChannelTypes.PublicThread,
                parentId: 10n,
              };
            },
            sendMessage: async () => {
              throw new Error("shake must not use Discord sendMessage");
            },
            startThreadWithMessage: async () => {
              throw new Error("shake must not create a thread");
            },
          },
        } satisfies DiscordInputBot;
        const chat: Chat.Chat = {
          id: chatId,
          workspaceId,
          cwd: defaultCwd,
          externalId: "20",
          createdAt: 0,
          archivedAt: null,
        };
        const failedChat = { ...chat, id: failingChatId, externalId: "22" };
        const application = Application.of({
          createWorkspace: () => Effect.die("shake must not create a workspace"),
          bindWorkspace: () => Effect.die("unexpected workspace binding"),
          createChat: () => Effect.die("shake must not create a chat"),
          findWorkspaceByPlatformId: () => Effect.die("unexpected workspace lookup"),
          findChatByPlatformId: (platform, parentId, threadId) =>
            Effect.sync(() => {
              lookups.push([platform, parentId, threadId]);
              if (threadId === "20") return Option.some(chat);
              if (threadId === "22") return Option.some(failedChat);
              return Option.none();
            }),
          transcript: () => Effect.die("unexpected transcript read"),
          sendMessage: () => Effect.die("shake must not use application.sendMessage"),
          abort: () => Effect.die("unexpected chat abort"),
          contextUsage: () => Effect.die("unexpected context read"),
          shake: (requestedChatId, mode) => {
            shakes.push([requestedChatId, mode]);
            if (requestedChatId === failingChatId) {
              return Effect.fail(new ApplicationError({ message: "shake failed" }));
            }
            switch (mode) {
              case "elide":
                return Effect.succeed({
                  mode,
                  toolResultsDropped: 2,
                  blocksDropped: 1,
                  tokensFreed: 300,
                });
              case "images":
                return Effect.succeed({ mode, imagesDropped: 4, tokensFreed: 0 });
              case "thinking":
                return Effect.succeed({ mode, thinkingBlocksDropped: 3, tokensFreed: 125 });
              default: {
                const exhaustive: never = mode;
                return exhaustive;
              }
            }
          },
        });

        yield* install(bot, config).pipe(Effect.provideService(Application, application));
        const handleInteraction = interactionHandlerFor(bot);
        const invoke = (
          channelId: bigint,
          options?: NonNullable<DiscordInteraction["data"]>["options"],
        ) =>
          new Promise<string>((resolve) => {
            handleInteraction(
              interaction({
                channelId,
                data: options === undefined ? { name: "shake" } : { name: "shake", options },
                defer: async (isPrivate) => {
                  assert.isTrue(isPrivate);
                  privateDefers += 1;
                },
                edit: async (response) => {
                  assert.deepStrictEqual(response.allowedMentions, {
                    parse: [],
                    repliedUser: false,
                  });
                  resolve(response.content);
                },
              }),
            );
          });

        assert.strictEqual(
          yield* Effect.promise(() => invoke(20n)),
          "Shook 2 tool results + 1 block (~300 tokens freed).",
        );
        assert.strictEqual(
          yield* Effect.promise(() =>
            invoke(20n, [
              { name: "mode", type: ApplicationCommandOptionTypes.String, value: "images" },
            ]),
          ),
          "Dropped 4 images from this chat.",
        );
        assert.strictEqual(
          yield* Effect.promise(() =>
            invoke(20n, [
              { name: "mode", type: ApplicationCommandOptionTypes.String, value: "thinking" },
            ]),
          ),
          "Dropped 3 thinking blocks from this chat.",
        );
        assert.deepStrictEqual(lookups, [["discord", "10", "20"]]);
        assert.deepStrictEqual(shakes, [
          [chatId, "elide"],
          [chatId, "images"],
          [chatId, "thinking"],
        ]);

        const policyCopy = "This command can only be used in a pico-owned Discord thread.";
        assert.strictEqual(yield* Effect.promise(() => invoke(10n)), policyCopy);
        assert.strictEqual(yield* Effect.promise(() => invoke(21n)), policyCopy);
        assert.strictEqual(yield* Effect.promise(() => invoke(30n)), policyCopy);
        assert.strictEqual(
          yield* Effect.promise(() =>
            invoke(20n, [
              { name: "mode", type: ApplicationCommandOptionTypes.Integer, value: "elide" },
            ]),
          ),
          "The /shake command accepts one mode: elide, images, or thinking.",
        );
        assert.strictEqual(
          yield* Effect.promise(() => invoke(22n)),
          "pico could not shake this chat.",
        );
        assert.strictEqual(privateDefers, 8);
        assert.deepStrictEqual(shakes, [
          [chatId, "elide"],
          [chatId, "images"],
          [chatId, "thinking"],
          [failingChatId, "elide"],
        ]);
      }),
    ),
  );

  it.effect("reads persisted context privately and caches the resolved chat", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const unavailableChatId = Chat.ChatId.make("018f47a0-0000-7000-8000-000000000004");
        const lookups: Array<[string, string, string]> = [];
        const contextReads: Array<Chat.ChatId> = [];
        let privateDefers = 0;
        const bot = {
          id: 999n,
          events: {},
          helpers: {
            getChannel: async (channelId: bigint) => {
              if (channelId === 10n) {
                return { id: channelId, guildId: 1n, type: ChannelTypes.GuildText };
              }
              if (channelId === 30n) {
                return {
                  id: channelId,
                  guildId: 2n,
                  type: ChannelTypes.PublicThread,
                  parentId: 10n,
                };
              }
              if (channelId === 31n) {
                return { id: channelId, guildId: 1n, type: ChannelTypes.PublicThread };
              }
              return {
                id: channelId,
                guildId: 1n,
                type: ChannelTypes.PublicThread,
                parentId: 10n,
              };
            },
            sendMessage: async () => {
              throw new Error("context must not use Discord sendMessage");
            },
            startThreadWithMessage: async () => {
              throw new Error("context must not create a thread");
            },
          },
        } satisfies DiscordInputBot;
        const chat = (id: Chat.ChatId, externalId: string): Chat.Chat => ({
          id,
          workspaceId,
          cwd: defaultCwd,
          externalId,
          createdAt: 0,
          archivedAt: null,
        });
        const application = Application.of({
          createWorkspace: () => Effect.die("context must not create a workspace"),
          bindWorkspace: () => Effect.die("unexpected workspace binding"),
          createChat: () => Effect.die("context must not create a chat"),
          findWorkspaceByPlatformId: () => Effect.die("unexpected workspace lookup"),
          findChatByPlatformId: (platform, parentId, threadId) =>
            Effect.sync(() => {
              lookups.push([platform, parentId, threadId]);
              if (threadId === "20") return Option.some(chat(chatId, threadId));
              if (threadId === "22") return Option.some(chat(failingChatId, threadId));
              if (threadId === "23") return Option.some(chat(unavailableChatId, threadId));
              return Option.none();
            }),
          transcript: () => Effect.die("unexpected transcript read"),
          sendMessage: () => Effect.die("context must not use application.sendMessage"),
          abort: () => Effect.die("unexpected chat abort"),
          contextUsage: (requestedChatId) => {
            contextReads.push(requestedChatId);
            if (requestedChatId === failingChatId) {
              return Effect.fail(new ApplicationError({ message: "context failed" }));
            }
            if (requestedChatId === unavailableChatId) {
              return Effect.succeed<ContextUsage>({ kind: "unavailable" });
            }
            return Effect.succeed<ContextUsage>({
              kind: "available",
              contextWindow: 200_000,
              usedTokens: 12_345,
              systemPromptTokens: 1_000,
              systemToolsTokens: 0,
              systemContextTokens: 3_000,
              skillsTokens: 0,
              messagesTokens: 8_345,
            });
          },
          shake: () => Effect.die("unexpected chat shake"),
        });

        yield* install(bot, config).pipe(Effect.provideService(Application, application));
        const handleInteraction = interactionHandlerFor(bot);
        const invoke = (channelId: bigint, guildId = 1n) =>
          new Promise<string>((resolve) => {
            handleInteraction(
              interaction({
                guildId,
                channelId,
                data: { name: "context" },
                defer: async (isPrivate) => {
                  assert.isTrue(isPrivate);
                  privateDefers += 1;
                },
                edit: async (response) => {
                  assert.deepStrictEqual(response.allowedMentions, {
                    parse: [],
                    repliedUser: false,
                  });
                  resolve(response.content);
                },
              }),
            );
          });

        const availableCopy = [
          "Context: 12,345 / 200,000 tokens (6% used)",
          "System prompt: 1,000 tokens",
          "System context: 3,000 tokens",
          "Messages: 8,345 tokens",
        ].join("\n");
        const firstAvailable = yield* Effect.promise(() => invoke(20n));
        assert.strictEqual(firstAvailable, availableCopy);
        assert.isBelow(firstAvailable.length, 2_000);
        assert.strictEqual(yield* Effect.promise(() => invoke(20n)), availableCopy);
        assert.strictEqual(
          yield* Effect.promise(() => invoke(23n)),
          "Context usage is unavailable for this chat.",
        );

        const policyCopy = "This command can only be used in a pico-owned Discord thread.";
        assert.strictEqual(yield* Effect.promise(() => invoke(10n)), policyCopy);
        assert.strictEqual(yield* Effect.promise(() => invoke(21n)), policyCopy);
        assert.strictEqual(yield* Effect.promise(() => invoke(30n)), policyCopy);
        assert.strictEqual(yield* Effect.promise(() => invoke(31n)), policyCopy);
        assert.strictEqual(yield* Effect.promise(() => invoke(20n, 2n)), policyCopy);
        assert.strictEqual(
          yield* Effect.promise(() => invoke(22n)),
          "pico could not read this chat's context.",
        );
        assert.deepStrictEqual(lookups, [
          ["discord", "10", "20"],
          ["discord", "10", "23"],
          ["discord", "10", "21"],
          ["discord", "10", "22"],
        ]);
        assert.deepStrictEqual(contextReads, [chatId, chatId, unavailableChatId, failingChatId]);
        assert.strictEqual(privateDefers, 9);
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
            getChannel: async () => ({
              id: 20n,
              guildId: 1n,
              type: ChannelTypes.PublicThread,
              parentId: 10n,
            }),
            sendMessage: async () => undefined,
            startThreadWithMessage: async () => {
              throw new Error("unexpected thread creation");
            },
          },
        } satisfies DiscordInputBot;
        const application = Application.of({
          createWorkspace: () => Effect.die("unexpected workspace creation"),
          bindWorkspace: () => Effect.die("unexpected workspace binding"),
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
          transcript: () => Effect.die("unexpected transcript read"),
          sendMessage: () =>
            Effect.gen(function* () {
              order.push("message");
              yield* Deferred.succeed(messageSent, undefined);
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
        });

        yield* install(bot, config).pipe(Effect.provideService(Application, application));
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
            getChannel: async () => ({
              id: 20n,
              guildId: 1n,
              type: ChannelTypes.PublicThread,
              parentId: 10n,
            }),
            sendMessage: async () => undefined,
            startThreadWithMessage: async () => {
              throw new Error("unexpected thread creation");
            },
          },
        } satisfies DiscordInputBot;
        const application = Application.of({
          createWorkspace: () => Effect.die("unexpected workspace creation"),
          bindWorkspace: () => Effect.die("unexpected workspace binding"),
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
          transcript: () => Effect.die("unexpected transcript read"),
          sendMessage: () =>
            Effect.gen(function* () {
              order.push("message");
              yield* Deferred.succeed(messageSent, undefined);
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
        });

        yield* install(bot, config).pipe(Effect.provideService(Application, application));
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

  it.effect("shares the channel lock and refreshes the workspace cache after bind", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const bindStarted = yield* Deferred.make<void>();
        const releaseBind = yield* Deferred.make<void>();
        const messageSent = yield* Deferred.make<void>();
        const order: Array<string> = [];
        let resolveEdit: (() => void) | undefined;
        const edited = new Promise<void>((resolve) => {
          resolveEdit = resolve;
        });
        const bot = {
          id: 999n,
          events: {},
          helpers: {
            getChannel: async () => ({
              id: 10n,
              guildId: 1n,
              type: ChannelTypes.GuildText,
              name: "general",
            }),
            sendMessage: async () => undefined,
            startThreadWithMessage: async () => {
              order.push("create-thread");
              return { id: 20n };
            },
          },
        } satisfies DiscordInputBot;
        const application = Application.of({
          createWorkspace: () => Effect.die("bind cache must prevent workspace creation"),
          bindWorkspace: (input) =>
            Effect.gen(function* () {
              order.push("bind-start");
              yield* Deferred.succeed(bindStarted, undefined);
              yield* Deferred.await(releaseBind);
              order.push("bind-end");
              return {
                id: workspaceId,
                name: "general",
                binding: input.binding,
                defaultCwd,
                worktree: null,
                createdAt: 0,
              };
            }),
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
          findWorkspaceByPlatformId: () => Effect.die("bind cache must prevent workspace lookup"),
          findChatByPlatformId: () => Effect.die("unexpected chat lookup"),
          transcript: () => Effect.die("unexpected transcript read"),
          sendMessage: () =>
            Effect.gen(function* () {
              order.push("send");
              yield* Deferred.succeed(messageSent, undefined);
            }),
          abort: () => Effect.die("unexpected chat abort"),
          contextUsage: () => Effect.die("unexpected context read"),
          shake: () => Effect.die("unexpected chat shake"),
        });

        yield* install(bot, config).pipe(Effect.provideService(Application, application));
        const handleInteraction = interactionHandlerFor(bot);
        const handleMessage = handlerFor(bot);
        handleInteraction(
          interaction({
            defer: async () => undefined,
            edit: async () => {
              order.push("edit");
              resolveEdit?.();
            },
          }),
        );
        yield* Deferred.await(bindStarted);

        handleMessage(message());
        yield* Effect.yieldNow;
        assert.deepStrictEqual(order, ["bind-start"]);

        yield* Deferred.succeed(releaseBind, undefined);
        yield* Effect.promise(() => edited);
        yield* Deferred.await(messageSent);
        assert.deepStrictEqual(order, [
          "bind-start",
          "bind-end",
          "edit",
          "create-thread",
          "create-chat",
          "send",
        ]);
      }),
    ),
  );
});
