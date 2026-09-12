import * as BunCrypto from "@effect/platform-bun/BunCrypto";
import { assert, describe, it } from "@effect/vitest";
import type { AgentEventEnvelope } from "@pico/contract/agent-event";
import * as AgentMessage from "@pico/contract/agent-message";
import type { ContextUsage } from "@pico/contract/agent-runtime";
import { Application, type BindWorkspace } from "@pico/contract/application";
import * as Chat from "@pico/contract/chat-model";
import { ApplicationError, ChatClosed, WorkspaceBindingInvalid } from "@pico/contract/errors";
import { EventRouter } from "@pico/contract/event-router";
import { AbsolutePath } from "@pico/contract/path";
import * as Workspace from "@pico/contract/workspace-model";
import {
  ApplicationCommandOptionTypes,
  ButtonStyles,
  ChannelTypes,
  InteractionTypes,
  MessageComponentTypes,
} from "discordeno";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import {
  type DiscordInputBot,
  type DiscordInteraction,
  type DiscordMessage,
  install,
} from "./discord-input.ts";
import * as DiscordOutput from "./discord-output.ts";
import { pumpOutput } from "./layer.ts";

const workspaceId = Workspace.WorkspaceId.make("018f47a0-0000-7000-8000-000000000001");
const chatId = Chat.ChatId.make("018f47a0-0000-7000-8000-000000000002");
const failingChatId = Chat.ChatId.make("018f47a0-0000-7000-8000-000000000003");
const defaultCwd = AbsolutePath.make("/tmp/pico-discord-input");
const config = {
  token: Redacted.make("test"),
  allowedGuildIds: ["1"],
  defaultCwd,
  showToolCalls: false,
  showThinking: false,
} as const;

const pngBytes = Uint8Array.from(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  ),
);
const gifBytes = Uint8Array.from(
  Buffer.from("R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==", "base64"),
);
const jpegBytes = Uint8Array.from(
  Buffer.from(
    "/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABBQJ//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAwEBPwF//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAgEBPwF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQAGPwJ//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPyF//9oADAMBAAIAAwAAABD/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAEDAQE/EB//xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAECAQE/EB//xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAE/EB//2Q==",
    "base64",
  ),
);
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

const worktreeOptions = (repository: string, branch: string, prefix: string) => [
  {
    name: "worktree",
    type: ApplicationCommandOptionTypes.SubCommand,
    options: [
      { name: "prefix", type: ApplicationCommandOptionTypes.String, value: prefix },
      { name: "repository", type: ApplicationCommandOptionTypes.String, value: repository },
      { name: "branch", type: ApplicationCommandOptionTypes.String, value: branch },
    ],
  },
];

const interaction = (overrides: Partial<DiscordInteraction> = {}): DiscordInteraction => ({
  type: InteractionTypes.ApplicationCommand,
  guildId: 1n,
  channelId: 10n,
  user: { id: 100n },
  data: { name: "bind", options: bindOptions("/repo") },
  defer: async () => undefined,
  deferEdit: async () => undefined,
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
        const sent: AgentMessage.AgentPrompt[] = [];
        let channelReads = 0;
        let resolveThreadId:
          | ((candidate: Chat.ChatId) => Effect.Effect<Option.Option<bigint>, unknown>)
          | undefined;

        const bot = {
          id: 999n,
          events: {},
          helpers: {
            getChannel: async () => {
              channelReads += 1;
              return { id: 10n, type: ChannelTypes.GuildText, name: "general" };
            },
            sendMessage: async () => undefined,
            editChannel: async () => undefined,
            startThreadWithMessage: async (_channelId, _messageId, options) => {
              order.push("create-thread");
              assert.strictEqual(options.name, "hello from pico");
              assert.strictEqual(options.autoArchiveDuration, 1_440);
              return { id: 20n };
            },
          },
        } satisfies DiscordInputBot;

        const application = Application.of({
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
        assert.deepStrictEqual(order, [
          "find-workspace",
          "create-workspace",
          "create-thread",
          "create-chat",
          "send",
        ]);
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

  it.effect("downloads ordered images before creating image-only and mixed chats", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const firstSent = yield* Deferred.make<void>();
        const secondSent = yield* Deferred.make<void>();
        const prompts: AgentMessage.AgentPrompt[] = [];
        const fetched: string[] = [];
        const threadNames: string[] = [];
        const png = pngBytes;
        const gif = gifBytes;
        const jpeg = jpegBytes;
        const bodies = new Map([
          ["https://cdn.discordapp.com/first", png],
          ["https://cdn.discordapp.com/second", gif],
          ["https://cdn.discordapp.com/third", jpeg],
        ]);
        const httpClient = HttpClient.make((request, url) => {
          const key = url.toString();
          fetched.push(key);
          const body = bodies.get(key);
          return Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              body === undefined
                ? new Response(null, { status: 404 })
                : new Response(Buffer.from(body)),
            ),
          );
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
            editChannel: async () => undefined,
            startThreadWithMessage: async (_channelId, _messageId, options) => {
              threadNames.push(options.name);
              return { id: 20n };
            },
          },
        } satisfies DiscordInputBot;
        const application = Application.of({
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
          createChat: () =>
            Effect.succeed({
              id: chatId,
              workspaceId,
              cwd: defaultCwd,
              externalId: "20",
              createdAt: 0,
              archivedAt: null,
            }),
          findWorkspaceByPlatformId: () => Effect.succeed(Option.none()),
          findChatByPlatformId: () => Effect.die("unexpected chat lookup"),
          findChatPlatformBinding: () => Effect.die("unexpected chat binding lookup"),
          transcript: () => Effect.die("unexpected transcript read"),
          sendMessage: (_chatId, prompt) =>
            Effect.gen(function* () {
              prompts.push(prompt);
              yield* Deferred.succeed(prompts.length === 1 ? firstSent : secondSent, undefined);
            }),
          abort: () => Effect.die("unexpected chat abort"),
          contextUsage: () => Effect.die("unexpected context read"),
          shake: () => Effect.die("unexpected chat shake"),
          closeChat: () => Effect.die("unexpected chat close"),
        });

        yield* install(bot, config, () => Effect.void, httpClient).pipe(
          Effect.provideService(Application, application),
          Effect.provide(BunCrypto.layer),
        );
        const handleMessage = handlerFor(bot);
        handleMessage(
          message({
            content: "",
            attachments: [
              {
                filename: " ../first.png\n",
                contentType: "text/plain",
                size: png.byteLength,
                url: "https://cdn.discordapp.com/first",
              },
              {
                filename: "second.gif",
                contentType: "image/png",
                size: gif.byteLength,
                url: "https://cdn.discordapp.com/second",
              },
            ],
          }),
        );
        yield* Deferred.await(firstSent);
        assert.deepStrictEqual(prompts[0], {
          text: "",
          attachments: [
            {
              type: "image",
              name: ".._first.png",
              data: Buffer.from(png).toString("base64"),
              mimeType: "image/png",
            },
            {
              type: "image",
              name: "second.gif",
              data: Buffer.from(gif).toString("base64"),
              mimeType: "image/gif",
            },
          ],
        });
        assert.deepStrictEqual(threadNames, [".._first.png"]);

        handleMessage(
          message({
            channelId: 20n,
            id: 12n,
            content: "inspect this",
            attachments: [
              {
                filename: "third.jpg",
                size: jpeg.byteLength,
                url: "https://cdn.discordapp.com/third",
              },
            ],
          }),
        );
        yield* Deferred.await(secondSent);
        assert.deepStrictEqual(prompts[1], {
          text: "inspect this",
          attachments: [
            {
              type: "image",
              name: "third.jpg",
              data: Buffer.from(jpeg).toString("base64"),
              mimeType: "image/jpeg",
            },
          ],
        });
        assert.deepStrictEqual(fetched, [
          "https://cdn.discordapp.com/first",
          "https://cdn.discordapp.com/second",
          "https://cdn.discordapp.com/third",
        ]);
        assert.deepStrictEqual(threadNames, [".._first.png"]);
      }),
    ),
  );

  it.effect("delivers persisted Discord output with cold caches", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let bindingLookups = 0;
        const delivered = yield* Deferred.make<void>();
        const sent: Array<{ readonly threadId: bigint; readonly content: string }> = [];
        const bot = {
          id: 999n,
          events: {},
          helpers: {
            getChannel: async () => {
              throw new Error("cold output must not inspect Discord channels");
            },
            sendMessage: async () => undefined,
            editChannel: async () => undefined,
            startThreadWithMessage: async () => {
              throw new Error("cold output must not create Discord threads");
            },
          },
        } satisfies DiscordInputBot;
        const application = Application.of({
          createWorkspace: () => Effect.die("unexpected explicit workspace creation"),
          getOrCreateWorkspaceByBinding: () => Effect.die("unexpected workspace creation"),
          bindWorkspace: () => Effect.die("unexpected workspace binding"),
          createChat: () => Effect.die("unexpected chat creation"),
          findWorkspaceByPlatformId: () => Effect.die("unexpected workspace lookup"),
          findChatByPlatformId: () => Effect.die("unexpected chat lookup"),
          findChatPlatformBinding: (requestedChatId) =>
            Effect.sync(() => {
              bindingLookups += 1;
              return Option.some({
                platform: "discord",
                externalId: requestedChatId === chatId ? "20" : "not-a-thread",
              });
            }),
          transcript: () => Effect.die("unexpected transcript read"),
          sendMessage: () => Effect.die("unexpected message send"),
          abort: () => Effect.die("unexpected chat abort"),
          contextUsage: () => Effect.die("unexpected context read"),
          shake: () => Effect.die("unexpected chat shake"),
          closeChat: () => Effect.die("unexpected chat close"),
        });
        const resolveThreadId = yield* install(bot, config).pipe(
          Effect.provideService(Application, application),
          Effect.provide(BunCrypto.layer),
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
      }),
    ),
  );

  it.effect("rejects invalid image batches before resolving or creating a chat", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const replies: string[] = [];
        const logs: Array<ReturnType<typeof Logger.formatStructured.log>> = [];
        const logger = Logger.make((options) => {
          logs.push(Logger.formatStructured.log(options));
        });
        let resolveReply: ((reply: string) => void) | undefined;
        let fetchCount = 0;
        const png = pngBytes;
        const httpClient = HttpClient.make((request, url) => {
          fetchCount += 1;
          if (url.pathname.endsWith("/timeout")) return Effect.never;
          let response: Response;
          if (url.pathname.endsWith("/valid")) {
            response = new Response(Buffer.from(png));
          } else if (url.pathname.endsWith("/unsupported")) {
            response = new Response("not an image");
          } else if (url.pathname.endsWith("/streamed-oversize")) {
            response = new Response(
              new ReadableStream<Uint8Array>({
                start(controller) {
                  controller.enqueue(png);
                  controller.enqueue(new Uint8Array(20 * 1024 * 1024));
                  controller.close();
                },
              }),
            );
          } else if (url.pathname.endsWith("/body-failure")) {
            response = new Response(
              new ReadableStream({
                start(controller) {
                  controller.error(new Error("private attachment body"));
                },
              }),
            );
          } else {
            response = new Response(null, { status: 500 });
          }
          return Effect.succeed(HttpClientResponse.fromWeb(request, response));
        });
        const bot = {
          id: 999n,
          events: {},
          helpers: {
            getChannel: async () => ({
              id: 10n,
              guildId: 1n,
              type: ChannelTypes.GuildText,
            }),
            sendMessage: async (_channelId, options) => {
              replies.push(options.content);
              resolveReply?.(options.content);
            },
            editChannel: async () => undefined,
            startThreadWithMessage: async () => {
              throw new Error("rejected input must not create a thread");
            },
          },
        } satisfies DiscordInputBot;
        const application = Application.of({
          createWorkspace: () => Effect.die("unexpected explicit workspace creation"),
          getOrCreateWorkspaceByBinding: () => Effect.die("unexpected workspace creation"),
          bindWorkspace: () => Effect.die("unexpected workspace binding"),
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

        yield* install(bot, config, () => Effect.void, httpClient).pipe(
          Effect.provideService(Application, application),
          Effect.provide(BunCrypto.layer),
          Effect.provide(Logger.layer([logger])),
        );
        const handleMessage = handlerFor(bot);
        handleMessage(message({ guildId: 2n }));
        yield* Effect.yieldNow;
        assert.deepStrictEqual(replies, []);

        const invoke = (overrides: Partial<DiscordMessage>) =>
          new Promise<string>((resolve) => {
            resolveReply = resolve;
            handleMessage(message(overrides));
          });
        const policy =
          "Attach up to 10 PNG, JPEG, GIF, or WebP images. Each image must be 20 MiB or smaller, with 40 MiB total.";
        const download = "I couldn't read every image attachment. Try sending the message again.";
        const image = (url: string, size = png.byteLength) => ({
          filename: "image.png",
          size,
          url,
        });

        assert.strictEqual(
          yield* Effect.promise(() => invoke({ content: "   ", attachments: [] })),
          "Send text or an image to start or continue a chat.",
        );
        assert.strictEqual(
          yield* Effect.promise(() =>
            invoke({
              attachments: Array.from({ length: 11 }, () =>
                image("https://cdn.discordapp.com/unsupported"),
              ),
            }),
          ),
          policy,
        );
        assert.strictEqual(
          yield* Effect.promise(() =>
            invoke({
              attachments: [image("https://cdn.discordapp.com/unsupported", 20 * 1024 * 1024 + 1)],
            }),
          ),
          policy,
        );
        assert.strictEqual(
          yield* Effect.promise(() =>
            invoke({ attachments: [image("http://cdn.discordapp.com/unsupported")] }),
          ),
          download,
        );
        assert.strictEqual(
          yield* Effect.promise(() =>
            invoke({ attachments: [image("https://example.com/unsupported")] }),
          ),
          download,
        );
        assert.strictEqual(
          yield* Effect.promise(() =>
            invoke({
              attachments: [
                image("https://cdn.discordapp.com/valid"),
                image("https://cdn.discordapp.com/unsupported"),
              ],
            }),
          ),
          policy,
        );
        assert.strictEqual(
          yield* Effect.promise(() =>
            invoke({ attachments: [image("https://cdn.discordapp.com/streamed-oversize")] }),
          ),
          policy,
        );
        assert.deepStrictEqual(logs, []);
        assert.strictEqual(
          yield* Effect.promise(() =>
            invoke({ attachments: [image("https://cdn.discordapp.com/failed")] }),
          ),
          download,
        );
        assert.strictEqual(fetchCount, 4);
        assert.strictEqual(logs.length, 1);
        assert.strictEqual(logs[0]?.annotations.reason, "http");
        assert.strictEqual(logs[0]?.annotations.channelId, "10");
        assert.strictEqual(logs[0]?.annotations.messageId, "11");
        yield* Effect.promise(() =>
          invoke({
            attachments: [image("https://cdn.discordapp.com/body-failure")],
          }),
        );
        assert.strictEqual(logs.length, 2);
        assert.strictEqual(logs[1]?.annotations.reason, "body");
        const timeoutReply = invoke({ attachments: [image("https://cdn.discordapp.com/timeout")] });
        yield* TestClock.adjust("15 seconds");
        yield* Effect.promise(() => timeoutReply);
        assert.strictEqual(logs.length, 3);
        assert.strictEqual(logs[2]?.annotations.reason, "timeout");
        assert.notInclude(JSON.stringify(logs), "private attachment body");
        assert.notInclude(JSON.stringify(logs), "cdn.discordapp.com");
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
            editChannel: async () => undefined,
            startThreadWithMessage: async () => ({ id: 50n }),
          },
        } satisfies DiscordInputBot;
        const application = Application.of({
          createWorkspace: () => Effect.die("unexpected explicit workspace creation"),
          getOrCreateWorkspaceByBinding: () => Effect.die("unexpected workspace creation"),
          bindWorkspace: (input) => {
            bindings.push(input);
            if (input.configuration.kind === "direct") {
              if (input.configuration.cwd === "/missing") {
                return Effect.fail(
                  new WorkspaceBindingInvalid({ issue: { field: "cwd", reason: "not-found" } }),
                );
              }
              return Effect.succeed({
                id: workspaceId,
                name: "general",
                binding: input.binding,
                defaultCwd: AbsolutePath.make(input.configuration.cwd),
                worktree: null,
                createdAt: 0,
              });
            }
            if (input.configuration.repository === "/not-git") {
              return Effect.fail(
                new WorkspaceBindingInvalid({
                  issue: { field: "repository", reason: "not-repository" },
                }),
              );
            }
            if (input.configuration.settings.branch === "missing") {
              return Effect.fail(
                new WorkspaceBindingInvalid({ issue: { field: "branch", reason: "not-commit" } }),
              );
            }
            if (input.configuration.settings.prefix === "bad") {
              return Effect.fail(
                new WorkspaceBindingInvalid({ issue: { field: "prefix", reason: "invalid-ref" } }),
              );
            }
            return Effect.succeed({
              id: workspaceId,
              name: "general",
              binding: input.binding,
              defaultCwd: AbsolutePath.make(input.configuration.repository),
              worktree: input.configuration.settings,
              createdAt: 0,
            });
          },
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
                resolve(options.content ?? "");
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
          "Use /bind set with cwd, or /bind worktree with repository, branch, and prefix.",
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
          "Workspace binding updated to /repo. Worktrees are disabled for new chats.",
        );
        assert.strictEqual(
          yield* Effect.promise(() =>
            invoke({
              data: { name: "bind", options: worktreeOptions("/not-git", "main", "chat/") },
            }),
          ),
          "That path is not a Git repository.",
        );
        assert.strictEqual(
          yield* Effect.promise(() =>
            invoke({
              data: { name: "bind", options: worktreeOptions("/repo", "missing", "chat/") },
            }),
          ),
          "The branch must resolve to a commit in that repository.",
        );
        assert.strictEqual(
          yield* Effect.promise(() =>
            invoke({
              data: { name: "bind", options: worktreeOptions("/repo", "main", "bad") },
            }),
          ),
          "The prefix cannot form valid Git branch names.",
        );
        assert.strictEqual(
          yield* Effect.promise(() =>
            invoke({
              data: { name: "bind", options: worktreeOptions("/repo", "main", "chat/") },
            }),
          ),
          "Workspace worktrees configured from /repo. This affects new chats only.",
        );
        assert.deepStrictEqual(bindings, [
          {
            binding: { platform: "discord", externalId: "10" },
            workspaceName: "general",
            configuration: { kind: "direct", cwd: "/missing" },
          },
          {
            binding: { platform: "discord", externalId: "10" },
            workspaceName: "general",
            configuration: { kind: "direct", cwd: "/repo" },
          },
          ...[
            { repository: "/not-git", branch: "main", prefix: "chat/" },
            { repository: "/repo", branch: "missing", prefix: "chat/" },
            { repository: "/repo", branch: "main", prefix: "bad" },
            { repository: "/repo", branch: "main", prefix: "chat/" },
          ].map(({ repository, branch, prefix }) => ({
            binding: { platform: "discord" as const, externalId: "10" },
            workspaceName: "general",
            configuration: {
              kind: "worktree" as const,
              repository,
              settings: { branch, prefix },
            },
          })),
        ]);
        assert.strictEqual(defers, 13);
        assert.strictEqual(edits, 13);

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
            editChannel: async () => undefined,
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
          createWorkspace: () => Effect.die("unexpected explicit workspace creation"),
          getOrCreateWorkspaceByBinding: () => Effect.die("shake must not create a workspace"),
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
          findChatPlatformBinding: () => Effect.die("unexpected chat binding lookup"),
          transcript: () => Effect.die("unexpected transcript read"),
          sendMessage: () => Effect.die("shake must not use application.sendMessage"),
          abort: () => Effect.die("unexpected chat abort"),
          contextUsage: () => Effect.die("unexpected context read"),
          shake: (requestedChatId, mode) => {
            shakes.push([requestedChatId, mode]);
            if (requestedChatId === failingChatId) {
              return Effect.fail(
                new ApplicationError({ reason: "operation", message: "shake failed" }),
              );
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
          closeChat: () => Effect.die("unexpected chat close"),
        });

        yield* install(bot, config).pipe(
          Effect.provideService(Application, application),
          Effect.provide(BunCrypto.layer),
        );
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
                  resolve(response.content ?? "");
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
            editChannel: async () => undefined,
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
          createWorkspace: () => Effect.die("unexpected explicit workspace creation"),
          getOrCreateWorkspaceByBinding: () => Effect.die("context must not create a workspace"),
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
          findChatPlatformBinding: () => Effect.die("unexpected chat binding lookup"),
          transcript: () => Effect.die("unexpected transcript read"),
          sendMessage: () => Effect.die("context must not use application.sendMessage"),
          abort: () => Effect.die("unexpected chat abort"),
          contextUsage: (requestedChatId) => {
            contextReads.push(requestedChatId);
            if (requestedChatId === failingChatId) {
              return Effect.fail(
                new ApplicationError({ reason: "operation", message: "context failed" }),
              );
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
          closeChat: () => Effect.die("unexpected chat close"),
        });

        yield* install(bot, config).pipe(
          Effect.provideService(Application, application),
          Effect.provide(BunCrypto.layer),
        );
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
                  resolve(response.content ?? "");
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
          createWorkspace: () => Effect.die("unexpected workspace creation"),
          getOrCreateWorkspaceByBinding: () => Effect.die("unexpected workspace creation"),
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
            }),
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

  it.effect("rejects unbound aborts and replies privately without exposing failures", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const secret = "private-abort-error";
        const logs: Array<ReturnType<typeof Logger.formatStructured.log>> = [];
        const logger = Logger.make((options) => {
          logs.push(Logger.formatStructured.log(options));
        });
        let aborts = 0;
        const bot = {
          id: 999n,
          events: {},
          helpers: {
            getChannel: async (channelId: bigint) => {
              if (channelId === 32n) throw { status: 503, body: secret };
              return {
                id: channelId,
                guildId: channelId === 30n ? 2n : 1n,
                type: channelId === 10n ? ChannelTypes.GuildText : ChannelTypes.PublicThread,
                ...(channelId === 31n ? {} : { parentId: 10n }),
              };
            },
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
          createWorkspace: () => Effect.die("unexpected workspace creation"),
          getOrCreateWorkspaceByBinding: () => Effect.die("unexpected workspace creation"),
          bindWorkspace: () => Effect.die("unexpected workspace binding"),
          createChat: () => Effect.die("unexpected chat creation"),
          findWorkspaceByPlatformId: () => Effect.die("unexpected workspace lookup"),
          findChatByPlatformId: (_platform, _parentId, threadId) =>
            Effect.succeed(
              threadId === "21"
                ? Option.none()
                : Option.some({
                    id: threadId === "22" ? failingChatId : chatId,
                    workspaceId,
                    cwd: defaultCwd,
                    externalId: threadId,
                    createdAt: 0,
                    archivedAt: null,
                  }),
            ),
          findChatPlatformBinding: () => Effect.die("unexpected binding lookup"),
          transcript: () => Effect.die("unexpected transcript read"),
          sendMessage: () => Effect.die("unexpected message send"),
          abort: (id) =>
            id === failingChatId
              ? Effect.fail(
                  new ApplicationError({ reason: "operation", message: "Failed to abort chat" }),
                )
              : Effect.sync(() => {
                  aborts += 1;
                }),
          contextUsage: () => Effect.die("unexpected context read"),
          shake: () => Effect.die("unexpected chat shake"),
          closeChat: () => Effect.die("unexpected chat close"),
        });
        yield* install(bot, config).pipe(
          Effect.provideService(Application, application),
          Effect.provide(BunCrypto.layer),
          Effect.provide(Logger.layer([logger])),
        );
        const handleInteraction = interactionHandlerFor(bot);
        const invoke = (channelId: bigint, guildId = 1n) =>
          new Promise<string>((resolve) => {
            handleInteraction(
              interaction({
                channelId,
                guildId,
                data: { name: "abort" },
                defer: async (isPrivate) => {
                  assert.isTrue(isPrivate);
                },
                edit: async (response) => {
                  assert.deepStrictEqual(response.allowedMentions, {
                    parse: [],
                    repliedUser: false,
                  });
                  resolve(response.content ?? "");
                },
              }),
            );
          });

        const unboundReply = yield* Effect.promise(() => invoke(21n));
        for (const [channelId, guildId] of [
          [20n, 2n],
          [30n, 1n],
          [10n, 1n],
          [31n, 1n],
        ] as const) {
          assert.strictEqual(yield* Effect.promise(() => invoke(channelId, guildId)), unboundReply);
        }
        assert.strictEqual(aborts, 0);
        assert.deepStrictEqual(logs, []);

        const applicationFailure = yield* Effect.promise(() => invoke(22n));
        const discordFailure = yield* Effect.promise(() => invoke(32n));
        assert.strictEqual(applicationFailure, discordFailure);
        assert.notStrictEqual(applicationFailure, unboundReply);
        assert.notInclude(applicationFailure, secret);
        assert.notInclude(applicationFailure, "Failed to abort chat");
        assert.notInclude(JSON.stringify(logs), secret);
        assert.deepStrictEqual(
          logs.map((entry) => entry.annotations.phase),
          ["abort-chat", "resolve-interaction-channel"],
        );
        assert.strictEqual(aborts, 0);

        const successReply = yield* Effect.promise(() => invoke(20n));
        assert.notStrictEqual(successReply, unboundReply);
        assert.notStrictEqual(successReply, applicationFailure);
        assert.strictEqual(aborts, 1);
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
          createWorkspace: () => Effect.die("unexpected explicit workspace creation"),
          getOrCreateWorkspaceByBinding: () => Effect.die("unexpected workspace creation"),
          bindWorkspace: () => Effect.die("unexpected workspace binding"),
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
          createWorkspace: () => Effect.die("unexpected explicit workspace creation"),
          getOrCreateWorkspaceByBinding: () => Effect.die("unexpected workspace creation"),
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
          findChatPlatformBinding: () => Effect.die("unexpected chat binding lookup"),
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
          createWorkspace: () => Effect.die("unexpected explicit workspace creation"),
          getOrCreateWorkspaceByBinding: () => Effect.die("unexpected workspace creation"),
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
          findChatPlatformBinding: () => Effect.die("unexpected chat binding lookup"),
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
          createWorkspace: () => Effect.die("unexpected explicit workspace creation"),
          getOrCreateWorkspaceByBinding: () => Effect.die("unexpected workspace creation"),
          bindWorkspace: () =>
            Effect.gen(function* () {
              yield* Deferred.succeed(bindStarted, undefined);
              yield* Deferred.await(releaseBind);
              return workspace;
            }),
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
              getChannel: async (channelId) =>
                channelId === 10n
                  ? { id: 10n, guildId: 1n, type: ChannelTypes.GuildText, name: "general" }
                  : { id: 20n, guildId: 1n, type: ChannelTypes.PublicThread, parentId: 10n },
              sendMessage: async () => undefined,
              editChannel: async () => undefined,
              startThreadWithMessage: async () => ({ id: 20n }),
            },
          } satisfies DiscordInputBot;
          const application = Application.of({
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
                    message: "opening send failed",
                  });
                }
                yield* Deferred.succeed(followupSent, undefined);
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
          assert.deepStrictEqual(received, ["opening", "follow-up"]);
          assert.deepStrictEqual(contextPrompts, [["opening", "follow-up"]]);
          assert.isTrue(attachmentRequested);
        }),
      ),
  );

  it.effect("authorizes destructive close and archives only after core success", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const order: Array<string> = [];
        const sent: Array<string> = [];
        const logs: Array<ReturnType<typeof Logger.formatStructured.log>> = [];
        const logger = Logger.make((options) => logs.push(Logger.formatStructured.log(options)));
        let failChannelLookup = false;
        let resolveSent: (() => void) | undefined;
        const delivered = new Promise<void>((resolve) => {
          resolveSent = resolve;
        });
        const drainStarted = yield* Deferred.make<void>();
        const releaseDrain = yield* Deferred.make<void>();
        let componentDeferrals = 0;
        let closed = false;
        const bot = {
          id: 999n,
          events: {},
          helpers: {
            getChannel: async () => {
              if (failChannelLookup) throw { status: 403, body: '{"code":50013}' };
              return {
                id: 20n,
                guildId: 1n,
                type: ChannelTypes.PublicThread,
                parentId: 10n,
              };
            },
            sendMessage: async (_channelId, options) => {
              sent.push(options.content);
              resolveSent?.();
            },
            editChannel: async (_channelId, options) => {
              assert.deepStrictEqual(options, { archived: true, locked: true });
              order.push("archive-thread");
            },
            startThreadWithMessage: async () => {
              throw new Error("close must not create a thread");
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
        const application = Application.of({
          createWorkspace: () => Effect.die("unexpected explicit workspace creation"),
          getOrCreateWorkspaceByBinding: () => Effect.die("unexpected workspace creation"),
          bindWorkspace: () => Effect.die("unexpected workspace binding"),
          createChat: () => Effect.die("unexpected chat creation"),
          findWorkspaceByPlatformId: () => Effect.die("unexpected workspace lookup"),
          findChatByPlatformId: () => Effect.succeed(Option.some(chat)),
          findChatPlatformBinding: () => Effect.die("unexpected chat binding lookup"),
          transcript: () => Effect.die("unexpected transcript read"),
          closeChat: (_id, options) =>
            Effect.sync(() => {
              order.push(options.allowDirtyWorktree ? "core-force" : "core-safe");
              if (options.allowDirtyWorktree) {
                closed = true;
                return { kind: "closed" };
              }
              return { kind: "worktree-confirmation-required" };
            }),
          sendMessage: () =>
            closed ? Effect.fail(new ChatClosed()) : Effect.die("unexpected open message"),
          abort: () => Effect.die("unexpected chat abort"),
          contextUsage: () => Effect.die("unexpected context read"),
          shake: () => Effect.die("unexpected chat shake"),
        });

        yield* install(bot, config, () =>
          Effect.gen(function* () {
            order.push("drain-start");
            yield* Deferred.succeed(drainStarted, undefined);
            yield* Deferred.await(releaseDrain);
            order.push("drain-end");
          }),
        ).pipe(
          Effect.provideService(Application, application),
          Effect.provide(BunCrypto.layer),
          Effect.provide(Logger.layer([logger])),
        );
        const handleInteraction = interactionHandlerFor(bot);
        const invoke = (overrides: Partial<DiscordInteraction>) =>
          new Promise<Parameters<DiscordInteraction["edit"]>[0]>((resolve) => {
            handleInteraction(
              interaction({
                channelId: 20n,
                data: { name: "close" },
                deferEdit: async () => {
                  componentDeferrals += 1;
                },
                edit: async (options) => {
                  order.push("reply");
                  resolve(options);
                },
                ...overrides,
              }),
            );
          });

        yield* TestClock.setTime(0);
        const first = yield* Effect.promise(() => invoke({}));
        const actionRow = first.components?.[0];
        if (actionRow?.type !== MessageComponentTypes.ActionRow) {
          return yield* Effect.die("missing close confirmation row");
        }
        const button = actionRow.components[0];
        if (button?.type !== MessageComponentTypes.Button || button.customId === undefined) {
          return yield* Effect.die("missing close confirmation button");
        }
        const customId = button.customId;
        assert.strictEqual(
          first.content,
          "Git requires destructive removal for this worktree. Closing may discard changes or nested repositories. Local and remote branches will be kept.",
        );
        assert.strictEqual(button.label, "Close with force");
        assert.strictEqual(button.style, ButtonStyles.Danger);
        assert.deepStrictEqual(order, ["core-safe", "reply"]);

        const unauthorized = yield* Effect.promise(() =>
          invoke({
            type: InteractionTypes.MessageComponent,
            user: { id: 101n },
            message: { id: 50n, channelId: 20n },
            data: { customId },
          }),
        );
        assert.strictEqual(
          unauthorized.content,
          "Only the person who requested this close can confirm it.",
        );
        assert.notInclude(order, "clear-button");

        yield* TestClock.setTime(300_001);
        const expired = yield* Effect.promise(() =>
          invoke({
            type: InteractionTypes.MessageComponent,
            message: { id: 50n, channelId: 20n },
            data: { customId },
          }),
        );
        assert.strictEqual(expired.content, "This close confirmation is no longer valid.");
        assert.deepStrictEqual(expired.components, []);
        assert.deepStrictEqual(order.slice(-1), ["reply"]);

        const second = yield* Effect.promise(() => invoke({}));
        const secondActionRow = second.components?.[0];
        if (secondActionRow?.type !== MessageComponentTypes.ActionRow) {
          return yield* Effect.die("missing close confirmation row");
        }
        const secondButton = secondActionRow.components[0];
        if (
          secondButton?.type !== MessageComponentTypes.Button ||
          secondButton.customId === undefined
        ) {
          return yield* Effect.die("missing close confirmation button");
        }
        const secondCustomId = secondButton.customId;
        failChannelLookup = true;
        const failedLookup = yield* Effect.promise(() =>
          invoke({
            type: InteractionTypes.MessageComponent,
            message: { id: 51n, channelId: 20n },
            data: { customId: secondCustomId },
          }),
        );
        assert.deepStrictEqual(failedLookup.components, []);
        assert.strictEqual(logs.length, 1);
        assert.strictEqual(logs[0]?.annotations.operation, "close-confirmation");
        assert.strictEqual(logs[0]?.annotations.phase, "resolve-interaction-channel");
        assert.strictEqual(logs[0]?.annotations.chatId, chatId);
        failChannelLookup = false;
        const beforeConfirm = order.length;
        const confirming = yield* Effect.promise(() =>
          invoke({
            type: InteractionTypes.MessageComponent,
            message: { id: 51n, channelId: 20n },
            data: { customId: secondCustomId },
          }),
        ).pipe(Effect.forkChild);
        yield* Deferred.await(drainStarted);
        assert.notInclude(order, "archive-thread");
        yield* Deferred.succeed(releaseDrain, undefined);
        const confirmed = yield* Fiber.join(confirming);
        assert.strictEqual(
          confirmed.content,
          "Chat closed. The transcript remains available in this archived thread.",
        );
        assert.deepStrictEqual(confirmed.components, []);
        assert.deepStrictEqual(order.slice(beforeConfirm), [
          "core-force",
          "drain-start",
          "drain-end",
          "archive-thread",
          "reply",
        ]);
        assert.strictEqual(componentDeferrals, 4);

        const repeated = yield* Effect.promise(() =>
          invoke({
            type: InteractionTypes.MessageComponent,
            message: { id: 51n, channelId: 20n },
            data: { customId: secondCustomId },
          }),
        );
        assert.strictEqual(repeated.content, "This close confirmation is no longer valid.");
        assert.strictEqual(order.filter((entry) => entry === "core-force").length, 1);
        assert.strictEqual(componentDeferrals, 5);

        handlerFor(bot)(message({ channelId: 20n, content: "late" }));
        yield* Effect.promise(() => delivered);
        assert.strictEqual(sent.at(-1), "This chat is closed. Start a new thread to continue.");
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
          createWorkspace: () => Effect.die("unexpected workspace creation"),
          getOrCreateWorkspaceByBinding: () => Effect.die("unexpected workspace creation"),
          bindWorkspace: () => Effect.die("unexpected workspace binding"),
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
          createWorkspace: () => Effect.die("unexpected workspace creation"),
          getOrCreateWorkspaceByBinding: () => Effect.die("unexpected workspace creation"),
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
          createWorkspace: () => Effect.die("unexpected workspace creation"),
          getOrCreateWorkspaceByBinding: () => Effect.die("unexpected workspace creation"),
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
