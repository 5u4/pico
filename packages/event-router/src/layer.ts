import type { AgentEventEnvelope } from "@pico/contract/agent-event";
import { AgentRuntime } from "@pico/contract/agent-runtime";
import { type EventFilter, type EventRoute, EventRouter } from "@pico/contract/event-router";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as MutableRef from "effect/MutableRef";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

type RouteItem =
  | { readonly kind: "event"; readonly envelope: AgentEventEnvelope }
  | { readonly kind: "drain"; readonly completed: Deferred.Deferred<void> };

interface RouteState {
  readonly filter: MutableRef.MutableRef<EventFilter>;
  readonly output: Queue.Queue<RouteItem, Cause.Done>;
  readonly drains: Set<Deferred.Deferred<void>>;
  closed: boolean;
}

const make = Effect.fn("EventRouter.make")(function* () {
  const runtime = yield* AgentRuntime;
  const routes = yield* Ref.make<ReadonlyArray<RouteState>>([]);
  const ended = yield* Deferred.make<void>();
  let dispatching: AgentEventEnvelope | undefined;
  let alive = true;

  const dispatch = Effect.fn("EventRouter.dispatch")(function* (envelope: AgentEventEnvelope) {
    const activeRoutes = yield* Ref.get(routes);
    dispatching = envelope;

    for (const route of activeRoutes) {
      if (MutableRef.get(route.filter)(envelope)) {
        yield* Queue.offer(route.output, { kind: "event", envelope });
      }
    }
    dispatching = undefined;
  });

  yield* runtime.events.pipe(
    Stream.runForEach(dispatch),
    Effect.onExit((exit) =>
      Effect.gen(function* () {
        alive = false;
        yield* Deferred.succeed(ended, undefined);
        const active = yield* Ref.get(routes);
        yield* Effect.forEach(
          active,
          (route) =>
            Effect.gen(function* () {
              route.closed = true;
              yield* Queue.end(route.output);
              yield* Effect.forEach(route.drains, (drain) => Deferred.succeed(drain, undefined), {
                discard: true,
              });
              route.drains.clear();
            }),
          { discard: true },
        );
        if (Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)) return;
        yield* Effect.logError("Event router pump stopped unexpectedly").pipe(
          Effect.annotateLogs({
            component: "event-router",
            operation: "pump",
            phase: dispatching === undefined ? "upstream" : "dispatch",
            chatId: dispatching?.chatId,
            eventType: dispatching?.event.type,
            failureKind: Exit.isSuccess(exit) ? "unexpected-end" : "defect",
          }),
        );
      }),
    ),
    Effect.forkScoped({ startImmediately: true }),
  );

  const open = Effect.fn("EventRouter.open")(function* (
    initialFilter: EventFilter,
  ): Effect.fn.Return<EventRoute, never, Scope.Scope> {
    const filter = MutableRef.make(initialFilter);
    const output = yield* Queue.unbounded<RouteItem, Cause.Done>();
    const state: RouteState = { filter, output, drains: new Set(), closed: false };

    yield* Effect.acquireRelease(
      Ref.update(routes, (activeRoutes) => {
        if (!alive) throw new Error("Event router producer is unavailable");
        return [...activeRoutes, state];
      }),
      () =>
        Ref.update(routes, (activeRoutes) => activeRoutes.filter((route) => route !== state)).pipe(
          Effect.andThen(
            Effect.gen(function* () {
              const drains = yield* Effect.sync(() => {
                state.closed = true;
                const drains = Array.from(state.drains);
                state.drains.clear();
                return drains;
              });
              yield* Effect.forEach(drains, (drain) => Deferred.succeed(drain, undefined), {
                discard: true,
              });
              yield* Queue.end(output);
            }),
          ),
        ),
    );

    return {
      events: Stream.fromQueue(output).pipe(
        Stream.filterMapEffect((item) => {
          if (item.kind === "event") return Effect.succeed(Result.succeed(item.envelope));
          return Effect.sync(() => state.drains.delete(item.completed)).pipe(
            Effect.andThen(Deferred.succeed(item.completed, undefined)),
            Effect.as(Result.failVoid),
          );
        }),
      ),
      setFilter: (nextFilter) =>
        Effect.sync(() => {
          MutableRef.set(filter, nextFilter);
        }),
    };
  });

  const drain = Effect.fn("EventRouter.drain")(function* () {
    if (!alive) return yield* Effect.die(new Error("Event router producer is unavailable"));
    yield* Effect.raceFirst(
      runtime.drain(),
      Deferred.await(ended).pipe(
        Effect.andThen(Effect.die(new Error("Event router producer ended during drain"))),
      ),
    );
    const activeRoutes = yield* Ref.get(routes);
    const completed = yield* Effect.forEach(activeRoutes, (route) =>
      Effect.gen(function* () {
        const completed = yield* Deferred.make<void>();
        const registered = yield* Effect.sync(() => {
          if (route.closed) return false;
          route.drains.add(completed);
          return true;
        });
        if (!registered) {
          yield* Deferred.succeed(completed, undefined);
          return completed;
        }
        const accepted = yield* Queue.offer(route.output, { kind: "drain", completed });
        if (!accepted) {
          yield* Effect.sync(() => route.drains.delete(completed));
          yield* Deferred.succeed(completed, undefined);
        }
        return completed;
      }),
    );
    yield* Effect.forEach(completed, (deferred) => Deferred.await(deferred), { discard: true });
  });

  return EventRouter.of({ open, drain });
});

export const layer = Layer.effect(EventRouter, make());
