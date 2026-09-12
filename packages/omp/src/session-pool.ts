import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session-events";
import type * as AgentEvent from "@pico/contract/agent-event";
import type * as AgentMessage from "@pico/contract/agent-message";
import type {
  CapturedAgentRun,
  ContextUsage,
  ShakeMode,
  ShakeResult,
} from "@pico/contract/agent-runtime";
import type * as Chat from "@pico/contract/chat-model";
import { AgentError } from "@pico/contract/errors";
import type { ScheduleRunId } from "@pico/contract/schedule";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as MutableRef from "effect/MutableRef";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as RcMap from "effect/RcMap";
import * as Result from "effect/Result";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { agentError } from "./agent-error.ts";

type OmpAssistantMessage = Extract<
  Extract<AgentSessionEvent, { readonly type: "message_end" }>["message"],
  { readonly role: "assistant" }
>;

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
  readonly appendAssistantMessage: (message: OmpAssistantMessage) => Promise<void>;
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
  readonly sendCaptured: (
    chatId: Chat.ChatId,
    runId: ScheduleRunId,
    prompt: AgentMessage.AgentPrompt,
    onEvent: (event: AgentEvent.AgentEvent) => Effect.Effect<void, AgentError>,
  ) => Effect.Effect<CapturedAgentRun, AgentError>;
  readonly deliver: (chatId: Chat.ChatId, content: string) => Effect.Effect<void>;
  readonly publish: (chatId: Chat.ChatId, content: string) => Effect.Effect<void, AgentError>;
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
type CaptureHandler = (event: AgentEvent.AgentEvent) => Effect.Effect<void>;
interface ActiveCapture {
  readonly runId: ScheduleRunId;
  readonly onEvent: CaptureHandler;
}
type RunOutcome = Extract<AgentEvent.AgentEvent, { readonly type: "run-finished" }>["outcome"];
interface OrdinaryRun {
  phase:
    | { readonly type: "sending"; outcome: RunOutcome | undefined }
    | { readonly type: "accepted" | "rejected" | "finished" };
}
type SessionItem =
  | {
      readonly kind: "event";
      readonly event: AgentEvent.AgentEvent;
      readonly ordinaryRun: OrdinaryRun | null;
    }
  | { readonly kind: "barrier"; readonly completed: Deferred.Deferred<void> };

interface LiveEntry {
  readonly chatId: Chat.ChatId;
  readonly session: SessionHandle;
  readonly sendPrompt: (prompt: AgentMessage.AgentPrompt) => Promise<void>;
  readonly shake: (mode: ShakeMode) => Promise<ShakeResult>;
  readonly contextUsage: () => ContextUsage;
  readonly appendAssistantMessage: (message: OmpAssistantMessage) => Promise<void>;
  readonly events: Queue.Queue<SessionItem, Cause.Done>;
  readonly forwarder: Fiber.Fiber<void>;
  readonly lifecycle: MutableRef.MutableRef<LiveLifecycle>;
  readonly capture: MutableRef.MutableRef<ActiveCapture | null>;
  readonly ordinaryRun: MutableRef.MutableRef<OrdinaryRun | null>;
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
    catch: (cause) => cause,
  }).pipe(
    Effect.catch((cause) =>
      cause instanceof Error && cause.name === "AbortError"
        ? Effect.interrupt
        : Effect.fail(agentError(message, cause)),
    ),
  );

const attemptCleanup = <A, E, R>(
  chatId: Chat.ChatId,
  phase: string,
  effect: Effect.Effect<A, E, R>,
) =>
  effect.pipe(
    Effect.asVoid,
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.interrupt
        : Effect.logError("OMP cleanup failed").pipe(
            Effect.annotateLogs({
              component: "omp",
              operation: "cleanup",
              chatId,
              phase,
              failureKind: Cause.hasDies(cause) ? "defect" : "operation",
            }),
          ),
    ),
  );

const finishOrdinaryRun = (chatId: Chat.ChatId, outcome: RunOutcome) =>
  (outcome === "failed"
    ? Effect.logError("OMP run failed")
    : Effect.logDebug("OMP run finished")
  ).pipe(
    Effect.annotateLogs({ component: "omp", operation: "run", chatId, outcome, mode: "ordinary" }),
  );

const drainSessionEvents = Effect.fn("SessionPool.drainSessionEvents")(function* (
  entry: LiveEntry,
) {
  const completed = yield* Deferred.make<void>();
  const accepted = yield* Queue.offer(entry.events, { kind: "barrier", completed });
  if (!accepted) return yield* new AgentError({ message: "OMP session event queue is closed" });
  yield* Deferred.await(completed);
});

const closeEntry = Effect.fn("SessionPool.closeEntry")(function* (entry: LiveEntry) {
  const lifecycle = MutableRef.get(entry.lifecycle);
  if (lifecycle.type === "closed") return;

  let firstFailure: AgentError | undefined;
  const capture = (phase: string, effect: Effect.Effect<void, AgentError>) =>
    effect.pipe(
      Effect.catch((error) => {
        if (firstFailure !== undefined) {
          return attemptCleanup(entry.chatId, phase, Effect.fail(error));
        }
        firstFailure = error;
        return Effect.void;
      }),
    );

  if (lifecycle.type === "open") {
    MutableRef.set(entry.lifecycle, { type: "closing" });
    yield* capture(
      "begin-dispose",
      Effect.try({
        try: () => entry.session.beginDispose(),
        catch: (cause) => agentError("Failed to begin OMP session disposal", cause),
      }).pipe(Effect.asVoid),
    );
    yield* capture(
      "unsubscribe",
      Effect.try({
        try: lifecycle.unsubscribe,
        catch: (cause) => agentError("Failed to unsubscribe from OMP session events", cause),
      }).pipe(Effect.asVoid),
    );
    yield* capture(
      "end-queue",
      Effect.try({
        try: () => Queue.endUnsafe(entry.events),
        catch: (cause) => agentError("Failed to end OMP session event queue", cause),
      }).pipe(Effect.asVoid),
    );
    yield* Fiber.await(entry.forwarder);
  }

  yield* capture(
    "dispose",
    boundary("Failed to dispose OMP session", () => entry.session.dispose()),
  );
  MutableRef.set(entry.lifecycle, { type: "closed" });
  yield* Effect.logDebug("OMP session closed").pipe(
    Effect.annotateLogs({
      component: "omp",
      operation: "session-close",
      chatId: entry.chatId,
      outcome: firstFailure === undefined ? "completed" : "failed",
    }),
  );
  if (firstFailure !== undefined) return yield* firstFailure;
}, Effect.uninterruptible);

const releaseEntry = (entry: LiveEntry) =>
  attemptCleanup(entry.chatId, "release", closeEntry(entry));

const acquireEntry = Effect.fn("SessionPool.acquireEntry")(function* (
  factory: SessionFactory,
  output: Queue.Queue<OutputItem, Cause.Done>,
  chatId: Chat.ChatId,
) {
  const capture = MutableRef.make<ActiveCapture | null>(null);
  const ordinaryRun = MutableRef.make<OrdinaryRun | null>(null);
  const events = yield* Queue.unbounded<SessionItem, Cause.Done>();
  const opened = yield* factory.open(chatId, (event) => {
    Queue.offerUnsafe(events, { kind: "event", event, ordinaryRun: MutableRef.get(ordinaryRun) });
  });
  const forwarder = yield* Stream.fromQueue(events).pipe(
    Stream.runForEach((item) =>
      Effect.gen(function* () {
        if (item.kind === "barrier") return yield* Deferred.succeed(item.completed, undefined);
        const handler = MutableRef.get(capture);
        if (handler !== null && item.event.type !== "title-changed") {
          yield* handler.onEvent(item.event);
          return;
        }
        if (handler === null && item.event.type === "run-finished") {
          const run = item.ordinaryRun;
          if (run?.phase.type === "sending") run.phase.outcome = item.event.outcome;
          else if (run?.phase.type === "accepted") {
            run.phase = { type: "finished" };
            if (MutableRef.get(ordinaryRun) === run) MutableRef.set(ordinaryRun, null);
            yield* finishOrdinaryRun(chatId, item.event.outcome);
          }
        }
        yield* Queue.offer(output, { kind: "event", envelope: { chatId, event: item.event } });
      }),
    ),
    Effect.asVoid,
    Effect.tapCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.void
        : Effect.logError("OMP session event forwarder stopped unexpectedly").pipe(
            Effect.annotateLogs({
              component: "omp",
              operation: "event-forwarder",
              chatId,
              runId: MutableRef.get(capture)?.runId,
              failureKind: "defect",
            }),
          ),
    ),
    Effect.forkDetach,
  );

  yield* Effect.logDebug("OMP session opened").pipe(
    Effect.annotateLogs({ component: "omp", operation: "session-open", chatId }),
  );
  return {
    chatId,
    session: opened.session,
    sendPrompt: opened.sendPrompt,
    shake: opened.shake,
    appendAssistantMessage: opened.appendAssistantMessage,
    contextUsage: opened.contextUsage,
    events,
    forwarder,
    lifecycle: MutableRef.make<LiveLifecycle>({
      type: "open",
      unsubscribe: opened.unsubscribe,
    }),
    capture,
    ordinaryRun,
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
    yield* Effect.yieldNow;
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
        const run: OrdinaryRun = { phase: { type: "sending", outcome: undefined } };
        MutableRef.set(entry.ordinaryRun, run);
        yield* Effect.logDebug("OMP run started").pipe(
          Effect.annotateLogs({
            component: "omp",
            operation: "run",
            chatId,
            mode: "ordinary",
            attachmentCount: prompt.attachments.length,
          }),
        );
        yield* Effect.gen(function* () {
          yield* boundary("Failed to send OMP prompt", () => entry.sendPrompt(prompt));
          yield* drainSessionEvents(entry);
          if (run.phase.type !== "sending") return;
          const outcome = run.phase.outcome;
          if (outcome === undefined) {
            run.phase = { type: "accepted" };
          } else {
            run.phase = { type: "finished" };
            if (MutableRef.get(entry.ordinaryRun) === run) MutableRef.set(entry.ordinaryRun, null);
            yield* finishOrdinaryRun(chatId, outcome);
          }
        }).pipe(
          Effect.onExit((exit) => {
            if (Exit.isFailure(exit)) {
              run.phase = { type: "rejected" };
              if (MutableRef.get(entry.ordinaryRun) === run)
                MutableRef.set(entry.ordinaryRun, null);
              return Effect.logDebug("OMP prompt ended before accepting a run").pipe(
                Effect.annotateLogs({
                  component: "omp",
                  operation: "run",
                  chatId,
                  mode: "ordinary",
                  outcome: Cause.hasInterruptsOnly(exit.cause) ? "interrupted" : "rejected",
                }),
              );
            }
            return Effect.void;
          }),
        );
      }),
    );
  });
  const sendCaptured = Effect.fn("AgentRuntime.sendCaptured")(function* (
    chatId: Chat.ChatId,
    runId: ScheduleRunId,
    prompt: AgentMessage.AgentPrompt,
    onEvent: (event: AgentEvent.AgentEvent) => Effect.Effect<void, AgentError>,
  ) {
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const entry = yield* retain(sessions, chatId);
        if (MutableRef.get(entry.capture) !== null) {
          return yield* new AgentError({ message: "A captured OMP run is already active" });
        }
        yield* drainSessionEvents(entry);
        const terminal = yield* Deferred.make<CapturedAgentRun, AgentError>();
        const capturedEvents: Array<AgentEvent.AgentEvent> = [];
        let assistantText = "";
        const handler: CaptureHandler = (event) =>
          Effect.gen(function* () {
            capturedEvents.push(event);
            if (event.type === "message-settled" && event.message.role === "assistant") {
              assistantText = event.message.content
                .filter((block) => block.type === "text")
                .map((block) => block.text)
                .join("");
            }
            const sink = yield* onEvent(event).pipe(Effect.result);
            if (Result.isFailure(sink)) {
              yield* Deferred.fail(terminal, sink.failure);
              return;
            }
            if (event.type === "run-finished") {
              yield* Deferred.succeed(terminal, {
                runId,
                outcome: event.outcome,
                events: [...capturedEvents],
                finalAssistantText: assistantText,
              });
            }
          });
        MutableRef.set(entry.capture, { runId, onEvent: handler });
        yield* Effect.logDebug("Captured OMP run started").pipe(
          Effect.annotateLogs({
            component: "omp",
            operation: "run",
            chatId,
            runId,
            mode: "captured",
          }),
        );
        return yield* Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            const terminalFailure = Deferred.await(terminal).pipe(
              Effect.flatMap(() => Effect.never),
            );
            const completed = yield* restore(
              Effect.gen(function* () {
                yield* Effect.raceFirst(
                  boundary("Failed to send captured OMP prompt", () => entry.sendPrompt(prompt)),
                  terminalFailure,
                );
                const result = yield* Deferred.await(terminal);
                yield* boundary("Failed to settle captured OMP persistence", () =>
                  entry.session.settleInFlightMessagePersistence(),
                );
                return result;
              }),
            ).pipe(Effect.exit);
            if (Exit.isFailure(completed)) {
              yield* attemptCleanup(
                chatId,
                "capture-abort",
                boundary("Failed to abort captured OMP run", () =>
                  entry.session.abort({
                    goalReason: Cause.hasInterruptsOnly(completed.cause)
                      ? "interrupted"
                      : "internal",
                    reason: Cause.hasInterruptsOnly(completed.cause)
                      ? "Scheduled run interrupted"
                      : "Scheduled run capture failed",
                  }),
                ),
              ).pipe(Effect.annotateLogs({ runId }), Effect.exit);
              yield* attemptCleanup(chatId, "capture-drain", drainSessionEvents(entry)).pipe(
                Effect.annotateLogs({ runId }),
                Effect.exit,
              );
              MutableRef.set(entry.capture, null);
              yield* Effect.logDebug("Captured OMP run stopped").pipe(
                Effect.annotateLogs({
                  component: "omp",
                  operation: "run",
                  chatId,
                  runId,
                  mode: "captured",
                  outcome: Cause.hasInterruptsOnly(completed.cause) ? "interrupted" : "rejected",
                }),
              );
              return yield* completed;
            }
            MutableRef.set(entry.capture, null);
            yield* Effect.logDebug("Captured OMP run finished").pipe(
              Effect.annotateLogs({
                component: "omp",
                operation: "run",
                chatId,
                runId,
                mode: "captured",
                outcome: completed.value.outcome,
              }),
            );
            return yield* completed;
          }),
        );
      }),
    );
  });

  const deliverEvents = Effect.fn("AgentRuntime.deliverEvents")(function* (
    chatId: Chat.ChatId,
    content: string,
    timestamp: number,
  ) {
    const events: ReadonlyArray<AgentEvent.AgentEvent> = [
      { type: "run-started" },
      {
        type: "message-settled",
        message: {
          role: "assistant",
          status: "completed",
          stopReason: "stop",
          content: [{ type: "text", text: content }],
          model: "pico/schedule",
          timestamp,
        },
      },
      { type: "run-finished", outcome: "completed" },
    ];
    for (const event of events) {
      yield* Queue.offer(output, { kind: "event", envelope: { chatId, event } }).pipe(
        Effect.asVoid,
      );
    }
  });

  const deliver = Effect.fn("AgentRuntime.deliver")(function* (
    chatId: Chat.ChatId,
    content: string,
  ) {
    const timestamp = yield* Clock.currentTimeMillis;
    yield* deliverEvents(chatId, content, timestamp);
  });

  const publish = Effect.fn("AgentRuntime.publish")(function* (
    chatId: Chat.ChatId,
    content: string,
  ) {
    const timestamp = yield* Clock.currentTimeMillis;
    const message: OmpAssistantMessage = {
      role: "assistant",
      content: [{ type: "text", text: content }],
      api: "pico",
      provider: "pico",
      model: "schedule",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp,
    };
    yield* Effect.scoped(
      Effect.gen(function* () {
        const entry = yield* retain(sessions, chatId);
        yield* boundary("Failed to persist scheduled publication", () =>
          entry.appendAssistantMessage(message),
        );
      }),
    );
    yield* deliverEvents(chatId, content, timestamp);
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
          catch: (cause) => agentError("Failed to read OMP context", cause),
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
    sendCaptured,
    deliver,
    publish,
    close,
    abort,
    contextUsage,
    shake,
  } satisfies SessionPool;
});
