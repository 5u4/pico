import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";
import type * as Stream from "effect/Stream";
import type { AgentEventEnvelope } from "./agent-event.ts";

export type EventFilter = (event: AgentEventEnvelope) => boolean;

export interface EventRoute {
  readonly events: Stream.Stream<AgentEventEnvelope>;

  readonly setFilter: (filter: EventFilter) => Effect.Effect<void>;
}

export class EventRouter extends Context.Service<
  EventRouter,
  {
    readonly drain: () => Effect.Effect<void>;
    readonly open: (initialFilter: EventFilter) => Effect.Effect<EventRoute, never, Scope.Scope>;
  }
>()("@pico/contract/event/EventRouter") {}
