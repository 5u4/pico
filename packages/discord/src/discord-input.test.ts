import { assert, describe, it } from "@effect/vitest";
import { Application, type BindWorkspace } from "@pico/contract/application";
import * as Chat from "@pico/contract/chat-model";
import { WorkspaceCwdInvalid } from "@pico/contract/errors";
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
