# Event Router Design

This design is approved and implemented. `EventRouter` is a process-scoped service in
`packages/event-router`. Its cross-package types and service tag belong in `packages/contract`.

`EventRouter` is the sole consumer of `AgentRuntime.events`. That stream is queue-backed, so direct
web and Discord consumers would compete and each would miss events. The router eagerly pumps the
stream through a registry of active routes. Each route buffers only events accepted by its current
filter.

The first contract stays small:

```ts
type EventFilter = (event: AgentEventEnvelope) => boolean

interface EventRoute {
  readonly events: Stream.Stream<AgentEventEnvelope>
  readonly setFilter: (filter: EventFilter) => Effect.Effect<void>
}

class EventRouter {
  readonly open: (
    initialFilter: EventFilter
  ) => Effect.Effect<EventRoute, never, Scope.Scope>
}
```

Only trusted server-side platform code supplies filters. Clients receive routed events and cannot
choose or replace filters. Filters are synchronous and must not perform I/O. A filter that needs
mutable platform state closes over state owned by that platform adapter.

`open` eagerly registers one route with an unbounded queue. The route scope removes the route before
shutting down its queue. There is no `close` method. `setFilter` atomically replaces the whole filter
instead of merging hidden state. Events already queued retain the decision made when the router
dispatched them. An event racing with `setFilter` may use either the old or new filter.

The router starts its single `AgentRuntime.events` pump when its layer is acquired. It drains events
even when no routes are open. Each source event reads one snapshot of the route registry, evaluates
each current filter once, and enters only matching route queues. Route queues remain unbounded until
a real transport provides measured capacity and overflow requirements.

Application and `EventRouter` are sibling services. Neither depends on the other. Their only seam
is the `ChatId` returned by Application and carried by `AgentEventEnvelope`:

```text
command path
web or Discord -> Application -> repositories

live event path
AgentRuntime.events -> EventRouter -> per-connection stream -> web or Discord

server-side filter update
platform adapter -> EventRouter.setFilter
```

One physical platform connection opens one `EventRoute` and drains its one aggregate event stream.
The client receives events on that connection and does not control subscription policy. Web and
Discord own protocol decoding, event encoding, connection writes, and connection failure handling.
`packages/rpc` owns the WebSocket transport only. The daemon constructs one shared `EventRouter`
layer and provides that same instance to every transport. The daemon does not pump, filter, or
forward events itself.

Filters can select by `ChatId`, `AgentEvent.type`, or state already owned by a platform adapter.
Do not put connection state in Application, RPC-specific behavior in `EventRouter`, or multicast
behavior in `AgentRuntime`. Do not add a client subscription protocol, structured selection query,
generic `PicoEvent` union, replay, resynchronization, public buffer configuration, or filter index
until a real requirement provides the missing semantics.
