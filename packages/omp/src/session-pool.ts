import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session-events";
import * as AgentEvent from "@pico/contract/agent-event";
import type * as History from "@pico/contract/agent-history";
import type * as AgentMessage from "@pico/contract/agent-message";
import type {
  CapturedAgentRun,
  ContextUsage,
  MessageDelivery,
  ModelInfo,
  ModelRef,
  ModelSwitchResult,
  ShakeMode,
  ShakeResult,
  SkillCommand,
} from "@pico/contract/agent-runtime";
import type {
  NavigateHistoryResult,
  RuntimeSnapshot,
  TranscriptSnapshot,
} from "@pico/contract/agent-snapshot";
import type * as Chat from "@pico/contract/chat-model";
import { AgentError } from "@pico/contract/errors";
import type { ScheduleRunId } from "@pico/contract/schedule";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
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
import { normalizeMessage } from "./agent-event.ts";
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
  readonly shake: (mode: ShakeMode, signal: AbortSignal) => Promise<ShakeResult>;
  readonly switchModel: (model: ModelRef) => Promise<ModelInfo>;
  readonly currentModel: () => ModelInfo | null;
  readonly navigateHistory: (
    targetId: History.HistoryEntryId,
    onReplaced: () => Promise<void>,
  ) => Promise<
    | { readonly kind: "cancelled" }
    | { readonly kind: "busy" }
    | { readonly kind: "applied"; readonly draft: AgentMessage.AgentPrompt | null }
  >;
  readonly flush: () => Promise<void>;
  readonly contextUsage: () => ContextUsage;
  readonly availableSkills: () => readonly SkillCommand[];
  readonly historyBoundary: () => string;
  readonly settleHistory: () => Promise<void>;
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
  readonly transcript: (chatId: Chat.ChatId) => Effect.Effect<TranscriptSnapshot, AgentError>;
  readonly resultSummary: (
    chatId: Chat.ChatId,
    seen: Chat.ResultCursor | null,
  ) => Effect.Effect<Chat.ChatResultSummary, AgentError>;
  readonly history: (
    input: History.ChatHistoryRequest,
  ) => Effect.Effect<History.HistorySnapshot, AgentError>;
  readonly previewHistory: (
    input: History.PreviewChatHistoryRequest,
  ) => Effect.Effect<History.HistoryPreview, AgentError>;
  readonly navigateHistory: (
    input: History.NavigateChatHistoryRequest,
  ) => Effect.Effect<NavigateHistoryResult, AgentError>;
  readonly send: (
    chatId: Chat.ChatId,
    prompt: AgentMessage.AgentPrompt,
  ) => Effect.Effect<MessageDelivery, AgentError>;
  readonly askBtw: (chatId: Chat.ChatId, question: string) => Effect.Effect<string, AgentError>;
  readonly close: (chatId: Chat.ChatId) => Effect.Effect<void, AgentError>;
  readonly abort: (chatId: Chat.ChatId) => Effect.Effect<void, AgentError>;
  readonly contextUsage: (chatId: Chat.ChatId) => Effect.Effect<ContextUsage, AgentError>;
  readonly shake: (chatId: Chat.ChatId, mode: ShakeMode) => Effect.Effect<ShakeResult, AgentError>;
  readonly availableSkills: (
    chatId: Chat.ChatId,
  ) => Effect.Effect<readonly SkillCommand[], AgentError>;
  readonly switchModel: (
    chatId: Chat.ChatId,
    model: ModelRef,
  ) => Effect.Effect<ModelSwitchResult, AgentError>;
  readonly sendCaptured: (
    chatId: Chat.ChatId,
    runId: ScheduleRunId,
    prompt: AgentMessage.AgentPrompt,
    onEvent: (event: AgentEvent.AgentEvent) => Effect.Effect<void, AgentError>,
  ) => Effect.Effect<CapturedAgentRun, AgentError>;
  readonly deliver: (
    chatId: Chat.ChatId,
    message: AgentMessage.AgentAssistantMessage,
    localOnly?: true,
  ) => Effect.Effect<void>;
  readonly publish: (
    chatId: Chat.ChatId,
    content: string,
    localOnly?: true,
  ) => Effect.Effect<void, AgentError>;
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

interface SessionKey {
  readonly chatId: Chat.ChatId;
  readonly runtime: PublicRuntime;
}

interface SessionEntries {
  readonly cache: RcMap.RcMap<SessionKey, LiveEntry, AgentError>;
  readonly keys: Map<Chat.ChatId, SessionKey>;
}

interface LiveEntry {
  readonly chatId: Chat.ChatId;
  readonly key: SessionKey;
  readonly session: SessionHandle;
  readonly sendPrompt: OmpPromptSender;
  readonly askBtw: (question: string, signal: AbortSignal) => Promise<string>;
  readonly shake: OpenedSession["shake"];
  readonly switchModel: OpenedSession["switchModel"];
  readonly currentModel: OpenedSession["currentModel"];
  readonly navigateHistory: OpenedSession["navigateHistory"];
  readonly flush: OpenedSession["flush"];
  readonly contextUsage: () => ContextUsage;
  readonly availableSkills: OpenedSession["availableSkills"];
  readonly historyBoundary: OpenedSession["historyBoundary"];
  readonly settleHistory: OpenedSession["settleHistory"];
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

type PublicAssistant =
  | {
      readonly kind: "draft";
      readonly messageId: AgentMessage.AgentMessageId;
      readonly blocks: Map<
        number,
        Extract<AgentEvent.AgentEvent, { type: "text-delta" | "thinking-delta" }>
      >;
    }
  | Extract<RuntimeSnapshot["assistant"][number], { kind: "settled" }>;

interface PublicRuntime {
  run: RuntimeSnapshot["run"];
  readonly assistant: Map<AgentMessage.AgentMessageId, PublicAssistant>;
  readonly tools: Map<string, RuntimeSnapshot["tools"][number]>;
  structural: number;
  mutations: number;
  healthy: boolean;
}

const makePublicRuntime = (): PublicRuntime => ({
  run: { kind: "idle" },
  assistant: new Map(),
  tools: new Map(),
  structural: 0,
  mutations: 0,
  healthy: true,
});

const beginPublicRun = (runtime: PublicRuntime) => {
  if (runtime.run.kind === "running") return;
  runtime.run = { kind: "running" };
  for (const [id, assistant] of runtime.assistant) {
    if (assistant.kind === "draft") runtime.assistant.delete(id);
  }
  runtime.tools.clear();
};

const projectEvent = (
  runtime: PublicRuntime,
  event: AgentEvent.AgentEvent,
  origin: AgentEvent.AgentEventEnvelope["origin"],
) => {
  if (origin === "delivery" && (event.type === "run-started" || event.type === "run-finished"))
    return;
  switch (event.type) {
    case "run-started":
      beginPublicRun(runtime);
      break;
    case "text-delta":
    case "thinking-delta": {
      const previous = runtime.assistant.get(event.messageId);
      if (previous?.kind === "settled") break;
      beginPublicRun(runtime);
      const draft: Extract<PublicAssistant, { kind: "draft" }> = previous ?? {
        kind: "draft",
        messageId: event.messageId,
        blocks: new Map(),
      };
      const block = draft.blocks.get(event.contentIndex);
      draft.blocks.set(event.contentIndex, {
        ...event,
        text: block?.type === event.type ? block.text + event.text : event.text,
      });
      runtime.assistant.set(event.messageId, draft);
      break;
    }
    case "message-settled":
      if (event.message.role === "assistant")
        runtime.assistant.set(event.message.id, { kind: "settled", message: event.message });
      break;
    case "tool-started":
      beginPublicRun(runtime);
      runtime.tools.set(event.toolCallId, { kind: "running", start: event });
      break;
    case "tool-finished":
      runtime.tools.set(event.toolCallId, {
        kind: "finished",
        start: runtime.tools.get(event.toolCallId)?.start ?? null,
        end: event,
      });
      break;
    case "run-finished":
      runtime.run = { kind: "finished", outcome: event.outcome };
      for (const [id, tool] of runtime.tools) if (tool.kind === "running") runtime.tools.delete(id);
      break;
    case "history-replaced":
      runtime.run = { kind: "idle" };
      runtime.assistant.clear();
      runtime.tools.clear();
      break;
    case "title-changed":
    case "context-invalidated":
    case "notice":
      break;
  }
};

const runtimeSnapshot = (
  runtime: PublicRuntime,
  publication: AgentEvent.Publication,
): RuntimeSnapshot => ({
  publication,
  run: runtime.run,
  assistant: Array.from(runtime.assistant.values(), (value) =>
    value.kind === "settled" ? value : { ...value, blocks: Array.from(value.blocks.values()) },
  ),
  tools: Array.from(runtime.tools.values()),
});

type PublishEvent = (
  key: SessionKey | undefined,
  envelope: Omit<AgentEvent.AgentEventEnvelope, "publication">,
) => void;

interface MakeOptions {
  readonly factory: SessionFactory;
  readonly loadTranscript: (
    chatId: Chat.ChatId,
  ) => Effect.Effect<Pick<TranscriptSnapshot, "messages" | "todo" | "historyRevision">, AgentError>;
  readonly loadCurrentModel: (chatId: Chat.ChatId) => Effect.Effect<ModelInfo | null, AgentError>;
  readonly loadHistory: (
    chatId: Chat.ChatId,
    query: string,
  ) => Effect.Effect<
    Pick<History.HistorySnapshot, "nodes" | "activeLeafId" | "revision" | "version" | "matches">,
    AgentError
  >;
  readonly loadResultSummary: (
    chatId: Chat.ChatId,
    seen: Chat.ResultCursor | null,
  ) => Effect.Effect<Chat.ChatResultSummary, AgentError>;
  readonly loadHistoryPreview: (
    input: History.PreviewChatHistoryRequest,
  ) => Effect.Effect<History.HistoryPreview, AgentError>;
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

const runOperation = Effect.fn("SessionPool.runOperation")(function* <A>(
  entry: LiveEntry,
  message: string,
  history: "unchanged" | "mutating",
  evaluate: (signal: AbortSignal) => Promise<A>,
  complete?: (value: A) => Effect.Effect<void>,
) {
  const controller = new AbortController();
  const finished = yield* Deferred.make<void>();
  let mutating = false;
  const endMutation = () => {
    if (!mutating) return;
    mutating = false;
    entry.key.runtime.mutations--;
    entry.key.runtime.structural++;
  };
  const publishCompletion = (value: A) =>
    Effect.sync(endMutation).pipe(Effect.andThen(complete?.(value) ?? Effect.void));
  return yield* Effect.uninterruptibleMask((restore) =>
    Effect.acquireUseRelease(
      Effect.acquireUseRelease(
        restore(entry.admission.take(1)),
        () =>
          Effect.try({
            try: () => {
              if (MutableRef.get(entry.lifecycle).type !== "open") {
                throw new AgentError({ message: "OMP session is closing" });
              }
              if (history === "mutating") {
                entry.key.runtime.structural++;
                entry.key.runtime.mutations++;
                mutating = true;
              }
              try {
                const pending = evaluate(controller.signal);
                entry.operations.add(finished);
                return pending;
              } catch (cause) {
                endMutation();
                throw cause;
              }
            },
            catch: (cause) => agentError(message, cause),
          }),
        () => entry.admission.release(1),
      ),
      (pending) =>
        restore(
          boundary(message, () => pending).pipe(
            Effect.raceFirst(Deferred.await(entry.closed).pipe(Effect.andThen(Effect.interrupt))),
          ),
        ).pipe(
          Effect.onExit((exit) => {
            if (Exit.isSuccess(exit)) return publishCompletion(exit.value);
            if (!Cause.hasInterrupts(exit.cause)) return Effect.void;
            return Effect.sync(() => controller.abort()).pipe(
              Effect.andThen(
                boundary(message, () => pending).pipe(
                  Effect.flatMap(publishCompletion),
                  Effect.catchCause((cause) =>
                    Cause.hasInterruptsOnly(cause) ? Effect.void : Effect.failCause(cause),
                  ),
                ),
              ),
            );
          }),
        ),
      () =>
        Effect.sync(() => {
          entry.operations.delete(finished);
          endMutation();
        }).pipe(Effect.andThen(Deferred.succeed(finished, undefined))),
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
  attemptCleanup(entry.chatId, "release", entry.admission.withPermit(closeEntry(entry)));

const acquireEntry = Effect.fn("SessionPool.acquireEntry")(function* (
  factory: SessionFactory,
  publishEvent: PublishEvent,
  key: SessionKey,
) {
  const { chatId } = key;
  const capture = MutableRef.make<ActiveCapture | null>(null);
  const run = MutableRef.make<ActiveRun | null>(null);
  const events = yield* Queue.unbounded<SessionItem, Cause.Done>();
  const opened = yield* factory.open(chatId, (event) => {
    let owner = MutableRef.get(run) ?? MutableRef.get(capture);
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
    if (event.type === "message-settled" || event.type === "context-invalidated")
      key.runtime.structural++;
    if (
      owner?.kind !== "captured" ||
      event.type === "title-changed" ||
      event.type === "context-invalidated"
    )
      publishEvent(key, { chatId, event, origin: "session" });
    Queue.offerUnsafe(events, { kind: "event", event, owner });
  });
  const forwarder = yield* Stream.fromQueue(events).pipe(
    Stream.runForEach((item) =>
      Effect.gen(function* () {
        if (item.kind === "barrier") return yield* Deferred.succeed(item.completed, undefined);
        const owner = item.owner;
        if (owner?.kind === "captured") {
          if (item.event.type !== "title-changed" && item.event.type !== "context-invalidated") {
            yield* owner.onEvent(item.event);
            return;
          }
        }
        if (owner?.kind === "ordinary" && item.event.type === "run-finished") {
          yield* settleOrdinaryRun(chatId, run, owner);
        }
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
    Effect.ensuring(
      Effect.sync(() => {
        key.runtime.healthy = false;
      }),
    ),
    Effect.ensuring(Queue.end(events)),
    Effect.forkDetach,
  );

  yield* Effect.logDebug("OMP session opened").pipe(
    Effect.annotateLogs({ component: "omp", operation: "session-open", chatId }),
  );
  return {
    chatId,
    key,
    session: opened.session,
    sendPrompt: opened.sendPrompt,
    askBtw: opened.askBtw,
    shake: opened.shake,
    switchModel: opened.switchModel,
    currentModel: opened.currentModel,
    navigateHistory: opened.navigateHistory,
    availableSkills: opened.availableSkills,
    flush: opened.flush,
    appendAssistantMessage: opened.appendAssistantMessage,
    contextUsage: opened.contextUsage,
    historyBoundary: opened.historyBoundary,
    settleHistory: opened.settleHistory,
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

const forgetKey = (keys: SessionEntries["keys"], key: SessionKey) =>
  Effect.sync(() => {
    if (keys.get(key.chatId) === key) keys.delete(key.chatId);
  });

const invalidate = (sessions: SessionEntries, key: SessionKey) =>
  forgetKey(sessions.keys, key).pipe(Effect.andThen(RcMap.invalidate(sessions.cache, key)));

const retain = (sessions: SessionEntries, chatId: Chat.ChatId) =>
  Effect.suspend(() => {
    let key = sessions.keys.get(chatId);
    if (key === undefined) {
      key = Equal.byReferenceUnsafe({ chatId, runtime: makePublicRuntime() });
      sessions.keys.set(chatId, key);
    }
    const selected = key;
    return RcMap.get(sessions.cache, selected).pipe(
      Effect.catch((error) =>
        invalidate(sessions, selected).pipe(Effect.andThen(Effect.fail(error))),
      ),
    );
  });

const retainOption = (sessions: SessionEntries, chatId: Chat.ChatId) =>
  Effect.suspend(() => {
    const key = sessions.keys.get(chatId);
    return key === undefined
      ? Effect.succeed(Option.none<LiveEntry>())
      : RcMap.getOption(sessions.cache, key).pipe(
          Effect.catch((error) =>
            invalidate(sessions, key).pipe(Effect.andThen(Effect.fail(error))),
          ),
        );
  });

export const makeSessionPool = Effect.fn("SessionPool.make")(function* (
  options: MakeOptions,
): Effect.fn.Return<SessionPool, never, Scope.Scope> {
  const runEffect = Effect.runPromiseWith(yield* Effect.context<never>());
  const scope = yield* Effect.scope;
  const output = yield* Effect.acquireRelease(Queue.unbounded<OutputItem, Cause.Done>(), (queue) =>
    Queue.end(queue).pipe(Effect.asVoid),
  );
  const keys: SessionEntries["keys"] = new Map();
  let publication = AgentEvent.Publication.make(0);
  const publishEvent: PublishEvent = (key, envelope) => {
    publication = AgentEvent.Publication.make(publication + 1);
    if (key !== undefined) projectEvent(key.runtime, envelope.event, envelope.origin);
    Queue.offerUnsafe(output, { kind: "event", envelope: { ...envelope, publication } });
  };
  const cache = yield* RcMap.make({
    lookup: (key: SessionKey) =>
      Effect.acquireRelease(acquireEntry(options.factory, publishEvent, key), (entry) =>
        releaseEntry(entry).pipe(Effect.ensuring(forgetKey(keys, key))),
      ),
    idleTimeToLive: "10 minutes",
  });
  const sessions: SessionEntries = { cache, keys };
  const closeFailures = new Map<Chat.ChatId, AgentError>();
  const drain = Effect.fn("AgentRuntime.drain")(function* () {
    const completed = yield* Deferred.make<void>();
    const accepted = yield* Queue.offer(output, { kind: "drain", completed });
    if (accepted) yield* Deferred.await(completed);
    yield* Effect.yieldNow;
  });

  const observeTranscript = Effect.fn("SessionPool.observeTranscript")(function* (
    entry: LiveEntry,
  ) {
    const runtime = entry.key.runtime;
    if (!runtime.healthy || MutableRef.get(entry.lifecycle).type !== "open")
      return yield* new AgentError({ message: "OMP runtime observation is unavailable" });
    if (runtime.mutations !== 0)
      return yield* new AgentError({ message: "OMP history is changing" });
    const structural = runtime.structural;
    const before = yield* Effect.try({
      try: entry.historyBoundary,
      catch: (cause) => agentError("Failed to observe OMP history", cause),
    });
    yield* boundary("Failed to settle OMP transcript persistence", entry.settleHistory);
    const snapshot = yield* options.loadTranscript(entry.chatId);
    return yield* Effect.try({
      try: (): TranscriptSnapshot | undefined => {
        if (!runtime.healthy) throw new Error("OMP event forwarder stopped");
        if (
          runtime.structural !== structural ||
          runtime.mutations !== 0 ||
          keys.get(entry.chatId) !== entry.key ||
          entry.historyBoundary() !== before
        )
          return undefined;
        for (const message of snapshot.messages) {
          if (message.role === "assistant" && runtime.assistant.get(message.id)?.kind === "settled")
            runtime.assistant.delete(message.id);
        }
        let contextUsage: TranscriptSnapshot["contextUsage"];
        try {
          contextUsage = entry.contextUsage();
        } catch {
          contextUsage = { kind: "error" };
        }
        return {
          ...snapshot,
          currentModel: entry.currentModel(),
          contextUsage,
          runtime: runtimeSnapshot(runtime, publication),
        };
      },
      catch: (cause) => agentError("Failed to observe OMP runtime", cause),
    });
  });

  const transcript = Effect.fn("AgentRuntime.transcript")(function* (
    chatId: Chat.ChatId,
  ): Effect.fn.Return<TranscriptSnapshot, AgentError> {
    return yield* Effect.scoped(
      Effect.gen(function* () {
        while (true) {
          const selected = keys.get(chatId);
          const retained = yield* retainOption(sessions, chatId);
          if (Option.isNone(retained)) {
            const snapshot = yield* options.loadTranscript(chatId);
            const currentModel = yield* options.loadCurrentModel(chatId);
            if (keys.get(chatId) !== selected) continue;
            return {
              ...snapshot,
              currentModel,
              contextUsage: { kind: "unavailable" },
              runtime: runtimeSnapshot(makePublicRuntime(), publication),
            } satisfies TranscriptSnapshot;
          }
          const entry = retained.value;
          const value = yield* entry.admission.withPermit(observeTranscript(entry));
          if (value !== undefined) return value;
        }
      }),
    ).pipe(
      Effect.timeout("5 seconds"),
      Effect.catchTag("TimeoutError", () =>
        Effect.fail(new AgentError({ message: "OMP history did not reach a stable observation" })),
      ),
    );
  });
  const resultSummary = Effect.fn("AgentRuntime.resultSummary")(function* (
    chatId: Chat.ChatId,
    seen: Chat.ResultCursor | null,
  ) {
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const retained = yield* retainOption(sessions, chatId);
        if (Option.isNone(retained)) return yield* options.loadResultSummary(chatId, seen);
        const entry = retained.value;
        return yield* entry.admission.withPermit(
          boundary("Failed to settle OMP history", entry.settleHistory).pipe(
            Effect.andThen(options.loadResultSummary(chatId, seen)),
          ),
        );
      }),
    );
  });

  const isBusy = (entry: LiveEntry): boolean =>
    entry.session.isStreaming ||
    MutableRef.get(entry.run) !== null ||
    MutableRef.get(entry.capture) !== null ||
    entry.operations.size !== 0 ||
    entry.key.runtime.mutations !== 0;

  const readHistory = Effect.fn("SessionPool.readHistory")(function* (
    input: History.ChatHistoryRequest,
    entry?: LiveEntry,
  ) {
    const observedPublication = publication;
    const snapshot = yield* options.loadHistory(input.chatId, input.query);
    let nodes = snapshot.nodes;
    if (input.query.trim().length > 0) {
      const byId = new Map(nodes.map((node) => [node.entryId, node]));
      const included = new Set<History.HistoryEntryId>();
      for (const match of snapshot.matches) {
        let ancestor = byId.get(match);
        while (ancestor !== undefined && !included.has(ancestor.entryId)) {
          included.add(ancestor.entryId);
          ancestor = ancestor.parentId === null ? undefined : byId.get(ancestor.parentId);
        }
      }
      nodes = nodes.filter((node) => included.has(node.entryId));
    }
    return {
      ...snapshot,
      nodes,
      publication: observedPublication,
      canContinue:
        entry === undefined ||
        (entry.key.runtime.healthy &&
          MutableRef.get(entry.lifecycle).type === "open" &&
          !isBusy(entry)),
    } satisfies History.HistorySnapshot;
  });

  const history = Effect.fn("AgentRuntime.history")(function* (input: History.ChatHistoryRequest) {
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const retained = yield* retainOption(sessions, input.chatId);
        if (Option.isNone(retained)) return yield* readHistory(input);
        const entry = retained.value;
        return yield* entry.admission.withPermit(
          boundary("Failed to settle OMP history", entry.settleHistory).pipe(
            Effect.andThen(readHistory(input, entry)),
          ),
        );
      }),
    );
  });

  const previewHistory = (input: History.PreviewChatHistoryRequest) =>
    options.loadHistoryPreview(input);

  const navigateHistory = Effect.fn("AgentRuntime.navigateHistory")(function* (
    input: History.NavigateChatHistoryRequest,
  ): Effect.fn.Return<NavigateHistoryResult, AgentError> {
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const retained = yield* retainOption(sessions, input.chatId);
        if (Option.isNone(retained)) {
          const snapshot = yield* readHistory({ chatId: input.chatId, query: "" });
          if (snapshot.version !== input.expectedVersion)
            return {
              kind: "conflict",
              reason: "version-mismatch",
              version: snapshot.version,
              history: snapshot,
            } as const;
          if (!snapshot.nodes.some((node) => node.entryId === input.targetId))
            return {
              kind: "conflict",
              reason: "target-missing",
              version: snapshot.version,
              history: snapshot,
            } as const;
        }
        const entry = Option.isSome(retained)
          ? retained.value
          : yield* retain(sessions, input.chatId);
        const conflict = Effect.fn("SessionPool.historyConflict")(function* (
          reason: History.NavigateHistoryConflictReason,
        ) {
          const snapshot = yield* readHistory({ chatId: input.chatId, query: "" }, entry);
          return {
            kind: "conflict",
            reason,
            version: snapshot.version,
            history: snapshot,
          } as const;
        });
        const admitted = yield* entry.admission.withPermitsIfAvailable(1)(
          Effect.gen(function* () {
            if (MutableRef.get(entry.lifecycle).type !== "open" || !entry.key.runtime.healthy)
              return yield* new AgentError({ message: "OMP runtime observation is unavailable" });
            if (isBusy(entry)) return yield* conflict("busy");
            yield* boundary("Failed to settle OMP history", entry.settleHistory);
            const current = yield* readHistory({ chatId: input.chatId, query: "" }, entry);
            if (current.version !== input.expectedVersion)
              return yield* conflict("version-mismatch");
            if (!current.nodes.some((node) => node.entryId === input.targetId))
              return yield* conflict("target-missing");
            const runtime = entry.key.runtime;
            runtime.structural++;
            runtime.mutations++;
            const result = yield* boundary("Failed to navigate OMP history", () =>
              entry.navigateHistory(input.targetId, () =>
                runEffect(
                  Effect.gen(function* () {
                    yield* boundary(
                      "Failed to persist OMP history navigation",
                      entry.settleHistory,
                    );
                    yield* drainSessionEvents(entry);
                    publishEvent(entry.key, {
                      chatId: input.chatId,
                      event: { type: "history-replaced" },
                      origin: "session",
                    });
                  }).pipe(
                    Effect.tapCause(() =>
                      Effect.sync(() => {
                        runtime.healthy = false;
                      }),
                    ),
                  ),
                ),
              ),
            ).pipe(
              Effect.ensuring(
                Effect.sync(() => {
                  runtime.mutations--;
                  runtime.structural++;
                }),
              ),
            );
            if (result.kind === "busy") return yield* conflict("busy");
            if (result.kind === "cancelled") return { kind: "cancelled" } as const;
            yield* boundary("Failed to persist OMP history navigation", entry.settleHistory);
            yield* drainSessionEvents(entry);
            while (true) {
              const snapshot = yield* observeTranscript(entry);
              if (snapshot !== undefined)
                return {
                  kind: "applied",
                  snapshot,
                  draft: result.draft,
                } as const;
            }
          }).pipe(Effect.uninterruptible),
        );
        return Option.isSome(admitted) ? admitted.value : yield* conflict("busy");
      }),
    );
  });

  const askBtw = Effect.fn("AgentRuntime.askBtw")(function* (
    chatId: Chat.ChatId,
    question: string,
  ) {
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const entry = yield* retain(sessions, chatId);
        return yield* runOperation(
          entry,
          "Failed to ask OMP side question",
          "unchanged",
          (signal) => entry.askBtw(question, signal),
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
              yield* Deferred.done(completed, exit);
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
        const terminal = yield* Deferred.make<RunOutcome, AgentError>();
        const released = yield* Deferred.make<void>();
        const capturedEvents: Array<AgentEvent.AgentEvent> = [];
        let sinkFailure: Cause.Cause<AgentError> | undefined;
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
                Effect.tapCause((cause) => {
                  sinkFailure ??= cause;
                  return Deferred.failCause(terminal, cause);
                }),
                Effect.result,
              );
              if (Result.isFailure(sink)) return yield* Deferred.fail(terminal, sink.failure);
              if (event.type === "run-finished") {
                yield* Deferred.succeed(terminal, event.outcome);
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
                      if (entry.session.isStreaming || MutableRef.get(entry.run) !== null) {
                        return { kind: "busy" } as const;
                      }
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
                    message: "Prompt did not start a captured run",
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
                yield* drainSessionEvents(entry);
                if (sinkFailure !== undefined) return yield* Effect.failCause(sinkFailure);
                return {
                  runId,
                  outcome: captured,
                  events: [...capturedEvents],
                  finalAssistantText: assistantText,
                } satisfies CapturedAgentRun;
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
                          ? "Captured turn interrupted"
                          : "Captured turn failed",
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
    message: AgentMessage.AgentAssistantMessage,
    localOnly?: true,
  ) {
    const events: ReadonlyArray<AgentEvent.AgentEvent> = [
      { type: "run-started" },
      { type: "message-settled", message },
      {
        type: "run-finished",
        outcome:
          message.status === "completed"
            ? "completed"
            : message.stopReason === "aborted"
              ? "aborted"
              : "failed",
      },
    ];
    yield* Effect.sync(() => {
      for (const event of events) {
        publishEvent(keys.get(chatId), {
          chatId,
          event,
          origin: "delivery",
          ...(localOnly === undefined ? {} : { localOnly }),
        });
      }
    });
  });

  const deliver = Effect.fn("AgentRuntime.deliver")(function* (
    chatId: Chat.ChatId,
    message: AgentMessage.AgentAssistantMessage,
    localOnly?: true,
  ) {
    yield* deliverEvents(chatId, message, localOnly);
  });

  const publish = Effect.fn("AgentRuntime.publish")(function* (
    chatId: Chat.ChatId,
    content: string,
    localOnly?: true,
  ) {
    const timestamp = yield* Clock.currentTimeMillis;
    const message: OmpAssistantMessage & { messageId: string } = {
      role: "assistant",
      messageId: crypto.randomUUID(),
      content: [{ type: "text", text: content }],
      api: "pico",
      provider: "pico",
      model: "pico/schedule",
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
        yield* runOperation(
          entry,
          "Failed to persist scheduled publication",
          "mutating",
          () => entry.appendAssistantMessage(message),
          () => deliverEvents(chatId, normalizeMessage(message), localOnly),
        );
      }),
    );
  });

  const close = Effect.fn("AgentRuntime.close")(function* (chatId: Chat.ChatId) {
    const previousFailure = closeFailures.get(chatId);
    if (previousFailure !== undefined) return yield* previousFailure;

    yield* Effect.scoped(
      Effect.gen(function* () {
        const entry = yield* retainOption(sessions, chatId);
        if (Option.isSome(entry)) {
          yield* entry.value.admission.withPermit(closeEntry(entry.value));
          yield* invalidate(sessions, entry.value.key);
        }
      }),
    ).pipe(
      Effect.tapError((error) =>
        Effect.sync(() => {
          closeFailures.set(chatId, error);
        }),
      ),
    );
  });

  const contextUsage = Effect.fn("AgentRuntime.contextUsage")(function* (chatId: Chat.ChatId) {
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const entry = yield* retain(sessions, chatId);
        return yield* entry.admission.withPermit(
          Effect.try({
            try: () => {
              if (MutableRef.get(entry.lifecycle).type !== "open") {
                throw new AgentError({ message: "OMP session is closing" });
              }
              return entry.contextUsage();
            },
            catch: (cause) => agentError("Failed to read OMP context", cause),
          }),
        );
      }),
    );
  });

  const availableSkills = Effect.fn("AgentRuntime.availableSkills")(function* (
    chatId: Chat.ChatId,
  ) {
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const entry = yield* retain(sessions, chatId);
        return yield* entry.admission.withPermit(
          Effect.try({
            try: () => {
              if (MutableRef.get(entry.lifecycle).type !== "open") {
                throw new AgentError({ message: "OMP session is closing" });
              }
              return entry.availableSkills();
            },
            catch: (cause) => agentError("Failed to list OMP skill commands", cause),
          }),
        );
      }),
    );
  });

  const switchModel = Effect.fn("AgentRuntime.switchModel")(function* (
    chatId: Chat.ChatId,
    model: ModelRef,
  ) {
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const entry = yield* retain(sessions, chatId);
        return yield* entry.admission.withPermit(
          Effect.gen(function* () {
            if (MutableRef.get(entry.lifecycle).type !== "open") {
              return yield* new AgentError({ message: "OMP session is closing" });
            }
            const selected = yield* boundary("Failed to switch OMP model", () =>
              entry.switchModel(model),
            );
            const persisted = yield* Effect.tryPromise({
              try: entry.flush,
              catch: () => undefined,
            }).pipe(Effect.isSuccess);
            return {
              kind: persisted ? "persisted" : "persistence-unconfirmed",
              model: selected,
            } satisfies ModelSwitchResult;
          }).pipe(Effect.uninterruptible),
        );
      }),
    );
  });

  const shake = Effect.fn("AgentRuntime.shake")(function* (chatId: Chat.ChatId, mode: ShakeMode) {
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const entry = yield* retain(sessions, chatId);
        return yield* runOperation(
          entry,
          "Failed to shake OMP session",
          "mutating",
          (signal) => entry.shake(mode, signal),
          () =>
            Effect.sync(() =>
              publishEvent(entry.key, {
                chatId,
                event: { type: "context-invalidated" },
                origin: "session",
              }),
            ),
        );
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
    resultSummary,
    history,
    previewHistory,
    navigateHistory,
    send,
    askBtw,
    sendCaptured,
    deliver,
    publish,
    close,
    abort,
    contextUsage,
    availableSkills,
    switchModel,
    shake,
  } satisfies SessionPool;
});
