import { assert, describe, it } from "@effect/vitest";
import { Application } from "@pico/contract/application";
import * as Chat from "@pico/contract/chat-model";
import { AbsolutePath } from "@pico/contract/path";
import * as Workspace from "@pico/contract/workspace-model";
import { ChannelTypes } from "discordeno";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import { type DiscordInputBot, type DiscordMessage, install } from "./discord-input.ts";

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
});
