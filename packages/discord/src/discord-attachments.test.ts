import * as BunCrypto from "@effect/platform-bun/BunCrypto";
import { assert, describe, it } from "@effect/vitest";
import type * as AgentMessage from "@pico/contract/agent-message";
import { Application } from "@pico/contract/application";
import { ChannelTypes } from "discordeno";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import {
  acknowledgeInteraction,
  chatId,
  config,
  defaultCwd,
  handlerFor,
  message,
  startedDelivery,
  workspaceId,
} from "./discord-input.fixture.ts";
import { type DiscordInputBot, install } from "./discord-input.ts";
import type { DiscordMessage } from "./discord-prompt.ts";

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

describe("discord attachments", () => {
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
            startThreadWithMessage: async (_channelId, _messageId, options) => {
              threadNames.push(options.name);
              return { id: 20n };
            },
          },
        } satisfies DiscordInputBot;
        const application = Application.of({
          history: () => Effect.die("unexpected history read"),
          previewHistory: () => Effect.die("unexpected history preview"),
          navigateHistory: () => Effect.die("unexpected history navigation"),
          deleteWorkspace: () => Effect.die("unexpected workspace deletion"),
          updateWorkspace: () => Effect.die("unexpected workspace update"),
          availableWorkspaceModels: () => Effect.die("unexpected workspace model discovery"),
          availableWorkspaceSkills: () => Effect.die("unexpected workspace model discovery"),
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
              return startedDelivery;
            }),
          abort: () => Effect.die("unexpected chat abort"),
          contextUsage: () => Effect.die("unexpected context read"),
          shake: () => Effect.die("unexpected chat shake"),
          closeChat: () => Effect.die("unexpected chat close"),
          availableSkills: () => Effect.die("unexpected skill command discovery"),
        });

        yield* install(bot, config, acknowledgeInteraction, () => Effect.void, httpClient).pipe(
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
        let channelReads = 0;
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
            addReaction: async () => undefined,
            deleteOwnReaction: async () => undefined,
            getChannel: async () => {
              channelReads += 1;
              return { id: 10n, guildId: 1n, type: ChannelTypes.GuildText };
            },
            sendMessage: async (_channelId, options) => {
              replies.push(options.content);
              resolveReply?.(options.content);
            },
            editChannel: async () => undefined,
            startThreadWithoutMessage: async () => {
              throw new Error("unexpected schedule");
            },
            deleteChannel: async () => {
              throw new Error("unexpected schedule cleanup");
            },
            startThreadWithMessage: async () => {
              throw new Error("rejected input must not create a thread");
            },
          },
        } satisfies DiscordInputBot;
        const application = Application.of({
          history: () => Effect.die("unexpected history read"),
          previewHistory: () => Effect.die("unexpected history preview"),
          navigateHistory: () => Effect.die("unexpected history navigation"),
          deleteWorkspace: () => Effect.die("unexpected workspace deletion"),
          updateWorkspace: () => Effect.die("unexpected workspace update"),
          availableWorkspaceModels: () => Effect.die("unexpected workspace model discovery"),
          availableWorkspaceSkills: () => Effect.die("unexpected workspace model discovery"),
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

        yield* install(bot, config, acknowledgeInteraction, () => Effect.void, httpClient).pipe(
          Effect.provideService(Application, application),
          Effect.provide(BunCrypto.layer),
          Effect.provide(Logger.layer([logger])),
        );
        const handleMessage = handlerFor(bot);
        handleMessage(message({ guildId: 2n }));
        const guildless = message({
          attachments: [
            {
              filename: "image.png",
              size: png.byteLength,
              url: "https://cdn.discordapp.com/valid",
            },
          ],
        });
        Reflect.deleteProperty(guildless, "guildId");
        handleMessage(guildless);
        yield* Effect.yieldNow;
        assert.deepStrictEqual(replies, []);
        assert.strictEqual(fetchCount, 0);
        assert.strictEqual(channelReads, 0);
        assert.deepStrictEqual(logs, []);

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
});
