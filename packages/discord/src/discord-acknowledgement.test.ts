import { assert, describe, it } from "@effect/vitest";
import { InteractionResponseTypes, InteractionTypes } from "discordeno";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Logger from "effect/Logger";
import * as TestClock from "effect/testing/TestClock";
import {
  type AcknowledgeableInteraction,
  make,
  type SendInteractionResponse,
} from "./discord-acknowledgement.ts";
import { reportFailure } from "./discord-error.ts";

const DISCORD_EPOCH_MS = 1_420_070_400_000;

const interaction = (type: InteractionTypes): AcknowledgeableInteraction => ({
  id: 0n,
  token: "private-interaction-token",
  acknowledged: false,
  type,
});

describe("Discord interaction acknowledgement", () => {
  it.effect("uses the first-attempt deadline for an interaction aged 2400ms", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(DISCORD_EPOCH_MS + 2_400);
      const testClock = yield* TestClock.testClockWith((clock) => Effect.succeed(clock));
      let monotonicOffsetNanos = 0n;
      const clock: Clock.Clock = {
        currentTimeMillisUnsafe: () => testClock.currentTimeMillisUnsafe(),
        currentTimeMillis: testClock.currentTimeMillis,
        currentTimeNanosUnsafe: () => testClock.currentTimeNanosUnsafe(),
        currentTimeNanos: testClock.currentTimeNanos,
        monotonicTimeNanosUnsafe: () => testClock.monotonicTimeNanosUnsafe() + monotonicOffsetNanos,
        monotonicTimeNanos: Effect.sync(
          () => testClock.monotonicTimeNanosUnsafe() + monotonicOffsetNanos,
        ),
        sleep: (duration) => testClock.sleep(duration),
      };
      const first = Promise.withResolvers<void>();
      const second = Promise.withResolvers<void>();
      const calls: Array<Parameters<SendInteractionResponse>> = [];
      const acknowledgedStates: boolean[] = [];
      const logs: Array<ReturnType<typeof Logger.formatStructured.log>> = [];
      const candidate = interaction(InteractionTypes.ApplicationCommand);
      const acknowledge = make((...args) => {
        calls.push(args);
        acknowledgedStates.push(candidate.acknowledged);
        if (calls.length === 1) monotonicOffsetNanos = 40_000_000n;
        return calls.length === 1 ? first.promise : second.promise;
      });
      let continued = false;
      const fiber = yield* acknowledge(candidate, {
        kind: "reply",
        visibility: "public",
      }).pipe(
        Effect.andThen(
          Effect.sync(() => {
            continued = true;
          }),
        ),
        Effect.provide(
          Logger.layer([Logger.make((options) => logs.push(Logger.formatStructured.log(options)))]),
        ),
        Effect.provideService(Clock.Clock, clock),
        Effect.forkChild,
      );

      yield* Effect.yieldNow;
      assert.strictEqual(calls.length, 1);
      assert.deepStrictEqual(acknowledgedStates, [true]);
      assert.isFalse(continued);
      yield* TestClock.adjust("59 millis");
      assert.strictEqual(calls.length, 1);
      yield* TestClock.adjust("1 millis");
      assert.strictEqual(calls.length, 2);
      assert.deepStrictEqual(acknowledgedStates, [true, true]);
      assert.strictEqual(calls[0]?.[0], candidate.id);
      assert.strictEqual(calls[0]?.[1], candidate.token);
      assert.strictEqual(calls[0]?.length, 3);
      assert.deepStrictEqual(calls[0]?.[2], {
        type: InteractionResponseTypes.DeferredChannelMessageWithSource,
        data: {},
      });
      assert.strictEqual(calls[1]?.[2], calls[0]?.[2]);
      second.resolve();
      yield* Fiber.join(fiber);
      assert.isTrue(continued);
      assert.strictEqual(logs.length, 1);
      assert.strictEqual(logs[0]?.level, "INFO");
      assert.strictEqual(logs[0]?.annotations.acknowledgementDecision, "fulfilled");
      assert.strictEqual(logs[0]?.annotations.acknowledgementWinningAttempt, 2);
      assert.strictEqual(logs[0]?.annotations.deliveryAgeAtAcknowledgementMs, 2_400);
      assert.strictEqual(logs[0]?.annotations.hedgeDueAfterFirstStartMs, 100);
      assert.strictEqual(logs[0]?.annotations.acknowledgementDecisionAfterMs, 100);
      assert.notInclude(JSON.stringify(logs), candidate.token);
      first.resolve();
      yield* Effect.yieldNow;
      assert.strictEqual(logs.length, 1);
    }),
  );

  it.effect("accepts attempt-2 40060 while attempt 1 remains pending", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(DISCORD_EPOCH_MS);
      const first = Promise.withResolvers<void>();
      const logs: Array<ReturnType<typeof Logger.formatStructured.log>> = [];
      const calls: Array<Parameters<SendInteractionResponse>> = [];
      const candidate = interaction(InteractionTypes.MessageComponent);
      const duplicate = {
        status: 400,
        body: '{"code":40060,"message":"private-duplicate-response"}',
      };
      const acknowledge = make((...args) => {
        calls.push(args);
        return calls.length === 1 ? first.promise : Promise.reject(duplicate);
      });
      const provided = acknowledge(candidate, { kind: "update-source-message" }).pipe(
        Effect.provide(
          Logger.layer([Logger.make((options) => logs.push(Logger.formatStructured.log(options)))]),
        ),
      );
      const fiber = yield* provided.pipe(Effect.forkChild);

      yield* Effect.yieldNow;
      yield* TestClock.adjust("500 millis");
      yield* Fiber.join(fiber);
      assert.strictEqual(calls.length, 2);
      assert.deepStrictEqual(calls[0]?.[2], {
        type: InteractionResponseTypes.DeferredUpdateMessage,
      });
      assert.strictEqual(calls[1]?.[2], calls[0]?.[2]);
      assert.strictEqual(logs.length, 1);
      assert.strictEqual(logs[0]?.level, "INFO");
      assert.strictEqual(logs[0]?.annotations.acknowledgementDecision, "qualified-40060");
      assert.notInclude(JSON.stringify(logs), "private-");
      first.reject(new Error("private-late-rejection"));
      yield* Effect.yieldNow;
      assert.strictEqual(logs.length, 1);
    }),
  );

  it.effect("reports rejected acknowledgement evidence once at the terminal boundary", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(DISCORD_EPOCH_MS);
      const first = Promise.withResolvers<void>();
      const second = Promise.withResolvers<void>();
      let sends = 0;
      const acknowledge = make(() => {
        sends += 1;
        return sends === 1 ? first.promise : second.promise;
      });
      const logs: Array<ReturnType<typeof Logger.formatStructured.log>> = [];
      const logger = Logger.make((options) => logs.push(Logger.formatStructured.log(options)));
      const failureFiber = yield* acknowledge(interaction(InteractionTypes.ApplicationCommand), {
        kind: "reply",
        visibility: "private",
      }).pipe(Effect.flip, Effect.provide(Logger.layer([logger])), Effect.forkChild);

      yield* Effect.yieldNow;
      yield* TestClock.adjust("500 millis");
      assert.strictEqual(sends, 2);
      first.reject({ status: 503, body: '{"code":50013,"message":"private-first"}' });
      yield* Effect.yieldNow;
      second.reject({
        status: 400,
        body: '{"code":40060,"message":"private-duplicate-response"}',
      });
      const failure = yield* Fiber.join(failureFiber);
      assert.deepStrictEqual(logs, []);
      yield* reportFailure("interaction-request", Cause.fail(failure)).pipe(
        Effect.provide(Logger.layer([logger])),
      );

      assert.strictEqual(failure.operation, "defer-interaction");
      assert.strictEqual(failure.status, 503);
      assert.strictEqual(failure.discordCode, 50_013);
      assert.strictEqual(logs.length, 1);
      assert.strictEqual(logs[0]?.level, "ERROR");
      assert.strictEqual(logs[0]?.annotations.operation, "interaction-request");
      assert.strictEqual(logs[0]?.annotations.discordOperation, "defer-interaction");
      assert.strictEqual(logs[0]?.annotations.status, 503);
      assert.strictEqual(logs[0]?.annotations.discordCode, 50_013);
      assert.strictEqual(logs[0]?.annotations.acknowledgementMode, "defer");
      assert.strictEqual(logs[0]?.annotations.acknowledgementDecision, "rejected");
      assert.strictEqual(logs[0]?.annotations.deliveryAgeAtAcknowledgementMs, 0);
      assert.strictEqual(logs[0]?.annotations.firstStartedAfterAcknowledgementMs, 0);
      assert.strictEqual(logs[0]?.annotations.hedgeDueAfterFirstStartMs, 500);
      assert.strictEqual(logs[0]?.annotations.acknowledgementDecisionAfterMs, 500);
      assert.deepStrictEqual(logs[0]?.annotations.acknowledgementAttempts, [
        {
          attempt: 1,
          outcome: "rejected",
          startedAfterAcknowledgementMs: 0,
          elapsedMs: 500,
          status: 503,
          discordCode: 50_013,
        },
        {
          attempt: 2,
          outcome: "rejected",
          startedAfterAcknowledgementMs: 500,
          elapsedMs: 0,
          status: 400,
          discordCode: 40_060,
        },
      ]);
      assert.notInclude(JSON.stringify(logs), "private-");
    }),
  );

  it.effect("never starts attempt 2 at the 3000ms response boundary", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(DISCORD_EPOCH_MS + 3_000);
      const first = Promise.withResolvers<void>();
      let sends = 0;
      const acknowledge = make(() => {
        sends += 1;
        return first.promise;
      });
      const fiber = yield* acknowledge(interaction(InteractionTypes.ApplicationCommand), {
        kind: "reply",
        visibility: "public",
      }).pipe(Effect.forkChild);

      yield* Effect.yieldNow;
      assert.strictEqual(sends, 1);
      yield* TestClock.adjust("1 second");
      assert.strictEqual(sends, 1);
      yield* Fiber.interrupt(fiber);
      first.resolve();
      yield* Effect.yieldNow;
    }),
  );

  it.effect("cancels the pending hedge when acknowledgement is interrupted", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(DISCORD_EPOCH_MS);
      const first = Promise.withResolvers<void>();
      let sends = 0;
      const acknowledge = make(() => {
        sends += 1;
        return first.promise;
      });
      const fiber = yield* acknowledge(interaction(InteractionTypes.ApplicationCommand), {
        kind: "reply",
        visibility: "public",
      }).pipe(Effect.forkChild);

      yield* Effect.yieldNow;
      assert.strictEqual(sends, 1);
      yield* Fiber.interrupt(fiber);
      yield* TestClock.adjust("500 millis");
      assert.strictEqual(sends, 1);
      first.resolve();
      yield* Effect.yieldNow;
    }),
  );
});
