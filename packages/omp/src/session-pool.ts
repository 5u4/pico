import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session-events";
import type * as AgentEvent from "@pico/contract/agent-event";
import type * as AgentMessage from "@pico/contract/agent-message";
import type {
  CapturedAgentRun,
  ContextUsage,
  MessageDelivery,
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
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { agentError } from "./agent-error.ts";
import type { OmpPromptSender } from "./omp-prompt-sender.ts";

type OmpAssistantMessage = Extract<
  Extract<AgentSessionEvent, { readonly type: "message_end" }>["message"],
  { readonly role: "assistant" }
>;

export interface SessionHandle {
  readonly isStreaming: boolean;
  readonly waitForIdle: () => Promise<void>;
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
  readonly sendPrompt: OmpPromptSender;
  readonly askBtw: (question: string, signal: AbortSignal) => Promise<string>;
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
  ) => Effect.Effect<MessageDelivery, AgentError>;
  readonly askBtw: (chatId: Chat.ChatId, question: string) => Effect.Effect<string, AgentError>;
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
  readonly completed: Deferred.Deferred<void, AgentError>;
}

interface ClosedLifecycle {
  readonly type: "closed";
}

type LiveLifecycle = OpenLifecycle | ClosingLifecycle | ClosedLifecycle;
type CaptureHandler = (event: AgentEvent.AgentEvent) => Effect.Effect<void>;
interface ActiveCapture {
  readonly kind: "captured";
  readonly runId: ScheduleRunId;
  readonly onEvent: CaptureHandler;
  readonly released: Deferred.Deferred<void>;
}
type RunFinished = Extract<AgentEvent.AgentEvent, { readonly type: "run-finished" }>;
type RunOutcome = RunFinished["outcome"];
interface OrdinaryRun {
  readonly kind: "ordinary";
  readonly finished: Deferred.Deferred<void>;
  state:
    | { readonly kind: "submitting"; readonly terminal: RunFinished | null }
    | { readonly kind: "streaming" }
    | { readonly kind: "settled"; readonly terminal: RunFinished };
}
type ActiveRun = OrdinaryRun | ActiveCapture;
type SessionItem =
  | {
      readonly kind: "event";
      readonly event: AgentEvent.AgentEvent;
      readonly owner: ActiveRun | null;
    }
  | { readonly kind: "barrier"; readonly completed: Deferred.Deferred<void> };

interface LiveEntry {
  readonly chatId: Chat.ChatId;
  readonly session: SessionHandle;
  readonly sendPrompt: OmpPromptSender;
  readonly askBtw: (question: string, signal: AbortSignal) => Promise<string>;
  readonly shake: (mode: ShakeMode) => Promise<ShakeResult>;
  readonly contextUsage: () => ContextUsage;
  readonly appendAssistantMessage: (message: OmpAssistantMessage) => Promise<void>;
  readonly events: Queue.Queue<SessionItem, Cause.Done>;
  readonly forwarder: Fiber.Fiber<void>;
  readonly lifecycle: MutableRef.MutableRef<LiveLifecycle>;
  readonly capture: MutableRef.MutableRef<ActiveCapture | null>;
  readonly run: MutableRef.MutableRef<ActiveRun | null>;
  readonly admission: Semaphore.Semaphore;
  readonly operations: Set<Deferred.Deferred<void>>;
  readonly closed: Deferred.Deferred<void>;
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

const settleOrdinaryRun = Effect.fn("SessionPool.settleOrdinaryRun")(function* (
  chatId: Chat.ChatId,
  active: MutableRef.MutableRef<ActiveRun | null>,
  run: OrdinaryRun,
) {
  const state = run.state;
  if (state.kind !== "settled") return;
  if (MutableRef.get(active) === run) MutableRef.set(active, null);
  if (yield* Deferred.succeed(run.finished, undefined)) {
    yield* finishOrdinaryRun(chatId, state.terminal.outcome);
  }
});

const drainSessionEvents = Effect.fn("SessionPool.drainSessionEvents")(function* (
  entry: LiveEntry,
) {
  const completed = yield* Deferred.make<void>();
  const accepted = yield* Queue.offer(entry.events, { kind: "barrier", completed });
  if (!accepted) return yield* new AgentError({ message: "OMP session event queue is closed" });
  yield* Effect.raceFirst(
    Deferred.await(completed),
    Fiber.await(entry.forwarder).pipe(
      Effect.flatMap(() =>
        Effect.fail(new AgentError({ message: "OMP session event forwarder is closed" })),
      ),
    ),
  );
});

const closeEntry = Effect.fn("SessionPool.closeEntry")(function* (entry: LiveEntry) {
  const lifecycle = MutableRef.get(entry.lifecycle);
  if (lifecycle.type === "closed") return;
  if (lifecycle.type === "closing") return yield* Deferred.await(lifecycle.completed);
  const closing: ClosingLifecycle = {
    type: "closing",
    completed: Deferred.makeUnsafe<void, AgentError>(),
  };
  MutableRef.set(entry.lifecycle, closing);

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
    yield* capture(
      "begin-dispose",
      Effect.try({
        try: () => entry.session.beginDispose(),
        catch: (cause) => agentError("Failed to begin OMP session disposal", cause),
      }).pipe(Effect.asVoid),
    );
    yield* Deferred.succeed(entry.closed, undefined);
    yield* Effect.forEach(entry.operations, Deferred.await, { discard: true });
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
  yield* Deferred.done(
    closing.completed,
    firstFailure === undefined ? Exit.succeed(undefined) : Exit.fail(firstFailure),
  );
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
  const run = MutableRef.make<ActiveRun | null>(null);
  const events = yield* Queue.unbounded<SessionItem, Cause.Done>();
  const opened = yield* factory.open(chatId, (event) => {
    let owner = MutableRef.get(run);
    if (event.type === "run-started") {
      if (owner === null) {
        owner = {
          kind: "ordinary",
          finished: Deferred.makeUnsafe<void>(),
          state: { kind: "streaming" },
        };
        MutableRef.set(run, owner);
      } else if (owner.kind === "ordinary") {
        owner.state =
          owner.state.kind === "submitting"
            ? { kind: "submitting", terminal: null }
            : { kind: "streaming" };
      }
    }
    if (event.type === "run-finished" && owner !== null) {
      if (owner.kind === "captured") {
        MutableRef.set(run, null);
      } else {
        owner.state =
          owner.state.kind === "submitting"
            ? { kind: "submitting", terminal: event }
            : { kind: "settled", terminal: event };
      }
    }
    Queue.offerUnsafe(events, { kind: "event", event, owner });
  });
  const forwarder = yield* Stream.fromQueue(events).pipe(
    Stream.runForEach((item) =>
      Effect.gen(function* () {
        if (item.kind === "barrier") return yield* Deferred.succeed(item.completed, undefined);
        const owner = item.owner;
        if (owner?.kind === "captured" && item.event.type !== "title-changed") {
          yield* owner.onEvent(item.event);
          return;
        }
        if (owner?.kind === "ordinary" && item.event.type === "run-finished") {
          yield* settleOrdinaryRun(chatId, run, owner);
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
    Effect.ensuring(Queue.end(events)),
    Effect.forkDetach,
  );

  yield* Effect.logDebug("OMP session opened").pipe(
    Effect.annotateLogs({ component: "omp", operation: "session-open", chatId }),
  );
  return {
    chatId,
    session: opened.session,
    sendPrompt: opened.sendPrompt,
    askBtw: opened.askBtw,
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
    run,
    admission: Semaphore.makeUnsafe(1),
    operations: new Set(),
    closed: Deferred.makeUnsafe<void>(),
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
  const scope = yield* Effect.scope;
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

  const askBtw = Effect.fn("AgentRuntime.askBtw")(function* (
    chatId: Chat.ChatId,
    question: string,
  ) {
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const entry = yield* retain(sessions, chatId);
        const controller = new AbortController();
        const finished = yield* Deferred.make<void>();
        return yield* Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            const pending = yield* Effect.acquireUseRelease(
              restore(entry.admission.take(1)),
              () =>
                Effect.try({
                  try: () => {
                    if (MutableRef.get(entry.lifecycle).type !== "open") {
                      throw new AgentError({ message: "OMP session is closing" });
                    }
                    const pending = entry.askBtw(question, controller.signal);
                    entry.operations.add(finished);
                    return pending;
                  },
                  catch: (cause) => agentError("Failed to ask OMP side question", cause),
                }),
              () => entry.admission.release(1),
            );
            return yield* restore(
              boundary("Failed to ask OMP side question", () => pending).pipe(
                Effect.raceFirst(
                  Deferred.await(entry.closed).pipe(Effect.andThen(Effect.interrupt)),
                ),
              ),
            ).pipe(
              Effect.ensuring(
                Effect.gen(function* () {
                  controller.abort();
                  yield* Effect.promise(() =>
                    pending.then(
                      () => undefined,
                      () => undefined,
                    ),
                  );
                  entry.operations.delete(finished);
                  yield* Deferred.succeed(finished, undefined);
                }),
              ),
            );
          }),
        );
      }),
    );
  });

  const send = Effect.fn("AgentRuntime.send")(function* (
    chatId: Chat.ChatId,
    prompt: AgentMessage.AgentPrompt,
  ) {
    const admitted = yield* Deferred.make<MessageDelivery, AgentError>();
    const completed = yield* Deferred.make<void, AgentError>();
    const consumed = yield* Deferred.make<"consumed" | "discarded">();
    yield* Effect.scoped(
      Effect.gen(function* () {
        const entry = yield* retain(sessions, chatId);
        const operation = yield* Deferred.make<void>();
        let consumption: Fiber.Fiber<void> | undefined;
        let delivery: MessageDelivery | undefined;
        let ordinary: OrdinaryRun | null = null;
        yield* Effect.gen(function* () {
          while (delivery === undefined) {
            const next = yield* entry.admission.withPermit(
              Effect.gen(function* () {
                if (MutableRef.get(entry.lifecycle).type !== "open") {
                  return yield* new AgentError({ message: "OMP session is closing" });
                }
                const capture = MutableRef.get(entry.capture);
                if (capture !== null && MutableRef.get(entry.run) !== capture) {
                  return { kind: "waiting", released: capture.released } as const;
                }
                entry.operations.add(operation);
                const value = yield* boundary("Failed to send OMP prompt", () =>
                  entry.sendPrompt(prompt, () => {
                    const active = MutableRef.get(entry.run);
                    const state: OrdinaryRun["state"] = { kind: "submitting", terminal: null };
                    ordinary =
                      active?.kind === "ordinary"
                        ? active
                        : {
                            kind: "ordinary",
                            finished: Deferred.makeUnsafe<void>(),
                            state,
                          };
                    ordinary.state = state;
                    MutableRef.set(entry.run, ordinary);
                  }),
                );
                return { kind: "admitted", delivery: value } as const;
              }),
            );
            if (next.kind === "waiting") yield* Deferred.await(next.released);
            else delivery = next.delivery;
          }
          if (delivery.kind === "steered") {
            consumption = yield* Effect.raceFirst(
              delivery.consumed,
              Deferred.await(entry.closed).pipe(Effect.as("discarded" as const)),
            ).pipe(
              Effect.flatMap((outcome) => Deferred.succeed(consumed, outcome)),
              Effect.asVoid,
              Effect.forkChild,
            );
          }
          if (delivery.kind === "started") {
            yield* Effect.logDebug("OMP run started").pipe(
              Effect.annotateLogs({
                component: "omp",
                operation: "run",
                chatId,
                mode: "ordinary",
                attachmentCount: prompt.attachments.length,
              }),
            );
          }
          const receipt: MessageDelivery =
            delivery.kind === "handled"
              ? delivery
              : delivery.kind === "started"
                ? { kind: "started", completed: Deferred.await(completed) }
                : {
                    kind: "steered",
                    consumed: Deferred.await(consumed),
                    completed: Deferred.await(completed),
                  };
          yield* Deferred.succeed(admitted, receipt);
          if (delivery.kind !== "handled") yield* delivery.completed;
          if (ordinary !== null) {
            const state = ordinary.state;
            if (state.kind === "submitting") {
              ordinary.state =
                state.terminal === null
                  ? { kind: "streaming" }
                  : { kind: "settled", terminal: state.terminal };
            }
            yield* settleOrdinaryRun(chatId, entry.run, ordinary);
          }
          yield* drainSessionEvents(entry);
        }).pipe(
          Effect.onExit((exit) =>
            Effect.gen(function* () {
              yield* Deferred.done(completed, exit);
              if (Exit.isFailure(exit)) {
                yield* Deferred.failCause(admitted, exit.cause);
                if (ordinary?.state.kind === "submitting") {
                  if (ordinary.state.terminal === null) {
                    ordinary.state = { kind: "streaming" };
                  } else {
                    if (MutableRef.get(entry.run) === ordinary) MutableRef.set(entry.run, null);
                    yield* Deferred.succeed(ordinary.finished, undefined);
                  }
                }
              }
              entry.operations.delete(operation);
              yield* Deferred.succeed(operation, undefined);
            }),
          ),
          Effect.exit,
        );
        if (consumption !== undefined) yield* Fiber.join(consumption);
      }),
    ).pipe(
      Effect.onExit((exit) =>
        Effect.gen(function* () {
          if (Exit.isFailure(exit)) {
            yield* Deferred.failCause(admitted, exit.cause);
            yield* Deferred.done(completed, exit);
          }
          yield* Deferred.succeed(consumed, "discarded");
        }),
      ),
      Effect.catchCause((cause) =>
        Cause.hasDies(cause)
          ? Effect.logError("OMP submission observer failed").pipe(
              Effect.annotateLogs({
                component: "omp",
                operation: "send",
                chatId,
                failureKind: "defect",
              }),
            )
          : Effect.void,
      ),
      Effect.forkIn(scope),
    );
    return yield* Deferred.await(admitted);
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
        const terminal = yield* Deferred.make<CapturedAgentRun, AgentError>();
        const released = yield* Deferred.make<void>();
        const capturedEvents: Array<AgentEvent.AgentEvent> = [];
        let assistantText = "";
        let submission: Promise<MessageDelivery> | undefined;
        const capture: ActiveCapture = {
          kind: "captured",
          runId,
          released,
          onEvent: (event) =>
            Effect.gen(function* () {
              capturedEvents.push(event);
              if (event.type === "message-settled" && event.message.role === "assistant") {
                assistantText = event.message.content
                  .filter((block) => block.type === "text")
                  .map((block) => block.text)
                  .join("");
              }
              const sink = yield* onEvent(event).pipe(
                Effect.tapCause((cause) => Deferred.failCause(terminal, cause)),
                Effect.result,
              );
              if (Result.isFailure(sink)) return yield* Deferred.fail(terminal, sink.failure);
              if (event.type === "run-finished") {
                yield* Deferred.succeed(terminal, {
                  runId,
                  outcome: event.outcome,
                  events: [...capturedEvents],
                  finalAssistantText: assistantText,
                });
              }
            }).pipe(Effect.asVoid),
        };
        return yield* Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            const result = yield* restore(
              Effect.gen(function* () {
                let delivery: MessageDelivery | undefined;
                while (delivery === undefined) {
                  const active = MutableRef.get(entry.capture) ?? MutableRef.get(entry.run);
                  if (active !== null) {
                    yield* Deferred.await(
                      active.kind === "captured" ? active.released : active.finished,
                    );
                    continue;
                  }
                  yield* boundary("Failed to wait for OMP session idle", () =>
                    entry.session.waitForIdle(),
                  );
                  yield* boundary("Failed to settle OMP capture admission persistence", () =>
                    entry.session.settleInFlightMessagePersistence(),
                  );
                  yield* drainSessionEvents(entry);
                  const next = yield* entry.admission.withPermit(
                    Effect.gen(function* () {
                      if (MutableRef.get(entry.lifecycle).type !== "open") {
                        return yield* new AgentError({ message: "OMP session is closing" });
                      }
                      const activeCapture = MutableRef.get(entry.capture);
                      const ordinary = MutableRef.get(entry.run);
                      if (activeCapture !== null)
                        return { kind: "waiting", released: activeCapture.released } as const;
                      if (ordinary?.kind === "ordinary")
                        return { kind: "waiting", released: ordinary.finished } as const;
                      if (entry.session.isStreaming) return { kind: "busy" } as const;
                      MutableRef.set(entry.capture, capture);
                      MutableRef.set(entry.run, capture);
                      entry.operations.add(released);
                      const value = yield* boundary("Failed to send captured OMP prompt", () => {
                        submission = entry.sendPrompt(prompt);
                        return submission;
                      });
                      return { kind: "admitted", delivery: value } as const;
                    }),
                  );
                  if (next.kind === "waiting") yield* Deferred.await(next.released);
                  else if (next.kind === "admitted") delivery = next.delivery;
                }
                if (delivery.kind !== "started") {
                  return yield* new AgentError({
                    message: "Scheduled prompt did not start a captured run",
                  });
                }
                yield* Effect.logDebug("Captured OMP run started").pipe(
                  Effect.annotateLogs({
                    component: "omp",
                    operation: "run",
                    chatId,
                    runId,
                    mode: "captured",
                  }),
                );
                yield* Effect.raceFirst(
                  delivery.completed,
                  Deferred.await(terminal).pipe(Effect.flatMap(() => Effect.never)),
                );
                const captured = yield* Deferred.await(terminal);
                yield* boundary("Failed to settle captured OMP persistence", () =>
                  entry.session.settleInFlightMessagePersistence(),
                );
                return captured;
              }).pipe(
                Effect.raceFirst(
                  Deferred.await(entry.closed).pipe(Effect.andThen(Effect.interrupt)),
                ),
              ),
            ).pipe(Effect.exit);
            if (MutableRef.get(entry.capture) === capture) {
              if (Exit.isFailure(result)) {
                if (MutableRef.get(entry.run) === capture) {
                  yield* attemptCleanup(
                    chatId,
                    "capture-abort",
                    boundary("Failed to abort captured OMP run", () =>
                      entry.session.abort({
                        goalReason: Cause.hasInterruptsOnly(result.cause)
                          ? "interrupted"
                          : "internal",
                        reason: Cause.hasInterruptsOnly(result.cause)
                          ? "Scheduled run interrupted"
                          : "Scheduled run capture failed",
                      }),
                    ),
                  ).pipe(Effect.annotateLogs({ runId }), Effect.exit);
                }
                const inFlight = submission;
                if (inFlight !== undefined) {
                  yield* attemptCleanup(
                    chatId,
                    "capture-completion",
                    boundary("Failed to settle captured OMP submission", () => inFlight).pipe(
                      Effect.flatMap((delivery) =>
                        delivery.kind === "handled" ? Effect.void : delivery.completed,
                      ),
                    ),
                  ).pipe(Effect.annotateLogs({ runId }), Effect.exit);
                }
                yield* attemptCleanup(chatId, "capture-drain", drainSessionEvents(entry)).pipe(
                  Effect.annotateLogs({ runId }),
                  Effect.exit,
                );
              }
              if (MutableRef.get(entry.run) === capture) MutableRef.set(entry.run, null);
              MutableRef.set(entry.capture, null);
              entry.operations.delete(released);
              yield* Deferred.succeed(released, undefined);
              yield* Effect.logDebug(
                Exit.isFailure(result) ? "Captured OMP run stopped" : "Captured OMP run finished",
              ).pipe(
                Effect.annotateLogs({
                  component: "omp",
                  operation: "run",
                  chatId,
                  runId,
                  mode: "captured",
                  outcome: Exit.isFailure(result)
                    ? Cause.hasInterruptsOnly(result.cause)
                      ? "interrupted"
                      : "rejected"
                    : result.value.outcome,
                }),
              );
            }
            return yield* result;
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
    askBtw,
    sendCaptured,
    deliver,
    publish,
    close,
    abort,
    contextUsage,
    shake,
  } satisfies SessionPool;
});
