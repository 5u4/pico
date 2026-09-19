import type { AgentEventEnvelope, Publication } from "@pico/contract/agent-event";
import type { ChatHistoryRequest, NavigateChatHistoryRequest } from "@pico/contract/agent-history";
import { AgentPrompt } from "@pico/contract/agent-message";
import type {
  ContextUsage,
  ModelInfo,
  ModelRef,
  ShakeMode,
  SkillCommand,
} from "@pico/contract/agent-runtime";
import type { NavigateHistoryResult, TranscriptSnapshot } from "@pico/contract/agent-snapshot";
import type {
  CloseChatOptions,
  CreateChat,
  CreateWorkspace,
  UpdateWorkspace,
} from "@pico/contract/application";
import type { ChatId, ChatListEntry } from "@pico/contract/chat-model";
import { ApplicationError, ChatClosed } from "@pico/contract/errors";
import type { ScheduleOverviewResponse } from "@pico/contract/rpc";
import type { ScheduleError } from "@pico/contract/schedule";
import type { Workspace, WorkspaceId } from "@pico/contract/workspace-model";
import * as RpcClient from "@pico/rpc/client";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import * as Atom from "effect/unstable/reactivity/Atom";
import * as AtomRegistry from "effect/unstable/reactivity/AtomRegistry";
import { RpcClientError } from "effect/unstable/rpc/RpcClientError";
import {
  emptyLiveChat,
  type LiveChat,
  reduceLiveChat,
  rehydrateChat,
  replaceHistory,
  unconfirmChat,
} from "./chat-state.ts";

export type { LiveAssistant, LiveBlock, LiveChat, LiveRun, LiveTool } from "./chat-state.ts";
export type Connection =
  | { readonly kind: "opening" }
  | { readonly kind: "active" }
  | { readonly kind: "unavailable"; readonly cause: Cause.Cause<unknown> };

type Client = Effect.Success<ReturnType<typeof RpcClient.make>>;
type ReadError = ApplicationError | RpcClientError;
interface Generation {
  readonly scope: Scope.Closeable;
  readonly client: Client;
  readonly ready: Deferred.Deferred<void, ApplicationError>;
  readonly retired: Deferred.Deferred<never, ApplicationError>;
  phase: "subscribing" | "rehydrating" | "active" | "retired";
}
interface ReadFlight {
  readonly generation: Generation;
  readonly done: Deferred.Deferred<void>;
  dirty: boolean;
}
interface ReadRecord {
  readonly kind: "list" | "chats" | "transcript";
  readonly run: (flight: ReadFlight) => Effect.Effect<void>;
  generation: Generation | undefined;
  flight: ReadFlight | undefined;
}
type ContextReadError = ReadError | ChatClosed;
type HistoryReadError = ReadError | ChatClosed;
interface ChatRecord {
  readonly live: LiveChat;
  readonly transcriptResult: AsyncResult.AsyncResult<TranscriptSnapshot, ReadError>;
  readonly contextResult: AsyncResult.AsyncResult<ContextUsage, ContextReadError>;
  readonly contextRequest: number;
  readonly historyReplacing: boolean;
  readonly historyEpoch: number;
}
interface ChatRead extends ReadRecord {
  readonly chatId: ChatId;
  readonly accept: (envelope: AgentEventEnvelope, generation: Generation) => void;
  readonly buffer: (generation: Generation) => void;
  readonly replaceSnapshot: (generation: Generation, snapshot: TranscriptSnapshot) => boolean;
}
const decodePrompt = Schema.decodeUnknownEffect(AgentPrompt);
const unavailableError = () =>
  new ApplicationError({
    reason: "operation",
    message: "Connection changed before confirmation. Check the conversation before sending again.",
  });
const domainFailure = (cause: Cause.Cause<unknown>) =>
  cause.reasons.every(
    (reason) =>
      reason._tag === "Fail" &&
      !(reason.error instanceof RpcClientError) &&
      !(reason.error instanceof Cause.TimeoutError),
  );
const clearWaiting = <A, E>(
  result: AsyncResult.AsyncResult<A, E>,
): AsyncResult.AsyncResult<A, E> => {
  if (!result.waiting) return result;
  switch (result._tag) {
    case "Initial":
      return AsyncResult.initial();
    case "Success":
      return AsyncResult.success(result.value);
    case "Failure":
      return AsyncResult.failure(result.cause, { previousSuccess: result.previousSuccess });
  }
};

/** Construct once per page and dispose its registry at page shutdown. */
export const make = ({ url }: { readonly url: string }) => {
  const status = Atom.make<Connection>({ kind: "opening" }).pipe(Atom.keepAlive);
  const chatCell = Atom.family((_chatId: ChatId) =>
    Atom.make<ChatRecord>({
      live: emptyLiveChat(),
      transcriptResult: AsyncResult.initial(),
      contextResult: AsyncResult.initial(),
      contextRequest: 0,
      historyReplacing: false,
      historyEpoch: 0,
    }).pipe(Atom.keepAlive),
  );

  const owner = Atom.make((get) =>
    Effect.gen(function* () {
      const registry = get.registry;
      const pageScope = yield* Effect.scope;
      const reads = new Set<ReadRecord>();
      const chatReads = new Map<ChatId, ChatRead>();
      let current: Generation | undefined;
      let closing: Generation | undefined;
      let attempt: Deferred.Deferred<void, ApplicationError> | undefined;
      let disposed = false;
      get.addFinalizer(() => {
        disposed = true;
        if (current !== undefined) current.phase = "retired";
        current = undefined;
      });
      const isCurrent = (generation: Generation) =>
        !disposed && current === generation && generation.phase !== "retired";
      const update = <A>(atom: Atom.Writable<A>, change: (value: A) => A) => {
        if (!disposed) registry.update(atom, change);
      };
      const retire = (generation: Generation, cause: Cause.Cause<unknown>) => {
        if (!isCurrent(generation)) return;
        generation.phase = "retired";
        current = undefined;
        closing = generation;
        Deferred.doneUnsafe(generation.ready, Effect.fail(unavailableError()));
        Deferred.doneUnsafe(generation.retired, Effect.fail(unavailableError()));
        registry.set(status, { kind: "unavailable", cause });
      };
      const close = (generation: Generation) =>
        Scope.close(generation.scope, Exit.void).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              if (closing === generation) closing = undefined;
            }),
          ),
        );
      const fail = (generation: Generation, cause: Cause.Cause<unknown>) =>
        Effect.gen(function* () {
          if (!isCurrent(generation)) return;
          retire(generation, cause);
          yield* close(generation).pipe(Effect.forkIn(pageScope));
        });
      const refresh = (
        record: ReadRecord,
        generation: Generation,
        invalidate = true,
      ): Effect.Effect<void> =>
        Effect.suspend(() => {
          if (!isCurrent(generation)) return Effect.void;
          const pending = record.flight;
          if (pending?.generation === generation) {
            if (invalidate) pending.dirty = true;
            return Deferred.await(pending.done);
          }
          const flight = { generation, done: Deferred.makeUnsafe<void>(), dirty: false };
          record.flight = flight;
          return Effect.gen(function* () {
            do {
              flight.dirty = false;
              yield* record.run(flight);
              if (isCurrent(generation)) record.generation = generation;
            } while (flight.dirty && isCurrent(generation));
          }).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                if (record.flight === flight) record.flight = undefined;
                Deferred.doneUnsafe(flight.done, Effect.void);
              }),
            ),
            Effect.forkIn(generation.scope),
            Effect.andThen(Deferred.await(flight.done)),
          );
        });
      const invalidate = (record: ReadRecord, generation: Generation) =>
        refresh(record, generation).pipe(Effect.forkIn(generation.scope), Effect.asVoid);
      const onEvent = (envelope: AgentEventEnvelope, generation: Generation) =>
        Effect.gen(function* () {
          if (!isCurrent(generation)) return;
          if (envelope.event.type === "title-changed") {
            yield* Effect.forEach(
              reads,
              (record) => (record.kind === "chats" ? invalidate(record, generation) : Effect.void),
              { discard: true },
            );
            return;
          }
          const record = chatReads.get(envelope.chatId);
          if (record === undefined) return;
          record.accept(envelope, generation);
          if (
            envelope.event.type === "message-settled" ||
            envelope.event.type === "run-finished" ||
            envelope.event.type === "context-invalidated" ||
            envelope.event.type === "history-replaced"
          )
            yield* invalidate(record, generation);
        });
      const establish = Effect.fn("FrontendState.establish")(function* () {
        const scope = yield* Scope.fork(pageScope);
        const opened = yield* RpcClient.make(url).pipe(Scope.provide(scope), Effect.exit);
        if (Exit.isFailure(opened)) {
          yield* Scope.close(scope, Exit.void);
          return yield* Effect.failCause(opened.cause);
        }
        const generation: Generation = {
          scope,
          client: opened.value,
          ready: Deferred.makeUnsafe<void, ApplicationError>(),
          retired: Deferred.makeUnsafe<never, ApplicationError>(),
          phase: "subscribing",
        };
        if (disposed) {
          yield* close(generation);
          return yield* Effect.interrupt;
        }
        current = generation;
        for (const record of chatReads.values()) record.buffer(generation);
        yield* generation.client.Events().pipe(
          Stream.runForEach((frame) =>
            frame.kind === "ready"
              ? Effect.sync(() => {
                  if (isCurrent(generation) && generation.phase === "subscribing") {
                    generation.phase = "rehydrating";
                    Deferred.doneUnsafe(generation.ready, Effect.void);
                  }
                })
              : onEvent(frame.envelope, generation),
          ),
          Effect.andThen(Effect.die(new Error("RPC Events stream ended"))),
          Effect.catchCause((cause) => fail(generation, cause)),
          Effect.forkIn(scope),
        );
        yield* Deferred.await(generation.ready);
        while (isCurrent(generation)) {
          const pending = [...reads].filter((record) => record.generation !== generation);
          if (pending.length === 0) break;
          yield* Effect.forEach(pending, (record) => refresh(record, generation, false), {
            concurrency: "unbounded",
            discard: true,
          });
        }
        if (!isCurrent(generation)) return yield* unavailableError();
        generation.phase = "active";
        registry.set(status, { kind: "active" });
      });
      const ensure = (): Effect.Effect<void, ApplicationError> =>
        Effect.suspend(() => {
          if (disposed) return Effect.interrupt;
          if (attempt !== undefined) return Deferred.await(attempt);
          const joined = Deferred.makeUnsafe<void, ApplicationError>();
          attempt = joined;
          return Effect.gen(function* () {
            const previous = current;
            if (previous?.phase === "active") {
              const probe = yield* previous.client
                .ListWorkspaces()
                .pipe(Effect.timeout("3 seconds"), Effect.exit);
              if (isCurrent(previous) && (Exit.isSuccess(probe) || domainFailure(probe.cause)))
                return;
              retire(
                previous,
                Exit.isFailure(probe)
                  ? probe.cause
                  : Cause.die(new Error("Events subscription ended")),
              );
              yield* close(previous);
            }
            if (closing !== undefined) yield* close(closing);
            yield* establish();
          }).pipe(
            Effect.timeout("12 seconds"),
            Effect.catchCause((cause) =>
              Effect.gen(function* () {
                const generation = current;
                if (generation !== undefined) {
                  retire(generation, cause);
                  yield* close(generation);
                }
                if (!disposed) registry.set(status, { kind: "unavailable", cause });
                return yield* unavailableError();
              }),
            ),
            Effect.onExit((exit) =>
              Effect.sync(() => {
                if (attempt === joined) attempt = undefined;
                Deferred.doneUnsafe(joined, exit);
              }),
            ),
            Effect.forkIn(pageScope),
            Effect.andThen(Deferred.await(joined)),
          );
        });
      const read = (record: ReadRecord) =>
        Effect.gen(function* () {
          reads.add(record);
          const previous = current;
          if (previous?.phase !== "active") {
            yield* ensure().pipe(Effect.ignore);
            if (record.generation === current) return;
          }
          const generation = current;
          if (generation === undefined) return;
          yield* refresh(record, generation);
        });
      const registerChat = (record: ChatRead) => {
        reads.add(record);
        chatReads.set(record.chatId, record);
        if (current !== undefined && record.generation !== current) record.buffer(current);
      };
      const write = <A, E>(
        execute: (client: Client) => Effect.Effect<A, E>,
        commit?: (value: A) => void,
        settled?: () => void,
      ) =>
        Effect.gen(function* () {
          if (registry.get(status).kind === "opening") yield* ensure();
          const generation = current;
          if (generation?.phase !== "active" || !isCurrent(generation))
            return yield* unavailableError();
          const exit = yield* Effect.raceFirst(
            execute(generation.client),
            Deferred.await(generation.retired),
          ).pipe(Effect.exit);
          if (!isCurrent(generation)) return yield* unavailableError();
          if (Exit.isFailure(exit)) {
            if (!Cause.hasInterruptsOnly(exit.cause) && !domainFailure(exit.cause))
              yield* fail(generation, exit.cause);
            else settled?.();
            return yield* exit;
          }
          commit?.(exit.value);
          settled?.();
          return exit.value;
        });
      const applyHistorySnapshot = (chatId: ChatId, snapshot: TranscriptSnapshot): boolean => {
        const generation = current;
        if (generation?.phase !== "active" || !isCurrent(generation)) return false;
        const record = chatReads.get(chatId);
        if (record === undefined) return false;
        return record.replaceSnapshot(generation, snapshot);
      };
      yield* ensure().pipe(Effect.ignore, Effect.forkIn(pageScope));
      return {
        ensure,
        read,
        registerChat,
        applyHistorySnapshot,
        isCurrent,
        fail,
        update,
        write,
      };
    }),
  ).pipe(Atom.keepAlive);

  const connection = Atom.readable((get): Connection => {
    const value = get(owner);
    return value._tag === "Failure" ? { kind: "unavailable", cause: value.cause } : get(status);
  }).pipe(Atom.keepAlive);
  const ensure = Atom.fn<void>()(
    (_input, get) =>
      Effect.gen(function* () {
        const manager = yield* get.result(owner);
        yield* manager.ensure();
      }),
    { concurrent: true },
  ).pipe(Atom.keepAlive, Atom.setLazy(false));

  const list = <A, E = never>(
    execute: (client: Client) => Effect.Effect<A, E | ReadError>,
    kind: ReadRecord["kind"] = "list",
    options: { readonly fastTimeout?: boolean } = {},
  ) => {
    const result = Atom.make<AsyncResult.AsyncResult<A, E | ReadError>>(AsyncResult.initial()).pipe(
      Atom.keepAlive,
    );
    const record = Atom.make(
      (get): ReadRecord => ({
        kind,
        generation: undefined,
        flight: undefined,
        run: (flight) =>
          Effect.gen(function* () {
            const { generation } = flight;
            const manager = yield* get.resultOnce(owner);
            if (!manager.isCurrent(generation)) return;
            get.registry.update(result, AsyncResult.waiting);
            const outcome = yield* options.fastTimeout === false
              ? execute(generation.client).pipe(Effect.exit, Effect.map(Option.some))
              : execute(generation.client).pipe(Effect.exit, Effect.timeoutOption("5 seconds"));
            if (!manager.isCurrent(generation)) return;
            const exit = Option.isSome(outcome) ? outcome.value : Exit.fail(unavailableError());
            if (!flight.dirty || Exit.isFailure(exit))
              get.registry.update(result, (previous) =>
                Exit.isSuccess(exit)
                  ? AsyncResult.success(exit.value)
                  : AsyncResult.failureWithPrevious(exit.cause, {
                      previous: Option.some(previous),
                    }),
              );
            if (Exit.isFailure(exit) && (Option.isNone(outcome) || !domainFailure(exit.cause)))
              yield* manager.fail(
                generation,
                Option.isNone(outcome) ? Cause.fail(new Cause.TimeoutError()) : exit.cause,
              );
          }),
      }),
    ).pipe(Atom.keepAlive);
    const read = Atom.make((get) =>
      Effect.gen(function* () {
        const manager = yield* get.resultOnce(owner);
        yield* manager.read(get.once(record));
      }),
    ).pipe(Atom.keepAlive, Atom.setLazy(false));
    return Atom.writable(
      (get) => {
        if (!get.registry.getNodes().has(read)) get.once(read);
        return get(result);
      },
      (get, change: (value: A) => A) => {
        const pending = get.get(record).flight;
        if (pending !== undefined) pending.dirty = true;
        get.set(result, AsyncResult.map(get.get(result), change));
      },
      (refresh) => refresh(read),
    ).pipe(Atom.keepAlive);
  };
  const workspaces = list<readonly Workspace[]>((client) => client.ListWorkspaces());
  const chats = Atom.family((workspaceId: WorkspaceId) =>
    list<readonly ChatListEntry[]>((client) => client.ListChats({ workspaceId }), "chats"),
  );
  const schedules = list<ScheduleOverviewResponse, ScheduleError>((client) =>
    client.ListSchedules(),
  );

  const outsideSnapshot = (envelope: AgentEventEnvelope) =>
    envelope.event.type === "notice" ||
    (envelope.origin === "delivery" && envelope.event.type === "message-settled");
  const transcriptRecord = Atom.family((chatId: ChatId) =>
    Atom.make((get): ChatRead => {
      const cell = chatCell(chatId);
      let buffered:
        | {
            readonly generation: Generation;
            readonly baseline: LiveChat;
            readonly events: AgentEventEnvelope[];
          }
        | undefined;
      let cut:
        | {
            readonly generation: Generation;
            readonly publication: Publication;
            readonly replacement: Publication | undefined;
          }
        | undefined;
      const reduce = (live: LiveChat, envelope: AgentEventEnvelope) => {
        if (envelope.event.type === "title-changed") return live;
        if (
          envelope.origin === "delivery" &&
          (envelope.event.type === "run-started" || envelope.event.type === "run-finished")
        )
          return live;
        return reduceLiveChat(live, envelope.event);
      };
      const reconcile = (
        generation: Generation,
        snapshot: TranscriptSnapshot,
        replacement = false,
      ): boolean => {
        const publication = snapshot.runtime.publication;
        if (cut?.generation === generation && publication < cut.publication) return false;
        const pending = buffered?.generation === generation ? buffered : undefined;
        Atom.batch(() =>
          get.registry.update(cell, (state) => {
            const previous = AsyncResult.value(state.transcriptResult);
            const replacing =
              (replacement ||
                (Option.isSome(previous) &&
                  previous.value.historyRevision !== snapshot.historyRevision)) &&
              !(
                state.historyReplacing &&
                cut?.generation === generation &&
                cut.replacement !== undefined
              );
            const historyChanged =
              replacing ||
              cut === undefined ||
              cut.generation !== generation ||
              publication > cut.publication;
            let baseline = pending?.baseline ?? state.live;
            if (replacing) baseline = replaceHistory(baseline);
            else
              for (const envelope of pending?.events ?? [])
                if (envelope.publication <= publication) baseline = reduce(baseline, envelope);
            baseline = rehydrateChat({ ...baseline, notices: state.live.notices }, snapshot);
            const events = pending?.events.filter((event) => event.publication > publication) ?? [];
            let live = baseline;
            for (const envelope of events) live = reduce(live, envelope);
            cut = {
              generation,
              publication,
              replacement: replacing
                ? publication
                : cut?.generation === generation
                  ? cut.replacement
                  : undefined,
            };
            buffered = { generation, baseline, events };
            return {
              ...state,
              live,
              historyReplacing: false,
              historyEpoch: state.historyEpoch + Number(historyChanged),
              transcriptResult: AsyncResult.success(snapshot),
            };
          }),
        );
        return true;
      };
      return {
        kind: "transcript",
        chatId,
        generation: undefined,
        flight: undefined,
        buffer: (generation) => {
          if (buffered?.generation === generation) return;
          buffered = { generation, baseline: get.registry.get(cell).live, events: [] };
          get.registry.update(cell, (state) => ({ ...state, historyReplacing: true }));
        },
        replaceSnapshot: (generation, snapshot) => reconcile(generation, snapshot, true),
        accept: (envelope, generation) => {
          if (
            cut?.generation === generation &&
            envelope.publication <= cut.publication &&
            (!outsideSnapshot(envelope) ||
              (envelope.event.type !== "notice" &&
                cut.replacement !== undefined &&
                envelope.publication <= cut.replacement))
          )
            return;
          if (
            envelope.event.type !== "notice" &&
            envelope.event.type !== "history-replaced" &&
            buffered?.generation === generation
          )
            buffered.events.push(envelope);
          Atom.batch(() =>
            get.registry.update(cell, (state) => {
              const live = reduce(state.live, envelope);
              return {
                ...state,
                live: cut?.generation === generation ? live : unconfirmChat(live),
                historyReplacing:
                  state.historyReplacing || envelope.event.type === "history-replaced",
                historyEpoch:
                  state.historyEpoch + Number(envelope.event.type === "history-replaced"),
                transcriptResult:
                  envelope.event.type === "history-replaced"
                    ? AsyncResult.waiting(state.transcriptResult)
                    : state.transcriptResult,
              };
            }),
          );
          if (envelope.event.type === "history-replaced") {
            cut = {
              generation,
              publication: envelope.publication,
              replacement: envelope.publication,
            };
            buffered = { generation, baseline: get.registry.get(cell).live, events: [] };
          }
        },
        run: (flight) =>
          Effect.gen(function* () {
            const { generation } = flight;
            const manager = yield* get.resultOnce(owner);
            if (!manager.isCurrent(generation)) return;
            if (buffered?.generation !== generation)
              buffered = { generation, baseline: get.registry.get(cell).live, events: [] };
            const pending = buffered;
            get.registry.update(cell, (state) => ({
              ...state,
              transcriptResult: AsyncResult.waiting(state.transcriptResult),
            }));
            const exit = yield* generation.client
              .Transcript({ chatId })
              .pipe(Effect.timeout("5 seconds"), Effect.exit);
            if (!manager.isCurrent(generation) || buffered !== pending) return;
            if (Exit.isFailure(exit)) {
              get.registry.update(cell, (state) => ({
                ...state,
                live: unconfirmChat(state.live),
                transcriptResult: AsyncResult.failureWithPrevious(
                  Cause.map(exit.cause, (error) =>
                    error._tag === "TimeoutError" ? unavailableError() : error,
                  ),
                  { previous: Option.some(state.transcriptResult) },
                ),
              }));
              if (!domainFailure(exit.cause)) yield* manager.fail(generation, exit.cause);
              return;
            }
            const currentModel = Option.match(
              AsyncResult.value(get.registry.get(cell).transcriptResult),
              { onNone: () => null, onSome: (snapshot) => snapshot.currentModel },
            );
            reconcile(generation, flight.dirty ? { ...exit.value, currentModel } : exit.value);
          }),
      };
    }).pipe(Atom.keepAlive),
  );
  const observeContext = Atom.family((chatId: ChatId) =>
    Atom.make((get) =>
      Effect.gen(function* () {
        const manager = yield* get.result(owner);
        const cell = chatCell(chatId);
        let active = true;
        let closed = false;
        let revision = 0;
        let statusKind = get.registry.get(status).kind;
        let transcriptResult = get.registry.get(cell).transcriptResult;
        let contextRequest = get.registry.get(cell).contextRequest;
        let wake = Deferred.makeUnsafe<void>();

        const signal = () => {
          revision += 1;
          Deferred.doneUnsafe(wake, Effect.void);
        };
        const publish = (change: (state: ChatRecord) => ChatRecord) => {
          if (active) get.registry.update(cell, change);
        };

        get.addFinalizer(() => {
          active = false;
          Deferred.doneUnsafe(wake, Effect.void);
          if (!get.registry.get(cell).contextResult.waiting) return;
          get.registry.update(cell, (state) => ({
            ...state,
            contextResult: clearWaiting(state.contextResult),
          }));
        });

        get.subscribe(status, (next) => {
          if (statusKind !== "active" && next.kind === "active") signal();
          statusKind = next.kind;
        });
        get.subscribe(cell, (next) => {
          if (next.contextRequest !== contextRequest) {
            contextRequest = next.contextRequest;
            signal();
          }
          if (next.transcriptResult !== transcriptResult) {
            transcriptResult = next.transcriptResult;
            if (next.transcriptResult._tag === "Success" && !next.transcriptResult.waiting)
              signal();
          }
        });

        while (active && !closed) {
          wake = Deferred.makeUnsafe<void>();
          if (get.registry.get(status).kind !== "active") {
            const ensured = yield* manager.ensure().pipe(Effect.exit);
            if (Exit.isFailure(ensured)) {
              if (!active) break;
              publish((state) => ({
                ...state,
                contextResult: AsyncResult.failureWithPrevious(ensured.cause, {
                  previous: Option.some(state.contextResult),
                }),
              }));
              yield* Effect.raceFirst(Deferred.await(wake), Effect.sleep("1 minute"));
              continue;
            }
          }
          if (!active) break;
          const requestRevision = revision;
          wake = Deferred.makeUnsafe<void>();
          publish((state) => ({
            ...state,
            contextResult: AsyncResult.waiting(state.contextResult),
          }));
          const exit = yield* manager
            .write((client) =>
              client.ContextUsage({ chatId }).pipe(
                Effect.timeout("30 seconds"),
                Effect.catchTag("TimeoutError", () =>
                  Effect.fail(
                    new ApplicationError({
                      reason: "operation",
                      message: "Context estimate timed out.",
                    }),
                  ),
                ),
              ),
            )
            .pipe(Effect.exit);
          if (!active) break;
          if (requestRevision !== revision) continue;
          if (Exit.isSuccess(exit)) {
            publish((state) => ({ ...state, contextResult: AsyncResult.success(exit.value) }));
          } else if (!Cause.hasInterruptsOnly(exit.cause)) {
            publish((state) => ({
              ...state,
              contextResult: AsyncResult.failureWithPrevious(exit.cause, {
                previous: Option.some(state.contextResult),
              }),
            }));
            if (Option.getOrNull(Cause.findErrorOption(exit.cause)) instanceof ChatClosed) {
              closed = true;
            }
          }
          if (closed) continue;
          yield* Effect.raceFirst(Deferred.await(wake), Effect.sleep("1 minute"));
        }
      }),
    ).pipe(Atom.setIdleTTL(0)),
  );
  const availableModels = Atom.family((chatId: ChatId) =>
    list<readonly ModelInfo[], ChatClosed>((client) => client.AvailableModels({ chatId })),
  );
  const availableSkills = Atom.family((chatId: ChatId) =>
    list<readonly SkillCommand[], ChatClosed>(
      (client) =>
        client.AvailableSkills({ chatId }).pipe(
          Effect.timeout("30 seconds"),
          Effect.catchTag("TimeoutError", () =>
            Effect.fail(
              new ApplicationError({
                reason: "operation",
                message: "Skill catalog timed out.",
              }),
            ),
          ),
        ),
      "list",
      { fastTimeout: false },
    ),
  );
  const transcriptRead = Atom.family((chatId: ChatId) =>
    Atom.make((get) =>
      Effect.gen(function* () {
        const manager = yield* get.resultOnce(owner);
        const record = get.once(transcriptRecord(chatId));
        manager.registerChat(record);
        yield* manager.read(record);
      }),
    ).pipe(Atom.keepAlive, Atom.setLazy(false)),
  );
  const snapshot = Atom.family((chatId: ChatId) =>
    Atom.readable(
      (get) => {
        const read = transcriptRead(chatId);
        if (!get.registry.getNodes().has(read)) get.once(read);
        return get(chatCell(chatId)).transcriptResult;
      },
      (refresh) => refresh(transcriptRead(chatId)),
    ).pipe(Atom.keepAlive),
  );
  const transcript = Atom.family((chatId: ChatId) =>
    Atom.readable(
      (get) => AsyncResult.map(get(snapshot(chatId)), (value) => value.messages),
      (refresh) => refresh(snapshot(chatId)),
    ).pipe(Atom.keepAlive),
  );
  const todo = Atom.family((chatId: ChatId) =>
    Atom.readable(
      (get) => AsyncResult.map(get(snapshot(chatId)), (value) => value.todo),
      (refresh) => refresh(snapshot(chatId)),
    ).pipe(Atom.keepAlive),
  );
  const contextUsage = Atom.family((chatId: ChatId) =>
    Atom.writable(
      (get) => get(chatCell(chatId)).contextResult,
      (get, _input: undefined) => {
        const state = get.get(chatCell(chatId));
        get.set(chatCell(chatId), { ...state, contextRequest: state.contextRequest + 1 });
      },
    ).pipe(Atom.keepAlive),
  );
  const modelSwitchRequest = Atom.family((_chatId: ChatId) =>
    Atom.make<ModelRef | null>(null).pipe(Atom.keepAlive),
  );
  const switchModel = Atom.family((chatId: ChatId) =>
    Atom.fn<ModelRef>()((model, get) =>
      Effect.gen(function* () {
        get.set(modelSwitchRequest(chatId), model);
        const manager = yield* get.result(owner);
        return yield* manager.write(
          (client) => client.SwitchModel({ chatId, model }),
          (result) => {
            const pending = get.registry.get(transcriptRecord(chatId)).flight;
            if (pending !== undefined) pending.dirty = true;
            get.registry.update(chatCell(chatId), (current) => ({
              ...current,
              transcriptResult: AsyncResult.map(current.transcriptResult, (snapshot) => ({
                ...snapshot,
                currentModel: result.model,
              })),
            }));
          },
          () => get.registry.refresh(transcriptRead(chatId)),
        );
      }),
    ).pipe(Atom.keepAlive, Atom.setLazy(false)),
  );
  const currentModel = Atom.family((chatId: ChatId) =>
    Atom.readable(
      (get) => {
        const result = AsyncResult.map(get(snapshot(chatId)), (value) => value.currentModel);
        const current = AsyncResult.value(result);
        if (Option.isSome(current) && current.value !== null) return result;
        const switched = Option.map(
          AsyncResult.value(get(switchModel(chatId))),
          (selection) => selection.model,
        );
        if (Option.isNone(switched)) return result;
        switch (result._tag) {
          case "Initial":
            return AsyncResult.success(switched.value, { waiting: result.waiting });
          case "Failure":
            return AsyncResult.failure(result.cause, {
              waiting: result.waiting,
              previousSuccess: Option.some(AsyncResult.success(switched.value)),
            });
          case "Success":
            return AsyncResult.success(switched.value, result);
        }
      },
      (refresh) => refresh(snapshot(chatId)),
    ).pipe(Atom.keepAlive),
  );
  const live = Atom.family((chatId: ChatId) =>
    Atom.readable((get): LiveChat => {
      get(snapshot(chatId));
      const value = get(chatCell(chatId)).live;
      return get(connection).kind !== "active" ? unconfirmChat(value) : value;
    }).pipe(Atom.keepAlive),
  );
  const historyReplacing = Atom.family((chatId: ChatId) =>
    Atom.readable((get) => {
      get(snapshot(chatId));
      return get(chatCell(chatId)).historyReplacing;
    }).pipe(Atom.keepAlive),
  );

  const createWorkspace = Atom.fn<CreateWorkspace>()((input, get) =>
    Effect.gen(function* () {
      const manager = yield* get.result(owner);
      return yield* manager.write(
        (client) => client.CreateWorkspace(input),
        () => get.registry.refresh(workspaces),
      );
    }),
  ).pipe(Atom.keepAlive, Atom.setLazy(false));
  const updateWorkspace = Atom.fn<UpdateWorkspace>()((input, get) =>
    Effect.gen(function* () {
      const manager = yield* get.result(owner);
      return yield* manager.write(
        (client) => client.UpdateWorkspace(input),
        (workspace) =>
          get.set(workspaces, (current) =>
            current.map((existing) => (existing.id === workspace.id ? workspace : existing)),
          ),
        () => get.registry.refresh(workspaces),
      );
    }),
  ).pipe(Atom.keepAlive, Atom.setLazy(false));
  const deleteWorkspace = Atom.fn<{ readonly workspaceId: WorkspaceId }>()((input, get) =>
    Effect.gen(function* () {
      const manager = yield* get.result(owner);
      return yield* manager.write(
        (client) => client.DeleteWorkspace(input),
        () =>
          get.set(workspaces, (current) =>
            current.filter((workspace) => workspace.id !== input.workspaceId),
          ),
        () => get.registry.refresh(workspaces),
      );
    }),
  ).pipe(Atom.keepAlive, Atom.setLazy(false));
  const createChat = Atom.family((workspaceId: WorkspaceId) =>
    Atom.fn<Omit<CreateChat, "workspaceId">>()((input, get) =>
      Effect.gen(function* () {
        const manager = yield* get.result(owner);
        return yield* manager.write(
          (client) => client.CreateChat({ ...input, workspaceId }),
          () => get.registry.refresh(chats(workspaceId)),
        );
      }),
    ).pipe(Atom.keepAlive, Atom.setLazy(false)),
  );
  const closeChat = Atom.family((workspaceId: WorkspaceId) =>
    Atom.fn<CloseChatOptions & { readonly chatId: ChatId }>()((input, get) =>
      Effect.gen(function* () {
        const manager = yield* get.result(owner);
        return yield* manager.write(
          (client) => client.CloseChat(input),
          (result) => {
            if (result.kind === "closed")
              get.set(chats(workspaceId), (current) =>
                current.filter((chat) => chat.id !== input.chatId),
              );
          },
          () => get.registry.refresh(chats(workspaceId)),
        );
      }),
    ).pipe(Atom.keepAlive, Atom.setLazy(false)),
  );

  const latestHistoryRead = <Input, Value>(
    execute: (
      client: Client,
      chatId: ChatId,
      input: Input,
    ) => Effect.Effect<Value, HistoryReadError>,
  ) =>
    Atom.family((chatId: ChatId) => {
      type Request = { readonly input: Input; readonly request: number };
      const lane = Atom.make<{
        readonly input: Option.Option<Input>;
        readonly request: number;
        readonly historyEpoch: number;
        readonly result: AsyncResult.AsyncResult<Value, HistoryReadError>;
      }>({ input: Option.none(), request: 0, historyEpoch: 0, result: AsyncResult.initial() }).pipe(
        Atom.keepAlive,
      );
      const trigger = Atom.fn<Request>()(({ input, request }, get) =>
        Effect.gen(function* () {
          const manager = yield* get.result(owner);
          yield* manager
            .write((client) => execute(client, chatId, input))
            .pipe(
              Effect.onExit((exit) =>
                Effect.sync(() =>
                  manager.update(lane, (current) =>
                    current.request !== request
                      ? current
                      : {
                          ...current,
                          result: Exit.isFailure(exit)
                            ? AsyncResult.failure<Value, HistoryReadError>(exit.cause)
                            : AsyncResult.success(exit.value),
                        },
                  ),
                ),
              ),
            );
        }),
      ).pipe(Atom.keepAlive, Atom.setLazy(false));
      const dispatch = Atom.make((get) => {
        let pending: Request | typeof Atom.Interrupt | undefined;
        get.addFinalizer(() => {
          pending = undefined;
        });
        return (next: Request | typeof Atom.Interrupt) => {
          const scheduled = pending !== undefined;
          pending = next;
          if (scheduled) return;
          // Atom.fn must start outside the batch that notifies history observers.
          queueMicrotask(() => {
            const latest = pending;
            pending = undefined;
            if (latest !== undefined) get.registry.set(trigger, latest);
          });
        };
      }).pipe(Atom.keepAlive);
      const observe = Atom.make((get) => {
        get.once(snapshot(chatId));
        const cell = chatCell(chatId);
        let epoch = get.registry.get(cell).historyEpoch;
        const refresh = () => {
          const current = get.registry.get(lane);
          if (Option.isNone(current.input) || current.historyEpoch === epoch) return;
          const active = get.registry.get(status).kind === "active";
          const request = current.request + 1;
          get.registry.set(lane, {
            ...current,
            request,
            historyEpoch: active ? epoch : current.historyEpoch,
            result: AsyncResult.initial(true),
          });
          get.once(dispatch)(active ? { input: current.input.value, request } : Atom.Interrupt);
        };
        get.subscribe(cell, (next) => {
          if (epoch === next.historyEpoch) return;
          epoch = next.historyEpoch;
          refresh();
        });
        get.subscribe(status, (next) => {
          if (next.kind === "active") refresh();
        });
        refresh();
      }).pipe(Atom.setIdleTTL(0));
      return Atom.writable(
        (get) => {
          get(observe);
          return get(lane).result;
        },
        (get, input: Input) => {
          const request = get.get(lane).request + 1;
          get.set(lane, {
            input: Option.some(input),
            request,
            historyEpoch: get.get(chatCell(chatId)).historyEpoch,
            result: AsyncResult.initial(true),
          });
          get.get(dispatch)({ input, request });
        },
      ).pipe(Atom.setIdleTTL(0));
    });
  const history = latestHistoryRead((client, chatId, query: ChatHistoryRequest["query"]) =>
    client.ChatHistory({ chatId, query }),
  );
  const previewHistory = latestHistoryRead(
    (client, chatId, targetId: NavigateChatHistoryRequest["targetId"]) =>
      client.PreviewChatHistory({ chatId, targetId }),
  );

  const navigateHistory = Atom.family((chatId: ChatId) => {
    const lane = Atom.make<{
      readonly pending: number;
      readonly result: AsyncResult.AsyncResult<NavigateHistoryResult, HistoryReadError>;
    }>({ pending: 0, result: AsyncResult.initial() }).pipe(Atom.keepAlive);
    const trigger = Atom.fn<Omit<NavigateChatHistoryRequest, "chatId">>()(
      (input, get) =>
        Effect.gen(function* () {
          const manager = yield* get.result(owner);
          let accepted = false;
          yield* manager
            .write(
              (client) => client.NavigateChatHistory({ chatId, ...input }),
              (result) => {
                if (result.kind === "applied") {
                  accepted = manager.applyHistorySnapshot(chatId, result.snapshot);
                }
              },
            )
            .pipe(
              Effect.map(
                (result): NavigateHistoryResult =>
                  result.kind === "applied" && !accepted ? { kind: "cancelled" } : result,
              ),
              Effect.onExit((exit) =>
                Effect.sync(() =>
                  manager.update(lane, (current) => {
                    const pending = current.pending - 1;
                    const waiting = pending > 0;
                    const result = AsyncResult.isFailure(current.result)
                      ? AsyncResult.failure(current.result.cause, {
                          previousSuccess: current.result.previousSuccess,
                          waiting,
                        })
                      : Exit.isFailure(exit)
                        ? AsyncResult.failure<NavigateHistoryResult, HistoryReadError>(exit.cause, {
                            waiting,
                          })
                        : AsyncResult.success<NavigateHistoryResult, HistoryReadError>(exit.value, {
                            waiting,
                          });
                    return { pending, result };
                  }),
                ),
              ),
            );
        }),
      { concurrent: true },
    ).pipe(Atom.keepAlive, Atom.setLazy(false));
    return Atom.writable(
      (get) => get(lane).result,
      (get, input: Omit<NavigateChatHistoryRequest, "chatId">) => {
        get.set(lane, {
          pending: get.get(lane).pending + 1,
          result:
            get.get(lane).pending === 0
              ? AsyncResult.initial(true)
              : AsyncResult.waiting(get.get(lane).result),
        });
        get.set(trigger, input);
      },
    ).pipe(Atom.keepAlive);
  });

  const command = <Input, Error>(
    chatId: ChatId,
    execute: (client: Client, input: Input) => Effect.Effect<void, Error>,
  ) => {
    const lane = Atom.make<{
      readonly pending: number;
      readonly result: AsyncResult.AsyncResult<void, Error | ReadError>;
    }>({ pending: 0, result: AsyncResult.initial() }).pipe(Atom.keepAlive);
    const trigger = Atom.fn<Input>()(
      (input, get) =>
        Effect.gen(function* () {
          const manager = yield* get.result(owner);
          yield* manager
            .write(
              (client) => execute(client, input),
              undefined,
              () => get.registry.refresh(transcriptRead(chatId)),
            )
            .pipe(
              Effect.onExit((exit) =>
                Effect.sync(() =>
                  manager.update(lane, (current) => {
                    const pending = current.pending - 1;
                    const waiting = pending > 0;
                    const result = AsyncResult.isFailure(current.result)
                      ? AsyncResult.failure(current.result.cause, {
                          previousSuccess: current.result.previousSuccess,
                          waiting,
                        })
                      : Exit.isFailure(exit)
                        ? AsyncResult.failure<void, Error | ReadError>(exit.cause, { waiting })
                        : AsyncResult.success<void, Error | ReadError>(undefined, { waiting });
                    return { pending, result };
                  }),
                ),
              ),
            );
        }),
      { concurrent: true },
    ).pipe(Atom.keepAlive, Atom.setLazy(false));
    return Atom.writable(
      (get) => get(lane).result,
      (get, input: Input) => {
        get.set(lane, {
          pending: get.get(lane).pending + 1,
          result:
            get.get(lane).pending === 0
              ? AsyncResult.initial(true)
              : AsyncResult.waiting(get.get(lane).result),
        });
        get.set(trigger, input);
      },
    ).pipe(Atom.keepAlive);
  };
  const send = Atom.family((chatId: ChatId) =>
    command(
      chatId,
      Effect.fn("FrontendState.send")(function* (client: Client, prompt: AgentPrompt) {
        const validated = yield* decodePrompt(prompt);
        yield* client.SendMessage({ chatId, prompt: validated });
      }),
    ),
  );
  const abort = Atom.family((chatId: ChatId) =>
    command(chatId, (client: Client, _input: undefined) => client.Abort({ chatId })),
  );
  const shake = Effect.fn("FrontendState.shake")(function* (
    registry: AtomRegistry.AtomRegistry,
    chatId: ChatId,
    mode: ShakeMode,
  ) {
    const manager = yield* AtomRegistry.getResult(registry, owner, { suspendOnWaiting: true });
    return yield* manager.write(
      (client) => client.Shake({ chatId, mode }),
      undefined,
      () => registry.refresh(transcriptRead(chatId)),
    );
  });

  return {
    connection,
    ensure,
    workspaces,
    chats,
    schedules,
    createWorkspace,
    updateWorkspace,
    deleteWorkspace,
    createChat,
    closeChat,
    transcript,
    todo,
    observeContext,
    contextUsage,
    availableModels,
    availableSkills,
    switchModel,
    currentModel,
    modelSwitchRequest,
    live,
    history,
    previewHistory,
    navigateHistory,
    historyReplacing,
    send,
    abort,
    shake,
  };
};
