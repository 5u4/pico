# Event Router Draft Design

This design is approved but not implemented. `EventRouter` will be a process-scoped service in
`packages/event-router`. Its cross-package schemas and service tag belong in `packages/contract`.

`EventRouter` is the sole consumer of `AgentRuntime.events`. That stream is queue-backed, so direct
web and Discord consumers would compete and each would miss events. The router pumps the stream
into one Effect `PubSub`. Each connection gets an independent subscription.

The first contract stays small:

```ts
interface EventSelection {
  readonly chatIds: ReadonlySet<ChatId>
}

interface EventRoute {
  readonly events: Stream.Stream<AgentEventEnvelope>
  readonly setSelection: (selection: EventSelection) => Effect.Effect<void>
}

class EventRouter {
  readonly open: (
    initial: EventSelection
  ) => Effect.Effect<EventRoute, never, Scope.Scope>
}
```

`open` eagerly acquires one `PubSub` subscription. The route scope owns its release. There is no
`close` method. `setSelection` replaces the active selection atomically instead of merging hidden
state. The initial selection supports `ChatId` only.

Application and `EventRouter` are sibling services. Neither depends on the other. Their only seam
is the `ChatId` returned by Application and carried by `AgentEventEnvelope`:

```text
command path
web or Discord -> Application -> repositories

live event path
AgentRuntime.events -> EventRouter -> per-connection stream -> web or Discord

subscription update
Application.createRegularChat -> Chat.id -> EventRouter.setSelection
```

Web and Discord own protocol decoding, event encoding, connection writes, and connection failure
handling. `packages/rpc` owns the WebSocket transport only. The daemon constructs one shared
`EventRouter` layer and provides that same instance to every transport. The daemon does not pump,
filter, or forward events itself.

Do not put connection state in Application, RPC-specific behavior in `EventRouter`, or multicast
behavior in `AgentRuntime`. Do not add a generic `PicoEvent` union until a second event source
exists. Buffer capacity, overflow behavior, replay, resynchronization, event-type filters, and slow
consumer policy remain open until a real transport provides measured requirements.
