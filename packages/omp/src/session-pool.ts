import type * as AgentEvent from "@pico/contract/agent-event";
import type * as AgentMessage from "@pico/contract/agent-message";
import type { ContextUsage, ShakeMode, ShakeResult } from "@pico/contract/agent-runtime";
import type * as Chat from "@pico/contract/chat-model";
import { AgentError } from "@pico/contract/errors";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as MutableRef from "effect/MutableRef";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as RcMap from "effect/RcMap";
import * as Result from "effect/Result";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

export interface SessionHandle {
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
  readonly sendPrompt: (prompt: AgentMessage.AgentPrompt) => Promise<void>;
  readonly shake: (mode: ShakeMode) => Promise<ShakeResult>;
  readonly contextUsage: () => ContextUsage;
  readonly unsubscribe: () => void;
}

export interface SessionFactory {
  readonly open: (
    chatId: Chat.ChatId,
    emit: (event: AgentEvent.AgentEvent) => void,
  ) => Effect.Effect<OpenedSession, AgentError>;
}

export interface SessionPool {
  readonly events: Stream.Stream<AgentEvent.AgentEventEnvelope>;
  readonly drain: () => Effect.Effect<void>;
  readonly transcript: (
    chatId: Chat.ChatId,
  ) => Effect.Effect<AgentMessage.AgentTranscript, AgentError>;
  readonly send: (
    chatId: Chat.ChatId,
    prompt: AgentMessage.AgentPrompt,
  ) => Effect.Effect<void, AgentError>;
  readonly close: (chatId: Chat.ChatId) => Effect.Effect<void, AgentError>;
  readonly abort: (chatId: Chat.ChatId) => Effect.Effect<void, AgentError>;
  readonly contextUsage: (chatId: Chat.ChatId) => Effect.Effect<ContextUsage, AgentError>;
  readonly shake: (chatId: Chat.ChatId, mode: ShakeMode) => Effect.Effect<ShakeResult, AgentError>;
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
  readonly sendPrompt: (prompt: AgentMessage.AgentPrompt) => Promise<void>;
  readonly shake: (mode: ShakeMode) => Promise<ShakeResult>;
  readonly contextUsage: () => ContextUsage;
  readonly events: Queue.Queue<AgentEvent.AgentEvent, Cause.Done>;
  readonly forwarder: Fiber.Fiber<void>;
  readonly lifecycle: MutableRef.MutableRef<LiveLifecycle>;
}

interface MakeOptions {
  readonly factory: SessionFactory;
  readonly loadTranscript: (
    chatId: Chat.ChatId,
  ) => Effect.Effect<AgentMessage.AgentTranscript, AgentError>;
}

type OutputItem =
  | { readonly kind: "event"; readonly envelope: AgentEvent.AgentEventEnvelope }
  | { readonly kind: "drain"; readonly completed: Deferred.Deferred<void> };

const boundary = <A>(message: string, evaluate: () => Promise<A>) =>
  Effect.tryPromise({
    try: evaluate,
    catch: () => new AgentError({ message }),
  });

const attemptCleanup = <A, E, R>(message: string, effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.asVoid,
    Effect.catchCause((cause) => Effect.logError(message, Cause.pretty(cause))),
  );

const closeEntry = Effect.fn("SessionPool.closeEntry")(function* (entry: LiveEntry) {
  const lifecycle = MutableRef.get(entry.lifecycle);
  if (lifecycle.type === "closed") return;

  let firstFailure: AgentError | undefined;
  const capture = (effect: Effect.Effect<void, AgentError>) =>
    effect.pipe(
      Effect.catch((error) =>
        Effect.sync(() => {
          firstFailure ??= error;
        }),
      ),
    );

  if (lifecycle.type === "open") {
    MutableRef.set(entry.lifecycle, { type: "closing" });
    yield* capture(
      Effect.try({
        try: () => entry.session.beginDispose(),
        catch: () => new AgentError({ message: "Failed to begin OMP session disposal" }),
      }).pipe(Effect.asVoid),
    );
    yield* capture(
      Effect.try({
        try: lifecycle.unsubscribe,
        catch: () => new AgentError({ message: "Failed to unsubscribe from OMP session events" }),
      }).pipe(Effect.asVoid),
    );
    yield* capture(
      Effect.try({
        try: () => Queue.endUnsafe(entry.events),
        catch: () => new AgentError({ message: "Failed to end OMP session event queue" }),
      }).pipe(Effect.asVoid),
    );
    yield* capture(
      Fiber.join(entry.forwarder).pipe(
        Effect.asVoid,
        Effect.catchCause(() =>
          Effect.fail(new AgentError({ message: "Failed to drain OMP session events" })),
        ),
      ),
    );
  }

  let disposed = false;
  yield* capture(
    boundary("Failed to dispose OMP session", () => entry.session.dispose()).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          disposed = true;
        }),
      ),
    ),
  );
  if (disposed) MutableRef.set(entry.lifecycle, { type: "closed" });
  if (firstFailure !== undefined) return yield* firstFailure;
}, Effect.uninterruptible);

const releaseEntry = (entry: LiveEntry) =>
  attemptCleanup("Failed to close OMP session", closeEntry(entry));

const acquireEntry = Effect.fn("SessionPool.acquireEntry")(function* (
  factory: SessionFactory,
  output: Queue.Queue<OutputItem, Cause.Done>,
  chatId: Chat.ChatId,
) {
  const events = yield* Queue.unbounded<AgentEvent.AgentEvent, Cause.Done>();
  const opened = yield* factory.open(chatId, (event) => {
    Queue.offerUnsafe(events, event);
  });
  const forwarder = yield* Stream.fromQueue(events).pipe(
    Stream.runForEach((event) =>
      Queue.offer(output, { kind: "event", envelope: { chatId, event } }),
    ),
    Effect.asVoid,
    Effect.forkDetach,
  );

  return {
    session: opened.session,
    sendPrompt: opened.sendPrompt,
    shake: opened.shake,
    contextUsage: opened.contextUsage,
    events,
    forwarder,
    lifecycle: MutableRef.make<LiveLifecycle>({
      type: "open",
      unsubscribe: opened.unsubscribe,
    }),
  } satisfies LiveEntry;
}, Effect.uninterruptible);

const retain = (sessions: RcMap.RcMap<Chat.ChatId, LiveEntry, AgentError>, chatId: Chat.ChatId) =>
  RcMap.get(sessions, chatId).pipe(
    Effect.catch((error) =>
      RcMap.invalidate(sessions, chatId).pipe(Effect.andThen(Effect.fail(error))),
    ),
  );

const retainOption = (
  sessions: RcMap.RcMap<Chat.ChatId, LiveEntry, AgentError>,
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
  const output = yield* Effect.acquireRelease(Queue.unbounded<OutputItem, Cause.Done>(), (queue) =>
    Queue.end(queue).pipe(Effect.asVoid),
  );
  const sessions = yield* RcMap.make({
    lookup: (chatId: Chat.ChatId) =>
      Effect.acquireRelease(acquireEntry(options.factory, output, chatId), releaseEntry),
    idleTimeToLive: "10 minutes",
  });
  const closeFailures = new Map<Chat.ChatId, AgentError>();
  const drain = Effect.fn("AgentRuntime.drain")(function* () {
    const completed = yield* Deferred.make<void>();
    const accepted = yield* Queue.offer(output, { kind: "drain", completed });
    if (accepted) yield* Deferred.await(completed);
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
    prompt: AgentMessage.AgentPrompt,
  ) {
    yield* Effect.scoped(
      Effect.gen(function* () {
        const entry = yield* retain(sessions, chatId);
        yield* boundary("Failed to send OMP prompt", () => entry.sendPrompt(prompt));
      }),
    );
  });

  const close = Effect.fn("AgentRuntime.close")(function* (chatId: Chat.ChatId) {
    const previousFailure = closeFailures.get(chatId);
    if (previousFailure !== undefined) return yield* previousFailure;

    yield* Effect.scoped(
      Effect.gen(function* () {
        const entry = yield* retainOption(sessions, chatId);
        if (Option.isSome(entry)) yield* closeEntry(entry.value);
      }),
    ).pipe(
      Effect.tapError((error) =>
        Effect.sync(() => {
          closeFailures.set(chatId, error);
        }),
      ),
    );
    yield* RcMap.invalidate(sessions, chatId);
  });

  const contextUsage = Effect.fn("AgentRuntime.contextUsage")(function* (chatId: Chat.ChatId) {
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const entry = yield* retain(sessions, chatId);
        return yield* Effect.try({
          try: entry.contextUsage,
          catch: () => new AgentError({ message: "Failed to read OMP context" }),
        });
      }),
    );
  });

  const shake = Effect.fn("AgentRuntime.shake")(function* (chatId: Chat.ChatId, mode: ShakeMode) {
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const entry = yield* retain(sessions, chatId);
        return yield* boundary("Failed to shake OMP session", () => entry.shake(mode));
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
    events: Stream.fromQueue(output).pipe(
      Stream.filterMapEffect((item) => {
        if (item.kind === "event") return Effect.succeed(Result.succeed(item.envelope));
        return Deferred.succeed(item.completed, undefined).pipe(Effect.as(Result.failVoid));
      }),
    ),
    drain,
    transcript,
    send,
    close,
    abort,
    contextUsage,
    shake,
  } satisfies SessionPool;
});
