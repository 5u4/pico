import { assert, describe, it } from "@effect/vitest";
import { ApplicationError } from "@pico/contract/errors";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Logger from "effect/Logger";
import { discordError, promiseBoundary, reportFailure } from "./discord-error.ts";
import { sdkLoggerFactory } from "./layer.ts";

describe("Discord error ownership", () => {
  it.effect("retains SDK wrapper status and Discord code without retaining the response", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        promiseBoundary("edit-message", () =>
          Promise.reject(
            new Error("private-sdk-wrapper", {
              cause: {
                status: 403,
                body: '{"code":50013,"message":"private-response"}',
                route: "/webhooks/private-token",
              },
            }),
          ),
        ),
      );
      assert.strictEqual(error.operation, "edit-message");
      assert.strictEqual(error.status, 403);
      assert.strictEqual(error.discordCode, 50013);
      assert.notInclude(JSON.stringify(error), "private-");
      const malformedBody = discordError("send-message", { status: 502, body: "private-response" });
      assert.strictEqual(malformedBody.status, 502);
      assert.isUndefined(malformedBody.discordCode);
      const network = yield* Effect.flip(
        promiseBoundary("send-message", () =>
          Promise.reject({ status: 999, error: "private-network-error" }),
        ),
      );
      assert.strictEqual(network.status, 999);
      assert.notInclude(JSON.stringify(network), "private-");
    }),
  );

  it.effect("keeps expected rejection and pure interruption quiet but reports mixed failure", () =>
    Effect.gen(function* () {
      const logs: Array<ReturnType<typeof Logger.formatStructured.log>> = [];
      const logger = Logger.make((options) => logs.push(Logger.formatStructured.log(options)));
      yield* Effect.gen(function* () {
        yield* reportFailure(
          "close-chat",
          Cause.fail(
            new ApplicationError({
              reason: "not-found",
              message: "Chat not found",
            }),
          ),
        );
        const canceled = yield* Effect.exit(reportFailure("defer-interaction", Cause.interrupt()));
        assert.isTrue(Exit.isFailure(canceled) && Cause.hasInterruptsOnly(canceled.cause));
        assert.deepStrictEqual(logs, []);
        yield* reportFailure(
          "defer-interaction",
          Cause.combine(Cause.interrupt(), Cause.die(new Error("private-token"))),
        );
      }).pipe(Effect.provide(Logger.layer([logger])));
      assert.strictEqual(logs.length, 1);
      assert.notInclude(JSON.stringify(logs), "private-token");
    }),
  );

  it.effect("does not forward REST diagnostics and categorizes gateway-only errors", () =>
    Effect.gen(function* () {
      const effects: Array<Effect.Effect<void>> = [];
      const factory = sdkLoggerFactory((effect) => effects.push(effect));
      const rest = factory("REST");
      rest.debug();
      rest.info({ route: "/webhooks/private-token", body: "private-prompt" });
      rest.error({ route: "/webhooks/private-token", body: "private-prompt" });
      assert.deepStrictEqual(effects, []);
      const gateway = factory("GATEWAY");
      gateway.debug();
      gateway.error("[Shard] There was an error connecting Shard #3.");
      gateway.error({ sessionId: "private-session", message: "private-payload" });
      gateway.info("[Shard] Shard #3 closed with code 1006. Attempting to resume...");
      gateway.info({ sessionId: "private-session" });
      gateway.info("[Shard] private-shutdown-detail");
      const logs: Array<ReturnType<typeof Logger.formatStructured.log>> = [];
      const logger = Logger.make((options) => logs.push(Logger.formatStructured.log(options)));
      yield* Effect.forEach(effects, (effect) => effect).pipe(
        Effect.provide(Logger.layer([logger])),
      );
      assert.strictEqual(logs.length, 3);
      assert.strictEqual(logs[0]?.annotations.category, "connection");
      assert.strictEqual(logs[0]?.annotations.shardId, "3");
      assert.strictEqual(logs[1]?.annotations.category, "sdk-gateway");
      assert.strictEqual(logs[2]?.level, "WARN");
      assert.strictEqual(logs[2]?.annotations.eventType, "disconnected");
      assert.strictEqual(logs[2]?.annotations.shardId, "3");
      assert.strictEqual(logs[2]?.annotations.closeCode, 1006);
      assert.notInclude(JSON.stringify(logs), "private-");
    }),
  );
});
