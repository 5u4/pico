import * as Agent from "@pico/contract/agent";
import type * as Chat from "@pico/contract/chat";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as MutableRef from "effect/MutableRef";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as RcMap from "effect/RcMap";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

export interface SessionHandle {
  readonly sendUserMessage: (prompt: Agent.AgentPrompt) => Promise<void>;
  readonly settleInFlightMessagePersistence: () => Promise<void>;
  readonly abort: (options?: {
    readonly goalReason?: "interrupted" | "internal";
    readonly reason?: string;
  }) => Promise<void>;
  readonly beginDispose: () => void;
  readonly dispose: () => Promise<void>;
}

export interface OpenedSession {
  readonly session: SessionHandle;
  readonly unsubscribe: () => void;
}

export interface SessionFactory {
  readonly open: (
    chatId: Chat.ChatId,
    emit: (event: Agent.AgentEvent) => void,
  ) => Effect.Effect<OpenedSession, Agent.AgentError>;
}

export interface SessionPool {
  readonly events: Stream.Stream<Agent.AgentEventEnvelope>;
  readonly transcript: (
    chatId: Chat.ChatId,
  ) => Effect.Effect<Agent.AgentTranscript, Agent.AgentError>;
  readonly send: (
    chatId: Chat.ChatId,
    prompt: Agent.AgentPrompt,
  ) => Effect.Effect<void, Agent.AgentError>;
  readonly abort: (chatId: Chat.ChatId) => Effect.Effect<void, Agent.AgentError>;
}

interface OpenLifecycle {
  readonly type: "open";
  readonly unsubscribe: () => void;
}

interface ClosingLifecycle {
  readonly type: "closing";
}

interface ClosedLifecycle {
  readonly type: "closed";
}

type LiveLifecycle = OpenLifecycle | ClosingLifecycle | ClosedLifecycle;

interface LiveEntry {
  readonly session: SessionHandle;
  readonly events: Queue.Queue<Agent.AgentEvent, Cause.Done>;
  readonly forwarder: Fiber.Fiber<void>;
  readonly lifecycle: MutableRef.MutableRef<LiveLifecycle>;
}

interface MakeOptions {
  readonly factory: SessionFactory;
  readonly loadTranscript: (
    chatId: Chat.ChatId,
  ) => Effect.Effect<Agent.AgentTranscript, Agent.AgentError>;
}

const boundary = <A>(message: string, evaluate: () => Promise<A>) =>
  Effect.tryPromise({
    try: evaluate,
    catch: () => new Agent.AgentError({ message }),
  });

const attemptCleanup = <A, E, R>(message: string, effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.asVoid,
    Effect.catchCause((cause) => Effect.logError(message, Cause.pretty(cause))),
  );

const releaseEntry = Effect.fn("SessionPool.releaseEntry")(function* (entry: LiveEntry) {
  const lifecycle = MutableRef.getAndSet(entry.lifecycle, { type: "closing" });
  if (lifecycle.type !== "open") return;

  yield* attemptCleanup(
    "Failed to begin OMP session disposal",
    Effect.sync(() => entry.session.beginDispose()),
  );
  yield* attemptCleanup(
    "Failed to unsubscribe from OMP session events",
    Effect.sync(lifecycle.unsubscribe),
  );
  yield* attemptCleanup(
    "Failed to end OMP session event queue",
    Effect.sync(() => Queue.endUnsafe(entry.events)),
  );
  yield* attemptCleanup("Failed to drain OMP session events", Fiber.join(entry.forwarder));
  yield* attemptCleanup(
    "Failed to dispose OMP session",
    boundary("Failed to dispose OMP session", () => entry.session.dispose()),
  );

  MutableRef.set(entry.lifecycle, { type: "closed" });
}, Effect.uninterruptible);

const acquireEntry = Effect.fn("SessionPool.acquireEntry")(function* (
  factory: SessionFactory,
  output: Queue.Queue<Agent.AgentEventEnvelope, Cause.Done>,
  chatId: Chat.ChatId,
) {
  const events = yield* Queue.unbounded<Agent.AgentEvent, Cause.Done>();
  const opened = yield* factory.open(chatId, (event) => {
    Queue.offerUnsafe(events, event);
  });
  const forwarder = yield* Stream.fromQueue(events).pipe(
    Stream.runForEach((event) => Queue.offer(output, { chatId, event })),
    Effect.asVoid,
    Effect.forkDetach,
  );

  return {
    session: opened.session,
    events,
    forwarder,
    lifecycle: MutableRef.make<LiveLifecycle>({
      type: "open",
      unsubscribe: opened.unsubscribe,
    }),
  } satisfies LiveEntry;
}, Effect.uninterruptible);

const retain = (
  sessions: RcMap.RcMap<Chat.ChatId, LiveEntry, Agent.AgentError>,
  chatId: Chat.ChatId,
) =>
  RcMap.get(sessions, chatId).pipe(
    Effect.catch((error) =>
      RcMap.invalidate(sessions, chatId).pipe(Effect.andThen(Effect.fail(error))),
    ),
  );

const retainOption = (
  sessions: RcMap.RcMap<Chat.ChatId, LiveEntry, Agent.AgentError>,
  chatId: Chat.ChatId,
) =>
  RcMap.getOption(sessions, chatId).pipe(
    Effect.catch((error) =>
      RcMap.invalidate(sessions, chatId).pipe(Effect.andThen(Effect.fail(error))),
    ),
  );

export const makeSessionPool = Effect.fn("SessionPool.make")(function* (
  options: MakeOptions,
): Effect.fn.Return<SessionPool, never, Scope.Scope> {
  const output = yield* Effect.acquireRelease(
    Queue.unbounded<Agent.AgentEventEnvelope, Cause.Done>(),
    (queue) => Queue.end(queue).pipe(Effect.asVoid),
  );
  const sessions = yield* RcMap.make({
    lookup: (chatId: Chat.ChatId) =>
      Effect.acquireRelease(acquireEntry(options.factory, output, chatId), releaseEntry),
    idleTimeToLive: "10 minutes",
  });

  const transcript = Effect.fn("AgentRuntime.transcript")(function* (chatId: Chat.ChatId) {
    yield* Effect.scoped(
      Effect.gen(function* () {
        const entry = yield* retainOption(sessions, chatId);
        if (Option.isSome(entry)) {
          yield* boundary("Failed to settle OMP transcript persistence", () =>
            entry.value.session.settleInFlightMessagePersistence(),
          );
        }
      }),
    );
    return yield* options.loadTranscript(chatId);
  });

  const send = Effect.fn("AgentRuntime.send")(function* (
    chatId: Chat.ChatId,
    prompt: Agent.AgentPrompt,
  ) {
    yield* Effect.scoped(
      Effect.gen(function* () {
        const entry = yield* retain(sessions, chatId);
        yield* boundary("Failed to send OMP prompt", () => entry.session.sendUserMessage(prompt));
      }),
    );
  });

  const abort = Effect.fn("AgentRuntime.abort")(function* (chatId: Chat.ChatId) {
    yield* Effect.scoped(
      Effect.gen(function* () {
        const entry = yield* retainOption(sessions, chatId);
        if (Option.isSome(entry)) {
          yield* boundary("Failed to abort OMP session", () =>
            entry.value.session.abort({
              goalReason: "interrupted",
              reason: "Interrupted by user",
            }),
          );
        }
      }),
    );
  });

  return {
    events: Stream.fromQueue(output),
    transcript,
    send,
    abort,
  } satisfies SessionPool;
});
