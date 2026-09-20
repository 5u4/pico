import { assert, describe, it } from "@effect/vitest";
import type { TelegramConfig } from "@pico/config/config";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Redacted from "effect/Redacted";
import { TestClock } from "effect/testing";
import { make, type TelegramClientOptions, TelegramError } from "./client.ts";
import type { TelegramInput } from "./telegram-model.ts";

type Fetch = NonNullable<TelegramClientOptions["fetch"]>;

const config: TelegramConfig = {
  token: Redacted.make("token-value"),
  allowedChatIds: ["-1001"],
  allowedUserIds: ["42"],
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const endpoint = (url: string | URL) => new URL(url).pathname.split("/").at(-1) ?? "";

describe("telegram client", () => {
  it.effect("stops polling on conflict responses", () =>
    Effect.gen(function* () {
      const fetch: Fetch = async (url) => {
        switch (endpoint(url)) {
          case "getMe":
            return json({ ok: true, result: { id: 1, username: "pico_bot" } });
          case "getWebhookInfo":
            return json({ ok: true, result: { url: "" } });
          case "getUpdates":
            return json({ ok: false, error_code: 409 });
          default:
            throw new Error(`unexpected endpoint ${endpoint(url)}`);
        }
      };
      const client = yield* make(config, { fetch });
      const failure = yield* client.consume(() => Effect.void).pipe(Effect.flip);
      assert.instanceOf(failure, TelegramError);
      assert.strictEqual(failure.operation, "get-updates");
      assert.strictEqual(failure.category, "conflict");
    }),
  );

  it.effect("cancels an in-flight long poll when interrupted", () =>
    Effect.gen(function* () {
      const pollStarted = yield* Deferred.make<void>();
      const pollAborted = yield* Deferred.make<boolean>();
      const fetch: Fetch = async (url, init) => {
        switch (endpoint(url)) {
          case "getMe":
            return json({ ok: true, result: { id: 1, username: "pico_bot" } });
          case "getWebhookInfo":
            return json({ ok: true, result: { url: "" } });
          case "getUpdates": {
            Deferred.doneUnsafe(pollStarted, Effect.void);
            return await new Promise<Response>((_, reject) => {
              init?.signal?.addEventListener(
                "abort",
                () => {
                  Deferred.doneUnsafe(pollAborted, Effect.succeed(init?.signal?.aborted ?? false));
                  reject(new DOMException("aborted", "AbortError"));
                },
                { once: true },
              );
            });
          }
          default:
            throw new Error(`unexpected endpoint ${endpoint(url)}`);
        }
      };

      const client = yield* make(config, { fetch });
      const fiber = yield* client.consume(() => Effect.void).pipe(Effect.forkChild);
      yield* Deferred.await(pollStarted);
      yield* Fiber.interrupt(fiber);
      assert.isTrue(yield* Deferred.await(pollAborted));
    }),
  );

  it.effect("retries a non-JSON gateway failure and delivers the next update", () =>
    Effect.gen(function* () {
      const gatewayResponse = yield* Deferred.make<void>();
      const inputs: TelegramInput[] = [];
      let polls = 0;
      const fetch: Fetch = async (url) => {
        switch (endpoint(url)) {
          case "getMe":
            return json({ ok: true, result: { id: 1, username: "pico_bot" } });
          case "getWebhookInfo":
            return json({ ok: true, result: { url: "" } });
          case "getUpdates":
            polls += 1;
            if (polls === 1) {
              Deferred.doneUnsafe(gatewayResponse, Effect.void);
              return new Response("<html>Bad Gateway</html>", { status: 502 });
            }
            if (polls === 2) {
              return json({
                ok: true,
                result: [
                  {
                    update_id: 7,
                    message: {
                      chat: { id: -1001, type: "supergroup", is_forum: true },
                      from: { id: 42, is_bot: false },
                      text: "Recovered prompt",
                      is_topic_message: true,
                      message_thread_id: 8,
                    },
                  },
                ],
              });
            }
            return json({ ok: false, error_code: 409 });
          default:
            throw new Error(`unexpected endpoint ${endpoint(url)}`);
        }
      };
      const client = yield* make(config, { fetch });
      const fiber = yield* client
        .consume((input) =>
          Effect.sync(() => {
            inputs.push(input);
          }),
        )
        .pipe(Effect.flip, Effect.forkChild);
      yield* Deferred.await(gatewayResponse);
      yield* TestClock.adjust(500);
      const failure = yield* Fiber.join(fiber);
      assert.strictEqual(failure.category, "conflict");
      assert.deepStrictEqual(inputs, [
        {
          kind: "forum-topic",
          chatId: "-1001",
          userId: "42",
          text: "Recovered prompt",
          chatTitle: null,
          command: null,
          address: { chatId: "-1001", topicId: 8 },
        },
      ]);
    }),
  );

  it.effect("aborts a hanging response body when the consumer scope closes", () =>
    Effect.gen(function* () {
      const bodyStarted = yield* Deferred.make<void>();
      const events: string[] = [];
      const fetch: Fetch = async (url, init) => {
        switch (endpoint(url)) {
          case "getMe":
            return json({ ok: true, result: { id: 1, username: "pico_bot" } });
          case "getWebhookInfo":
            return json({ ok: true, result: { url: "" } });
          case "getUpdates":
            return new Response(
              new ReadableStream<Uint8Array>(
                {
                  start(controller) {
                    init?.signal?.addEventListener(
                      "abort",
                      () => {
                        events.push("request-aborted");
                        controller.error(new DOMException("aborted", "AbortError"));
                      },
                      { once: true },
                    );
                  },
                  pull() {
                    events.push("body-reading");
                    Deferred.doneUnsafe(bodyStarted, Effect.void);
                  },
                },
                { highWaterMark: 0 },
              ),
            );
          default:
            throw new Error(`unexpected endpoint ${endpoint(url)}`);
        }
      };
      const client = yield* make(config, { fetch });
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* client.consume(() => Effect.void).pipe(Effect.forkScoped);
          yield* Deferred.await(bodyStarted);
        }),
      );
      assert.deepStrictEqual(events, ["body-reading", "request-aborted"]);
    }),
  );

  it.effect("reports body network failure without retrying an ambiguous send", () =>
    Effect.gen(function* () {
      const requests: string[] = [];
      const fetch: Fetch = async (url) => {
        const method = endpoint(url);
        requests.push(method);
        switch (method) {
          case "getMe":
            return json({ ok: true, result: { id: 1, username: "pico_bot" } });
          case "getWebhookInfo":
            return json({ ok: true, result: { url: "" } });
          case "sendMessage":
            return new Response(
              new ReadableStream<Uint8Array>({
                start(controller) {
                  controller.error(new TypeError("connection lost for token-value"));
                },
              }),
            );
          default:
            throw new Error(`unexpected endpoint ${method}`);
        }
      };
      const client = yield* make(config, { fetch });
      const failure = yield* client
        .sendText({ chatId: "-1001", topicId: 8 }, "Reply")
        .pipe(Effect.flip);
      assert.strictEqual(failure.category, "network");
      assert.strictEqual(failure.operation, "send-message");
      assert.deepStrictEqual(requests, ["getMe", "getWebhookInfo", "sendMessage"]);
      assert.isFalse(JSON.stringify(failure).includes("token-value"));
    }),
  );

  it.effect("retains structured API rate limits on unsuccessful HTTP responses", () =>
    Effect.gen(function* () {
      const fetch: Fetch = async (url) => {
        switch (endpoint(url)) {
          case "getMe":
            return json({ ok: true, result: { id: 1, username: "pico_bot" } });
          case "getWebhookInfo":
            return json({ ok: true, result: { url: "" } });
          case "sendMessage":
            return json(
              {
                ok: false,
                error_code: 429,
                description: "Request for token-value exceeded its rate limit",
                parameters: { retry_after: 3 },
              },
              503,
            );
          default:
            throw new Error(`unexpected endpoint ${endpoint(url)}`);
        }
      };
      const client = yield* make(config, { fetch });
      const failure = yield* client
        .sendText({ chatId: "-1001", topicId: 8 }, "Reply")
        .pipe(Effect.flip);
      assert.strictEqual(failure.category, "rate-limit");
      assert.strictEqual(failure.status, 503);
      assert.strictEqual(failure.retryAfterSeconds, 3);
      assert.isFalse(JSON.stringify(failure).includes("token-value"));
    }),
  );

  it.effect("requires a leading command entity and ignores another bot's commands", () =>
    Effect.gen(function* () {
      const inputs: TelegramInput[] = [];
      let polls = 0;
      const messages = [
        {
          text: "/BiNd@PiCo_BoT workspace",
          entities: [{ offset: 0, length: 14, type: "bot_command" }],
        },
        { text: "/abort@other_bot", entities: [{ offset: 0, length: 16, type: "bot_command" }] },
        { text: "say /abort", entities: [{ offset: 4, length: 6, type: "bot_command" }] },
        { text: "/abort", entities: [{ offset: 0, length: 6, type: "bold" }] },
        { text: "/abort", entities: [{ offset: 0, length: 7, type: "bot_command" }] },
      ];
      const fetch: Fetch = async (url) => {
        switch (endpoint(url)) {
          case "getMe":
            return json({ ok: true, result: { id: 1, username: "pico_bot" } });
          case "getWebhookInfo":
            return json({ ok: true, result: { url: "" } });
          case "getUpdates":
            polls += 1;
            return polls > 1
              ? json({ ok: false, error_code: 409 })
              : json({
                  ok: true,
                  result: messages.map((message, index) => ({
                    update_id: index,
                    message: {
                      chat: { id: -1001, type: "supergroup", is_forum: true },
                      from: { id: 42, is_bot: false },
                      is_topic_message: true,
                      message_thread_id: 8,
                      ...message,
                    },
                  })),
                });
          default:
            throw new Error(`unexpected endpoint ${endpoint(url)}`);
        }
      };
      const client = yield* make(config, { fetch });
      const failure = yield* client
        .consume((input) =>
          Effect.sync(() => {
            inputs.push(input);
          }),
        )
        .pipe(Effect.flip);
      assert.strictEqual(failure.category, "conflict");
      assert.deepStrictEqual(
        inputs.map((input) => (input.kind === "unsupported" ? input.reason : input.command)),
        [
          { name: "bind", target: "self", argument: "workspace" },
          "other-bot-command",
          null,
          null,
          null,
        ],
      );
    }),
  );
});
