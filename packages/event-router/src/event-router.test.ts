import { assert, describe, it } from "@effect/vitest";
import type { AgentEventEnvelope } from "@pico/contract/agent-event";
import { AgentRuntime } from "@pico/contract/agent-runtime";
import * as Chat from "@pico/contract/chat-model";
import { type EventRoute, EventRouter } from "@pico/contract/event-router";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
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

const take = (route: EventRoute) =>
  route.events.pipe(Stream.runHead, Effect.map(Option.getOrThrow));

describe("EventRouter", () => {
  it.effect("routes trusted filters and owns route and pump lifecycles", () =>
    Effect.gen(function* () {
      const source = yield* Queue.unbounded<AgentEventEnvelope>();
      const pumpStopped = yield* Deferred.make<void>();
      const runtimeLayer = Layer.succeed(
        AgentRuntime,
        AgentRuntime.of({
          events: Stream.fromQueue(source).pipe(
            Stream.ensuring(Deferred.succeed(pumpStopped, undefined)),
          ),
          transcript: () => Effect.die("unused"),
          send: () => Effect.die("unused"),
          abort: () => Effect.die("unused"),
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

      const shared = envelope(firstChatId, "shared");
      yield* Queue.offer(source, shared);
      assert.deepStrictEqual(yield* take(firstRoute), shared);
      assert.deepStrictEqual(yield* take(secondRoute), shared);

      const afterNonmatch = envelope(firstChatId, "after-nonmatch");
      yield* Queue.offer(source, envelope(thirdChatId, "excluded"));
      yield* Queue.offer(source, afterNonmatch);
      assert.deepStrictEqual(yield* take(firstRoute), afterNonmatch);
      assert.deepStrictEqual(yield* take(secondRoute), afterNonmatch);

      yield* firstRoute.setFilter((event) => event.chatId === secondChatId);
      const oldFilterMatch = envelope(firstChatId, "old-filter");
      const newFilterMatch = envelope(secondChatId, "new-filter");
      yield* Queue.offer(source, oldFilterMatch);
      yield* Queue.offer(source, newFilterMatch);
      assert.deepStrictEqual(yield* take(firstRoute), newFilterMatch);
      assert.deepStrictEqual(yield* take(secondRoute), oldFilterMatch);

      yield* Scope.close(firstRouteScope, Exit.void);
      yield* Queue.offer(source, envelope(secondChatId, "after-route-release"));
      const routeReleaseSentinel = envelope(firstChatId, "route-release-sentinel");
      yield* Queue.offer(source, routeReleaseSentinel);
      assert.deepStrictEqual(yield* take(secondRoute), routeReleaseSentinel);
      assert.isTrue(Exit.isFailure(yield* firstRoute.events.pipe(Stream.runHead, Effect.exit)));

      yield* Scope.close(secondRouteScope, Exit.void);
      yield* Scope.close(routerScope, Exit.void);
      yield* Deferred.await(pumpStopped);
      const afterRouterRelease = envelope(firstChatId, "after-router-release");
      yield* Queue.offer(source, afterRouterRelease);
      assert.strictEqual(yield* Queue.size(source), 1);
      assert.deepStrictEqual(yield* Queue.take(source), afterRouterRelease);
    }),
  );
});
