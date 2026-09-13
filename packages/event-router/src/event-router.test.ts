import { assert, describe, it } from "@effect/vitest";
import type { AgentEventEnvelope } from "@pico/contract/agent-event";
import { AgentRuntime } from "@pico/contract/agent-runtime";
import * as Chat from "@pico/contract/chat-model";
import { EventRouter } from "@pico/contract/event-router";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { layer } from "./layer.ts";

const firstChatId = Chat.ChatId.make("018f47a0-0000-7000-8000-000000000001");
const secondChatId = Chat.ChatId.make("018f47a0-0000-7000-8000-000000000002");
const thirdChatId = Chat.ChatId.make("018f47a0-0000-7000-8000-000000000003");

const envelope = (chatId: Chat.ChatId, message: string): AgentEventEnvelope => ({
  chatId,
  event: { type: "notice", level: "info", message },
});

describe("EventRouter", () => {
  it.effect("routes trusted filters and owns route and pump lifecycles", () =>
    Effect.gen(function* () {
      const source = yield* Queue.unbounded<AgentEventEnvelope>();
      const pumpStopped = yield* Deferred.make<void>();
      let runtimeDrains = 0;
      const runtimeLayer = Layer.succeed(
        AgentRuntime,
        AgentRuntime.of({
          askBtw: () => Effect.die("unexpected side question"),
          events: Stream.fromQueue(source).pipe(
            Stream.ensuring(Deferred.succeed(pumpStopped, undefined)),
          ),
          drain: () =>
            Effect.sync(() => {
              runtimeDrains += 1;
            }),
          transcript: () => Effect.die("unused"),
          send: () => Effect.die("unused"),
          sendCaptured: () => Effect.die("unused"),
          sendTurn: () => Effect.die("unexpected bot turn"),
          rotate: () => Effect.die("unexpected bot rotation"),
          deliver: () => Effect.die("unused"),
          publish: () => Effect.die("unused"),
          abort: () => Effect.die("unused"),
          contextUsage: () => Effect.die("unused"),
          shake: () => Effect.die("unused"),
          close: () => Effect.die("unexpected runtime close"),
        }),
      );
      const routerScope = yield* Scope.make();
      const routerContext = yield* Layer.build(layer.pipe(Layer.provide(runtimeLayer))).pipe(
        Scope.provide(routerScope),
      );
      const router = Context.get(routerContext, EventRouter);
      const firstRouteScope = yield* Scope.make();
      const secondRouteScope = yield* Scope.make();
      const firstRoute = yield* router
        .open((event) => event.chatId === firstChatId)
        .pipe(Scope.provide(firstRouteScope));
      const secondRoute = yield* router
        .open((event) => event.chatId === firstChatId)
        .pipe(Scope.provide(secondRouteScope));

      const firstDelivered = yield* Queue.unbounded<AgentEventEnvelope>();
      const secondDelivered = yield* Queue.unbounded<AgentEventEnvelope>();
      const deliveryStarted = yield* Deferred.make<void>();
      const releaseDelivery = yield* Deferred.make<void>();
      const drainCompleted = yield* Deferred.make<void>();
      yield* firstRoute.events.pipe(
        Stream.runForEach((item) => Queue.offer(firstDelivered, item)),
        Effect.forkIn(firstRouteScope),
      );
      yield* secondRoute.events.pipe(
        Stream.runForEach((item) => {
          if (item.event.type !== "notice" || item.event.message !== "before-drain") {
            return Queue.offer(secondDelivered, item);
          }
          return Deferred.succeed(deliveryStarted, undefined).pipe(
            Effect.andThen(Deferred.await(releaseDelivery)),
            Effect.andThen(Queue.offer(secondDelivered, item)),
          );
        }),
        Effect.forkIn(secondRouteScope),
      );

      const shared = envelope(firstChatId, "shared");
      yield* Queue.offer(source, shared);
      assert.deepStrictEqual(yield* Queue.take(firstDelivered), shared);
      assert.deepStrictEqual(yield* Queue.take(secondDelivered), shared);

      const afterNonmatch = envelope(firstChatId, "after-nonmatch");
      yield* Queue.offer(source, envelope(thirdChatId, "excluded"));
      yield* Queue.offer(source, afterNonmatch);
      assert.deepStrictEqual(yield* Queue.take(firstDelivered), afterNonmatch);
      assert.deepStrictEqual(yield* Queue.take(secondDelivered), afterNonmatch);

      yield* firstRoute.setFilter((event) => event.chatId === secondChatId);
      const oldFilterMatch = envelope(firstChatId, "old-filter");
      const newFilterMatch = envelope(secondChatId, "new-filter");
      yield* Queue.offer(source, oldFilterMatch);
      yield* Queue.offer(source, newFilterMatch);
      assert.deepStrictEqual(yield* Queue.take(firstDelivered), newFilterMatch);
      assert.deepStrictEqual(yield* Queue.take(secondDelivered), oldFilterMatch);

      yield* Scope.close(firstRouteScope, Exit.void);
      yield* Queue.offer(source, envelope(secondChatId, "after-route-release"));
      const routeReleaseSentinel = envelope(firstChatId, "route-release-sentinel");
      yield* Queue.offer(source, routeReleaseSentinel);
      assert.deepStrictEqual(yield* Queue.take(secondDelivered), routeReleaseSentinel);
      yield* Effect.yieldNow;
      assert.strictEqual(yield* Queue.size(firstDelivered), 0);

      yield* Queue.offer(source, envelope(firstChatId, "before-drain"));
      yield* Deferred.await(deliveryStarted);
      yield* router
        .drain()
        .pipe(Effect.ensuring(Deferred.succeed(drainCompleted, undefined)), Effect.forkChild);
      yield* Effect.yieldNow;
      assert.strictEqual(runtimeDrains, 1);
      assert.isFalse(yield* Deferred.isDone(drainCompleted));
      yield* Deferred.succeed(releaseDelivery, undefined);
      yield* Deferred.await(drainCompleted);
      assert.deepStrictEqual(
        yield* Queue.take(secondDelivered),
        envelope(firstChatId, "before-drain"),
      );

      const abandonedScope = yield* Scope.make();
      yield* router.open(() => true).pipe(Scope.provide(abandonedScope));
      const abandonedDrainCompleted = yield* Deferred.make<void>();
      yield* router
        .drain()
        .pipe(
          Effect.ensuring(Deferred.succeed(abandonedDrainCompleted, undefined)),
          Effect.forkChild,
        );
      yield* Effect.yieldNow;
      assert.isFalse(yield* Deferred.isDone(abandonedDrainCompleted));
      yield* Scope.close(abandonedScope, Exit.void);
      yield* Deferred.await(abandonedDrainCompleted);

      yield* Scope.close(secondRouteScope, Exit.void);
      yield* Scope.close(routerScope, Exit.void);
      yield* Deferred.await(pumpStopped);
      const afterRouterRelease = envelope(firstChatId, "after-router-release");
      yield* Queue.offer(source, afterRouterRelease);
      assert.strictEqual(yield* Queue.size(source), 1);
      assert.deepStrictEqual(yield* Queue.take(source), afterRouterRelease);
    }),
  );
  it.effect("reports a failed pump once and keeps scope shutdown quiet", () =>
    Effect.gen(function* () {
      for (const failureAt of ["filter", "upstream", "shutdown"] as const) {
        const records: Array<ReturnType<typeof Logger.formatStructured.log>> = [];
        const reported = Promise.withResolvers<void>();
        const logger = Logger.layer([
          Logger.make((options) => {
            const record = Logger.formatStructured.log(options);
            records.push(record);
            if (record.level === "ERROR") reported.resolve();
          }),
        ]);
        const source = yield* Queue.unbounded<AgentEventEnvelope>();
        const runtimeLayer = Layer.succeed(
          AgentRuntime,
          AgentRuntime.of({
            askBtw: () => Effect.die("unexpected side question"),
            events: Stream.fromQueue(source).pipe(
              Stream.mapEffect((item) =>
                failureAt === "upstream"
                  ? Effect.die(new Error("private upstream payload"))
                  : Effect.succeed(item),
              ),
            ),
            drain: () => Effect.void,
            transcript: () => Effect.die("unused"),
            send: () => Effect.die("unused"),
            sendCaptured: () => Effect.die("unused"),
            sendTurn: () => Effect.die("unexpected bot turn"),
            rotate: () => Effect.die("unexpected bot rotation"),
            deliver: () => Effect.die("unused"),
            publish: () => Effect.die("unused"),
            abort: () => Effect.die("unused"),
            contextUsage: () => Effect.die("unused"),
            shake: () => Effect.die("unused"),
            close: () => Effect.void,
          }),
        );
        yield* Effect.gen(function* () {
          const routerScope = yield* Scope.make();
          const routeScope = yield* Scope.make();
          const context = yield* Layer.build(layer.pipe(Layer.provide(runtimeLayer))).pipe(
            Scope.provide(routerScope),
          );
          const router = Context.get(context, EventRouter);
          yield* router
            .open(() => {
              if (failureAt === "filter") throw new Error("private filter payload");
              return true;
            })
            .pipe(Scope.provide(routeScope));
          if (failureAt !== "shutdown") {
            yield* Queue.offer(source, envelope(firstChatId, "private event payload"));
            yield* Effect.promise(() => reported.promise);
          }
          yield* Scope.close(routeScope, Exit.void);
          yield* Scope.close(routerScope, Exit.void);
          const errors = records.filter((record) => record.level === "ERROR");
          assert.strictEqual(errors.length, failureAt === "shutdown" ? 0 : 1);
          if (failureAt === "filter") {
            assert.strictEqual(errors[0]?.annotations.chatId, firstChatId);
            assert.strictEqual(errors[0]?.annotations.eventType, "notice");
          }
          assert.notInclude(JSON.stringify(records), "private");
        }).pipe(Effect.provide(logger));
      }
    }),
  );
});
