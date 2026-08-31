import type { AgentEventEnvelope } from "@pico/contract/agent-event";
import { AgentRuntime } from "@pico/contract/agent-runtime";
import { type EventFilter, type EventRoute, EventRouter } from "@pico/contract/event-router";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as MutableRef from "effect/MutableRef";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

interface RouteState {
  readonly filter: MutableRef.MutableRef<EventFilter>;
  readonly output: Queue.Queue<AgentEventEnvelope>;
}

const make = Effect.fn("EventRouter.make")(function* () {
  const runtime = yield* AgentRuntime;
  const routes = yield* Ref.make<ReadonlyArray<RouteState>>([]);

  const dispatch = Effect.fn("EventRouter.dispatch")(function* (envelope: AgentEventEnvelope) {
    const activeRoutes = yield* Ref.get(routes);

    for (const route of activeRoutes) {
      if (MutableRef.get(route.filter)(envelope)) {
        yield* Queue.offer(route.output, envelope);
      }
    }
  });

  yield* runtime.events.pipe(
    Stream.runForEach(dispatch),
    Effect.forkScoped({ startImmediately: true }),
  );

  const open = Effect.fn("EventRouter.open")(function* (
    initialFilter: EventFilter,
  ): Effect.fn.Return<EventRoute, never, Scope.Scope> {
    const filter = MutableRef.make(initialFilter);
    const output = yield* Queue.unbounded<AgentEventEnvelope>();
    const state: RouteState = { filter, output };

    yield* Effect.acquireRelease(
      Ref.update(routes, (activeRoutes) => [...activeRoutes, state]),
      () =>
        Ref.update(routes, (activeRoutes) => activeRoutes.filter((route) => route !== state)).pipe(
          Effect.andThen(Queue.shutdown(output)),
        ),
    );

    return {
      events: Stream.fromQueue(output),
      setFilter: (nextFilter) =>
        Effect.sync(() => {
          MutableRef.set(filter, nextFilter);
        }),
    };
  });

  return EventRouter.of({ open });
});

export const layer = Layer.effect(EventRouter, make());
